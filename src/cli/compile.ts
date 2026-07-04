import path from 'node:path';
import { promises as fs } from 'node:fs';
import chalk from 'chalk';
import { spinner as ora } from '../util/spinner.js';
import { confirm, editor, input, select } from '@inquirer/prompts';
import { loadConfigWithPath } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { reportRoleModelAdvice } from '../llm/role_advice.js';
import { ScoreStore } from '../llm/scores.js';
import { preflightProviders } from '../llm/preflight.js';
import { Workspace } from '../workspace/workspace.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import { Planner, buildPlan, type ClarificationCategory, type ClarifyQuestion, type PlannerInput } from '../agents/planner.js';
import { PlanSchema } from '../core/plan.js';
import { DOC_NAMES } from '../core/docs.js';
import { loadIncrementalBaseline, isIncrementalIntent } from '../core/incremental.js';
import { lintPlan } from '../core/lint.js';
import { refreshProjectMemory } from '../core/project_memory.js';
import { renderPlanMarkdown } from '../core/render.js';
import { savePlan } from '../core/storage.js';
import { updateProjectFile } from '../core/project_file.js';
import { AuditLogger } from '../audit/audit.js';
import { acquireLock, LockError } from '../core/lock.js';
import { setLocale, t } from '../i18n/index.js';
import type { Language, PlanIntent } from '../core/plan.js';
import { PluginHost } from '../plugins/host.js';
import type { XCompilerPlugin } from '../plugins/types.js';
import { hasXcEnv, xcEnv } from '../config/env.js';

export interface CompileOptions {
  workspace: string;
  configPath?: string;
  inputFile?: string;
  /**
   * 已澄清的 topic.md 直接输入：跳过 intake / clarify / Addenda / Gate 1，把该文件
   * 内容当作冻结后的项目选题书，直接进入 decompose。常用于：
   *   - 用户上次已澄清并保留了 topic.md，重新跑 decompose 不想再问一遍
   *   - 离线编辑了 topic.md 想直接拿来出 plan.json
   * 与 --input 互斥；同时给则 --topic 优先并打印警告。
   */
  topicFile?: string;
  outputFile?: string;
  intent?: PlanIntent;
  baselinePlanFile?: string;
  yes?: boolean;
  force?: boolean;
  /** Optional XXX.xc project file to create/update with config, plan, and progress. */
  projectFilePath?: string;
  /** Project-file history command label; defaults to build. */
  projectCommand?: string;
  /** 程序化插件入口；动态插件加载将在后续版本基于它实现。 */
  plugins?: XCompilerPlugin[];
  pluginStrict?: boolean;
}

/** CLI 可映射为退出码、程序化调用方可捕获并安全收尾的编译终止。 */
export class CompileExitError extends Error {
  constructor(public readonly exitCode: number, message: string) {
    super(message);
    this.name = 'CompileExitError';
  }
}

export function resolveCompileLanguage(
  configuredLanguage: Language,
  intent: PlanIntent,
  baseline: { language?: Language },
): Language {
  return isIncrementalIntent(intent) ? baseline.language ?? configuredLanguage : configuredLanguage;
}

