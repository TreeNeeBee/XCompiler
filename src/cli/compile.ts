import path from 'node:path';
import { promises as fs } from 'node:fs';
import chalk from 'chalk';
import { spinner as ora } from '../util/spinner.js';
import { confirm, editor, input, select } from '@inquirer/prompts';
import { loadConfigWithPath } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { ScoreStore } from '../llm/scores.js';
import { preflightProviders } from '../llm/preflight.js';
import { Workspace } from '../workspace/workspace.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import { Planner, buildPlan } from '../agents/planner.js';
import { PlanSchema } from '../core/plan.js';
import { DOC_NAMES } from '../core/docs.js';
import { loadIncrementalBaseline, isIncrementalIntent } from '../core/incremental.js';
import { lintPlan } from '../core/lint.js';
import { refreshProjectMemory } from '../core/project_memory.js';
import { renderPlanMarkdown } from '../core/render.js';
import { savePlan } from '../core/storage.js';
import { AuditLogger } from '../audit/audit.js';
import { acquireLock, LockError } from '../core/lock.js';
import { setLocale, t } from '../i18n/index.js';
import type { Language, PlanIntent } from '../core/plan.js';

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
  console.log(chalk.green('✔'), 'Workspace:', ws.root);

  let lock;
  try {
    lock = await acquireLock(ws.root, 'toaa_c', { force: !!opts.force });
  } catch (err) {
    if (err instanceof LockError) {
      console.error(chalk.red('✖'), err.message);
      process.exit(6);
    }
    throw err;
  }
  if (opts.force) {
    console.log(chalk.yellow('!'), '--force: overriding workspace lock and regenerating plan.');
  }

  let scoreStore: ScoreStore | undefined;
  try {
  const { config: cfg, path: cfgPath } = await loadConfigWithPath(opts.configPath);
  // Honour config-side locale unless an explicit --lang was already set
  // (CLI flag is applied by the parent Commander preAction before runCompile is called).
  if (!process.env.TOAA_LANG) setLocale(cfg.locale);
  const M = t();
  const audit = new AuditLogger({ root: ws.root, command: 'toaa_c' });
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
  if (opts.topicFile && opts.inputFile) {
    console.log(chalk.yellow('!'), '--topic and --input were both supplied; --topic wins, --input is ignored.');
  }
  const topicMode = !!opts.topicFile;
  const intent = opts.intent ?? 'greenfield';
  scoreStore = new ScoreStore(cfgPath, cfg.llm.scores, audit);
  await scoreStore.load();
  try {
    const pf = await preflightProviders(cfg, scoreStore, audit);
    if (pf.zeroed.length > 0) {
      console.log(chalk.yellow('!'), t().execute.preflightModelMissing(pf.zeroed.join(', ')));
    }
    if (Object.keys(pf.autoAdded).length > 0) {
      console.log(chalk.yellow('!'), t().execute.preflightAutoAdded(Object.keys(pf.autoAdded).length));
    }
  } catch (err) {
    console.error(chalk.red('✖'), (err as Error).message);
    await audit.end({ status: 'error', message: (err as Error).message, stage: 'llm-preflight' });
    await scoreStore.flush();
    process.exit(7);
  }
  const router = new LLMRouter(cfg, audit, scoreStore);
  const baseline =
    isIncrementalIntent(intent)
      ? await loadIncrementalBaseline(ws, { planPath: opts.baselinePlanFile })
      : { summary: '', sources: [] };
  if (isIncrementalIntent(intent) && !baseline.summary) {
    const msg = M.compile.baselineMissing(ws.root);
    console.error(chalk.red('✖'), msg);
    await audit.end({ status: 'aborted', reason: 'incremental baseline missing', workspace: ws.root });
    process.exit(8);
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
    if (process.env.TOAA_TRACE === '1') process.stderr.write(`[toaa-trace] ${msg}\n`);
  };

  // 1. Intake — topic 模式下读取已有 topic.md 直接当作 raw
  let rawRequirement: string;
  if (topicMode) {
    trace('topic.read');
    rawRequirement = await fs.readFile(path.resolve(opts.topicFile!), 'utf8');
    if (!rawRequirement.trim()) {
      console.error(chalk.red(M.compile.topicEmptyExit));
      await audit.end({ status: 'aborted', reason: 'empty topic file' });
      process.exit(1);
    }
    await audit.userInput('topic.md (--topic)', rawRequirement);
    console.log(chalk.green('✔'), M.compile.topicLoaded(path.resolve(opts.topicFile!)));
  } else {
    trace('intake.start');
    rawRequirement = await intake(opts.inputFile);
    trace(`intake.done len=${rawRequirement.length}`);
    if (!rawRequirement.trim()) {
      console.error(chalk.red(M.compile.requirementEmptyExit));
      await audit.end({ status: 'aborted', reason: 'empty requirement' });
      process.exit(1);
    }
    trace('audit.userInput.intake');
    await audit.userInput('Original requirement (Intake)', rawRequirement);
    trace('audit.userInput.intake.done');
  }

  // 2. Clarify — topic 模式跳过（topic.md 已经是冻结后的选题书）
  trace('clarify.section.enter');
  const clarifications: Array<{ question: string; answer: string }> = [];
  trace(`clarify.section.flag yes=${opts.yes} topicMode=${topicMode}`);
  if (!opts.yes && !topicMode) {
    trace('ora.clarify.start');
    const spin = ora(M.compile.spinClarify).start();
    trace('ora.clarify.started');
    let questions: Awaited<ReturnType<Planner['clarify']>> = [];
    try {
      trace('planner.clarify.call');
      questions = await planner.clarify(rawRequirement, {
        intent,
        hasBaseline: !!baseline.summary,
      });
      trace(`planner.clarify.return n=${questions.length}`);
      spin.succeed(M.compile.clarifySucceed(questions.length));
    } catch (err) {
      spin.fail(M.compile.clarifyFail);
      throw err;
    }
    for (const q of questions) {
      const ans = await input({ message: `${q.id} ${q.question}` });
      clarifications.push({ question: q.question, answer: ans });
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
        await audit.userInput('User addenda', userAddenda);
      }
    }
  }

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
      console.log('\n' + chalk.cyan('─── topic.md (preview) ───'));
      console.log(topicMd);
      console.log(chalk.cyan('──────────────────────────────'));
      const decision = await select({
        message: '需求是否符合预期?',
        choices: [
          { name: '✅ confirm — 进入计划生成', value: 'confirm' },
          { name: '✏️  edit    — 打开编辑器修改', value: 'edit' },
          { name: '❌ cancel  — 放弃本次会话', value: 'cancel' },
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
        await audit.userInput('Edited topic.md', edited);
      }
    }
  }

  // 3.5 立即把 topic.md 写到最终位置（docs/topic.md），不再等到第 7 步。
  //   这样即使后续 decompose / lint 失败，已澄清的 topic 仍然落盘，
  //   下次可用 `toaa c --topic docs/topic.md` 直接重跑而不必再澄清一次。
  trace('ws.readFile.finalTopic');
  const finalTopicMd = await ws.readFile(draftTopic);
  await archiveIfExists(ws, DOC_NAMES.topic, audit);
  await ws.writeFile(DOC_NAMES.topic, finalTopicMd);
  await audit.event('topic.persist', `topic.md written: ${ws.abs(DOC_NAMES.topic)}`, {
    topicPath: ws.abs(DOC_NAMES.topic),
    mode: topicMode ? 'topic-input' : 'clarified',
  });
  console.log(chalk.green('✔'), M.compile.topicWritten(ws.abs(DOC_NAMES.topic)));

  // 4. Decompose — with topic.md as the V-model input
  trace('ora.spin2.start');
  const spin2 = ora(M.compile.spinDecompose).start();
  trace('ora.spin2.started');
  let draft;
  try {
    draft = await planner.decompose({
      rawRequirement: finalTopicMd,
      clarifications,
      userAddenda,
      baselineContext: baseline.summary,
      intent,
    });
  } catch (err) {
    spin2.fail(M.compile.decomposeFail);
    const msg = (err as Error).message ?? String(err);
    console.error(chalk.red(M.compile.plannerInvalidPlan), msg);
    console.error(chalk.gray(M.compile.plannerInvalidPlanHint1));
    console.error(chalk.gray(M.compile.plannerInvalidPlanHint2));
    await audit.event('llm.error', 'planner.decompose failed', { stage: 'decompose', error: msg });
    await audit.end({ status: 'error', stage: 'decompose', error: msg });
    process.exit(4);
  }
  spin2.succeed(M.compile.decomposeSucceed(draft.steps.length));

  // 5. 构建并校验 plan
  const plan = buildPlan(draft, {
    userAddenda,
    language,
    intent,
    baselineSummary: baseline.summary,
  });
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    console.error(chalk.red(M.compile.schemaFail));
    console.error(parsed.error.format());
    await ws.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    console.error(chalk.gray(M.compile.schemaInvalidSavedAt(ws.abs(`${draftDir}/plan.invalid.json`))));
    process.exit(2);
  }
  const issues = lintPlan(parsed.data).filter((i) => i.level === 'error');
  if (issues.length > 0) {
    console.error(chalk.red(M.compile.lintFail(issues.length)));
    for (const i of issues) console.error(` - [${i.stepId ?? '*'}] ${i.message}`);
    // 落到 draft 便于排查
    await ws.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    process.exit(3);
  }

  const planMd = renderPlanMarkdown(parsed.data);
  await ws.writeFile(`${draftDir}/plan.md`, planMd);

  // 6. 确认门 2
  if (!opts.yes) {
    console.log('\n' + chalk.cyan(M.compile.planPreviewHeader));
    console.log(planMd.split('\n').slice(0, 60).join('\n'));
    if (planMd.split('\n').length > 60) console.log(chalk.gray('… (truncated; see docs/plan.md)'));
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
  await audit.event('plan.persist', `plan.json written: ${planPath}`, {
    planPath,
    steps: parsed.data.steps.length,
  });

  console.log(chalk.green('✔'), M.compile.planWritten(planPath));
  console.log('  Next:', chalk.cyan(`toaa run ${path.relative(process.cwd(), planPath)}`));
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
          try { process.stdin.pause(); } catch {}
          resolve(lines.join('\n'));
          return;
        }
        lines.push(line);
      }
    };
    const onEnd = () => {
      if (buf.trim()) lines.push(buf.replace(/\r$/, ''));
      process.stdin.removeListener('data', onData);
      try { process.stdin.pause(); } catch {}
      resolve(lines.join('\n'));
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    try { process.stdin.resume(); } catch {}
  });
}

function renderTopicDraft(
  raw: string,
  qa: Array<{ question: string; answer: string }>,
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
      lines.push(`- **Q${i + 1}** ${c.question}`);
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