export async function runCompile(opts: CompileOptions): Promise<{ planPath?: string }> {
  const ws = new Workspace(path.resolve(opts.workspace));
  const { config: cfg, path: cfgPath } = await loadConfigWithPath(opts.configPath);
  // Locale 必须在第一条输出之前生效，确保终端与审计文件从头到尾使用同一语言。
  if (!hasXcEnv('LANG')) setLocale(cfg.locale);
  console.log(chalk.green('✔'), t().compile.workspaceReady(ws.root));

  let lock;
  try {
    lock = await acquireLock(ws.root, 'xcompiler_build', { force: !!opts.force });
  } catch (err) {
    if (err instanceof LockError) {
      console.error(chalk.red('✖'), t().system.unhandledError(err.message));
      throw new CompileExitError(6, err.message);
    }
    throw err;
  }
  if (opts.force) {
    console.log(chalk.yellow('!'), t().compile.forceOverride);
  }

  let scoreStore: ScoreStore | undefined;
  try {
  const M = t();
  const audit = new AuditLogger({ root: ws.root, command: 'xcompiler_build' });
  await audit.start({
    workspace: ws.root,
    config: opts.configPath ?? '(default)',
    inputFile: opts.inputFile ?? '(stdin)',
    intent: opts.intent ?? 'greenfield',
    baselinePlanFile: opts.baselinePlanFile ?? '',
    yes: !!opts.yes,
    roles: cfg.llm.roles,
    default_provider: cfg.llm.default,
  });
  const pluginHost = new PluginHost({
    plugins: opts.plugins,
    strict: opts.pluginStrict,
    audit,
  });
  await pluginHost.initialize();
  if (opts.topicFile && opts.inputFile) {
    console.log(chalk.yellow('!'), M.compile.topicInputConflict);
  }
  const topicMode = !!opts.topicFile;
  const intent = opts.intent ?? 'greenfield';
  await pluginHost.emit('compile.start', { workspace: ws.root, intent, topicMode });
  scoreStore = new ScoreStore(cfgPath, cfg.llm.scores, audit);
  await scoreStore.load();
  let unavailableProviders = new Set<string>();
  try {
    const pf = await preflightProviders(cfg, scoreStore, audit);
    unavailableProviders = new Set(pf.unreachable);
    if (pf.zeroed.length > 0) {
      console.log(chalk.yellow('!'), t().execute.preflightModelMissing(pf.zeroed.join(', ')));
    }
    if (Object.keys(pf.autoAdded).length > 0) {
      console.log(chalk.yellow('!'), t().execute.preflightAutoAdded(Object.keys(pf.autoAdded).length));
    }
  } catch (err) {
    console.error(chalk.red('✖'), t().system.unhandledError((err as Error).message));
    await audit.end({ status: 'error', message: (err as Error).message, stage: 'llm-preflight' });
    await scoreStore.flush();
    throw new CompileExitError(7, (err as Error).message);
  }
  const router = new LLMRouter(cfg, audit, scoreStore, unavailableProviders, pluginHost);
  await reportRoleModelAdvice(router, audit);
  const baseline =
    isIncrementalIntent(intent)
      ? await loadIncrementalBaseline(ws, { planPath: opts.baselinePlanFile })
      : { summary: '', sources: [] };
  if (isIncrementalIntent(intent) && !baseline.summary) {
    const msg = M.compile.baselineMissing(ws.root);
    console.error(chalk.red('✖'), msg);
    await audit.end({ status: 'aborted', reason: 'incremental baseline missing', workspace: ws.root });
    throw new CompileExitError(8, msg);
  }
  if (baseline.summary) {
    console.log(chalk.green('✔'), M.compile.baselineLoaded(intent, baseline.sources.join(', ')));
  }
  const language = resolveCompileLanguage(cfg.agent.language, intent, baseline);
  if (
    isIncrementalIntent(intent) &&
    baseline.language &&
    baseline.language !== cfg.agent.language
  ) {
    console.log(
      chalk.yellow('!'),
      M.compile.baselineLanguageOverride(baseline.language, baseline.languageSource ?? 'baseline', cfg.agent.language),
    );
  }
  const planner = new Planner(router.for('Planner'), audit, language);

  const trace = (msg: string) => {
    if (xcEnv('TRACE') === '1') {
      process.stderr.write(t().audit.traceLine('xcompiler-trace', msg) + '\n');
    }
  };

  // 1. Intake — topic 模式下读取已有 topic.md 直接当作 raw
  let rawRequirement: string;
  if (topicMode) {
    trace('topic.read');
    rawRequirement = await fs.readFile(path.resolve(opts.topicFile!), 'utf8');
    if (!rawRequirement.trim()) {
      console.error(chalk.red(M.compile.topicEmptyExit));
      await audit.end({ status: 'aborted', reason: 'empty topic file' });
      throw new CompileExitError(1, M.compile.topicEmptyExit);
    }
    await audit.userInput(M.compile.auditTopicInput, rawRequirement);
    console.log(chalk.green('✔'), M.compile.topicLoaded(path.resolve(opts.topicFile!)));
  } else {
    trace('intake.start');
    rawRequirement = await intake(opts.inputFile);
    trace(`intake.done len=${rawRequirement.length}`);
    if (!rawRequirement.trim()) {
      console.error(chalk.red(M.compile.requirementEmptyExit));
      await audit.end({ status: 'aborted', reason: 'empty requirement' });
      throw new CompileExitError(1, M.compile.requirementEmptyExit);
    }
    trace('audit.userInput.intake');
    await audit.userInput(M.compile.auditOriginalRequirement, rawRequirement);
    trace('audit.userInput.intake.done');
  }

  // 2. Clarify — topic 模式跳过（topic.md 已经是冻结后的选题书）
  trace('clarify.section.enter');
  const clarifications: Array<{
    question: string;
    answer: string;
    category?: ClarificationCategory;
    why?: string;
  }> = [];
  let clarificationQuestions: ClarifyQuestion[] = [];
  trace(`clarify.section.flag yes=${opts.yes} topicMode=${topicMode}`);
  if (!opts.yes && !topicMode) {
    trace('ora.clarify.start');
    const spin = ora(M.compile.spinClarify, { animate: false }).start();
    trace('ora.clarify.started');
    try {
      trace('planner.clarify.call');
      clarificationQuestions = await planner.clarify(rawRequirement, {
        intent,
        hasBaseline: !!baseline.summary,
      });
      trace(`planner.clarify.return n=${clarificationQuestions.length}`);
      spin.succeed(M.compile.clarifySucceed(clarificationQuestions.length));
    } catch (err) {
      spin.fail(M.compile.clarifyFail);
      throw err;
    }
    for (const q of clarificationQuestions) {
      const ans = await input({ message: `${q.id} [${q.category}] ${q.question}\n  ↳ ${q.why}` });
      clarifications.push({ question: q.question, answer: ans, category: q.category, why: q.why });
      await audit.userInput(M.compile.auditClarifyAnswer(q.id, q.question), ans);
    }
  }

  // 2.5 用户自定义补充需求（预留位，可为空）— topic 模式下也跳过（topic.md 应已自含全部上下文）
  let userAddenda = '';
  if (!opts.yes && !topicMode) {
    const want = await confirm({
      message: M.compile.addendaConfirm,
      default: false,
    });
    if (want) {
      userAddenda = (
        await editor({
          message: M.compile.addendaEditorMsg,
          default: '',
          postfix: '.md',
        })
      ).trim();
      if (userAddenda) {
        await audit.userInput(M.compile.auditUserAddenda, userAddenda);
      }
    }
  }
  const clarifyContext = {
    rawRequirement,
    questions: clarificationQuestions,
    clarifications,
    userAddenda,
  };
  await pluginHost.emit('compile.afterClarify', clarifyContext);
  rawRequirement = clarifyContext.rawRequirement;
  clarificationQuestions = clarifyContext.questions;
  userAddenda = clarifyContext.userAddenda;

  // 3. Draft topic.md + 确认门 1
  //   topic.md 是“需求澄清后的项目选题书”，作为后续 V 模型拆解的唯一输入。
  //   topic 模式下：rawRequirement 就是用户传入的 topic.md 全文，直接落盘，不再 render/Gate 1。
  const draftDir = 'docs/.draft';
  const draftTopic = `${draftDir}/topic.md`;
  trace('ws.ensure.draftDir');
  await ws.ensure(draftDir);
  let topicMd: string;
  if (topicMode) {
    topicMd = rawRequirement;
    await ws.writeFile(draftTopic, topicMd);
  } else {
    trace('renderTopicDraft');
    topicMd = renderTopicDraft(rawRequirement, clarifications, userAddenda);
    trace('ws.writeFile.draftTopic');
    await ws.writeFile(draftTopic, topicMd);
    trace('ws.writeFile.draftTopic.done');

    if (!opts.yes) {
      console.log('\n' + chalk.cyan(M.compile.topicPreviewHeader));
      console.log(topicMd);
      console.log(chalk.cyan(M.compile.topicPreviewFooter));
      const decision = await select({
        message: M.compile.gate1Confirm,
        choices: [
          { name: M.compile.gate1ChoiceConfirm, value: 'confirm' },
          { name: M.compile.gate1ChoiceEdit, value: 'edit' },
          { name: M.compile.gate1ChoiceCancel, value: 'cancel' },
        ],
      });
      await audit.userDecision(M.compile.gate1AuditLabel, decision);
      if (decision === 'cancel') {
        await ws.remove(draftDir);
        console.log(chalk.yellow(M.compile.gate1Cancelled));
        await audit.end({ status: 'cancelled', gate: 1 });
        return {};
      }
      if (decision === 'edit') {
        const edited = await editor({ message: M.compile.editTopicMsg, default: topicMd, postfix: '.md' });
        await ws.writeFile(draftTopic, edited);
        await audit.userInput(M.compile.auditEditedTopic, edited);
      }
    }
  }

  // 3.5 立即把 topic.md 写到最终位置（docs/topic.md），不再等到第 7 步。
  //   这样即使后续 decompose / lint 失败，已澄清的 topic 仍然落盘，
  //   下次可用 `xcompiler build --topic docs/topic.md` 直接重跑而不必再澄清一次。
  trace('ws.readFile.finalTopic');
  const finalTopicMd = await ws.readFile(draftTopic);
  await archiveIfExists(ws, DOC_NAMES.topic, audit);
  await ws.writeFile(DOC_NAMES.topic, finalTopicMd);
  await audit.event('topic.persist', M.compile.auditTopicPersisted(ws.abs(DOC_NAMES.topic)), {
    messageId: 'compile.topic_persisted',
    topicPath: ws.abs(DOC_NAMES.topic),
    mode: topicMode ? 'topic-input' : 'clarified',
  });
  console.log(chalk.green('✔'), M.compile.topicWritten(ws.abs(DOC_NAMES.topic)));

  // 4. Decompose — with topic.md as the V-model input
  trace('ora.spin2.start');
  const spin2 = ora(M.compile.spinDecompose, { animate: false }).start();
  trace('ora.spin2.started');
  let draft;
  try {
    const plannerInput: PlannerInput = {
      rawRequirement: finalTopicMd,
      clarifications,
      userAddenda,
      baselineContext: baseline.summary,
      intent,
    };
    const decomposeContext = { input: plannerInput };
    await pluginHost.emit('compile.beforeDecompose', decomposeContext);
    draft = await planner.decompose(decomposeContext.input);
  } catch (err) {
    spin2.fail(M.compile.decomposeFail);
    const msg = (err as Error).message ?? String(err);
    console.error(chalk.red(M.compile.plannerInvalidPlan), msg);
    console.error(chalk.gray(M.compile.plannerInvalidPlanHint1));
    console.error(chalk.gray(M.compile.plannerInvalidPlanHint2));
    await audit.event('llm.error', M.compile.auditDecomposeFailed, {
      messageId: 'compile.decompose_failed', stage: 'decompose', error: msg,
    });
    await audit.end({ status: 'error', stage: 'decompose', error: msg });
    throw new CompileExitError(4, msg);
  }
  spin2.succeed(M.compile.decomposeSucceed(draft.steps.length));

  // 5. 构建并校验 plan
  let plan = buildPlan(draft, {
    userAddenda,
    language,
    intent,
    baselineSummary: baseline.summary,
  });
  const planContext = { plan };
  await pluginHost.emit('compile.afterPlan', planContext);
  plan = planContext.plan;
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    console.error(chalk.red(M.compile.schemaFail));
    console.error(parsed.error.format());
    await ws.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    console.error(chalk.gray(M.compile.schemaInvalidSavedAt(ws.abs(`${draftDir}/plan.invalid.json`))));
    throw new CompileExitError(2, M.compile.schemaFail);
  }
  const issues = lintPlan(parsed.data).filter((i) => i.level === 'error');
  if (issues.length > 0) {
    console.error(chalk.red(M.compile.lintFail(issues.length)));
    for (const i of issues) console.error(M.compile.lintIssue(i.stepId ?? '*', i.message));
    // 落到 draft 便于排查
    await ws.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    throw new CompileExitError(3, M.compile.lintFail(issues.length));
  }

  const planMd = renderPlanMarkdown(parsed.data);
  await ws.writeFile(`${draftDir}/plan.md`, planMd);

  // 6. 确认门 2
  if (!opts.yes) {
    console.log('\n' + chalk.cyan(M.compile.planPreviewHeader));
    console.log(planMd.split('\n').slice(0, 60).join('\n'));
    if (planMd.split('\n').length > 60) console.log(chalk.gray(M.compile.planPreviewTruncated));
    console.log(chalk.cyan(M.compile.planPreviewFooter));
    const ok = await confirm({
      message: M.compile.gate2Confirm,
      default: false,
    });
    await audit.userDecision(M.compile.gate2AuditLabel, ok ? 'confirm' : 'reject');
    if (!ok) {
      await ws.remove(draftDir);
      console.log(chalk.yellow(M.compile.gate2Rejected));
      await audit.end({ status: 'rejected', gate: 2 });
      return {};
    }
  }

  // 7. Persist
  const planPath = opts.outputFile
    ? path.resolve(opts.outputFile)
    : ws.abs('plan.json');
  await savePlan(planPath, parsed.data);
  // 归档上一版本（如有），再写入新版本。topic.md 已在第 3.5 步落盘，这里只处理 plan.
  await archiveIfExists(ws, DOC_NAMES.plan, audit);
  await ws.writeFile(DOC_NAMES.plan, planMd);
  await refreshProjectMemory(ws, {
    planPath,
    language: parsed.data.language,
    intent: parsed.data.intent,
  });
  await ws.remove(draftDir);
  await audit.event('plan.persist', M.compile.auditPlanPersisted(planPath), {
    messageId: 'compile.plan_persisted',
    planPath,
    steps: parsed.data.steps.length,
  });
  const projectFile = await updateProjectFile({
    workspace: ws.root,
    planPath,
    configPath: cfgPath,
    projectFilePath: opts.projectFilePath,
    command: opts.projectCommand ?? 'build',
    intent,
    plan: parsed.data,
    requirementFile: opts.inputFile,
    topicFile: opts.topicFile,
    recordHistory: true,
  });

  console.log(chalk.green('✔'), M.compile.planWritten(planPath));
  console.log(chalk.green('✔'), M.compile.projectFileWritten(projectFile));
  console.log(M.compile.nextCommand(chalk.cyan(`xcompiler run ${path.relative(process.cwd(), planPath)}`)));
  await pluginHost.emit('compile.finish', { plan: parsed.data, planPath });
  await audit.end({ status: 'ok', planPath, steps: parsed.data.steps.length });
  return { planPath };
  } finally {
    try { await scoreStore?.flush(); } catch { /* never block release */ }
    await lock.release();
  }
}

async function intake(inputFile?: string): Promise<string> {
  if (inputFile) {
    return fs.readFile(path.resolve(inputFile), 'utf8');
  }
  console.log(chalk.gray(t().compile.requirementInputHint));
  return readMultiline();
}

async function readMultiline(): Promise<string> {
  // 避开 node:readline —— 在 pkg 打包下 TTY 场景下 readline 的 native cleanup
  // 会在 rl.close() 后下一个 tick 触发 SIGSEGV。改为手工读取 stdin chunk。
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim() === '') {
          process.stdin.removeListener('data', onData);
          process.stdin.removeListener('end', onEnd);
          try { process.stdin.pause(); } catch { /* stdin already closed */ }
          resolve(lines.join('\n'));
          return;
        }
        lines.push(line);
      }
    };
    const onEnd = () => {
      if (buf.trim()) lines.push(buf.replace(/\r$/, ''));
      process.stdin.removeListener('data', onData);
      try { process.stdin.pause(); } catch { /* stdin already closed */ }
      resolve(lines.join('\n'));
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    try { process.stdin.resume(); } catch { /* stdin is not resumable */ }
  });
}

function renderTopicDraft(
  raw: string,
  qa: Array<{
    question: string;
    answer: string;
    category?: ClarificationCategory;
    why?: string;
  }>,
  addenda: string = '',
): string {
  const M = t().compile;
  const lines: string[] = [];
  lines.push(M.topicTitle);
  lines.push('');
  lines.push(M.topicPreamble);
  lines.push('');
  lines.push(M.topicSecRequirement);
  lines.push('');
  lines.push(raw.trim());
  lines.push('');
  if (qa.length > 0) {
    lines.push(M.topicSecClarify);
    lines.push('');
    for (const [i, c] of qa.entries()) {
      lines.push(`- **Q${i + 1}${c.category ? ` · ${c.category}` : ''}** ${c.question}`);
      if (c.why) lines.push(`  - **Why** ${c.why}`);
      lines.push(`  - **A** ${c.answer}`);
    }
    lines.push('');
  }
  const trimmed = addenda.trim();
  if (trimmed) {
    lines.push(M.topicSecAddenda);
    lines.push('');
    lines.push(trimmed);
    lines.push('');
  }
  return lines.join('\n');
}
