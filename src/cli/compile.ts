import path from 'node:path';
import { promises as fs } from 'node:fs';
import chalk from 'chalk';
import { spinner as ora } from '../util/spinner.js';
import { confirm, editor, input, select } from '@inquirer/prompts';
import { loadConfig } from '../config/config.js';
import { LLMRouter } from '../llm/router.js';
import { Workspace } from '../workspace/workspace.js';
import { archiveIfExists } from '../workspace/doc_archive.js';
import { Planner, buildPlan } from '../agents/planner.js';
import { PlanSchema } from '../core/plan.js';
import { DOC_NAMES } from '../core/docs.js';
import { lintPlan } from '../core/lint.js';
import { renderPlanMarkdown } from '../core/render.js';
import { savePlan } from '../core/storage.js';
import { AuditLogger } from '../audit/audit.js';
import { acquireLock, LockError } from '../core/lock.js';

export interface CompileOptions {
  workspace: string;
  configPath?: string;
  inputFile?: string;
  outputFile?: string;
  yes?: boolean;
  force?: boolean;
}

export async function runCompile(opts: CompileOptions): Promise<void> {
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
    console.log(chalk.yellow('!'), '--force：强制重新生成 plan，已占用锁会被覆写。');
  }

  try {
  const cfg = await loadConfig(opts.configPath);
  const audit = new AuditLogger({ root: ws.root, command: 'toaa_c' });
  await audit.start({
    workspace: ws.root,
    config: opts.configPath ?? '(default)',
    inputFile: opts.inputFile ?? '(stdin)',
    yes: !!opts.yes,
    roles: cfg.llm.roles,
    default_provider: cfg.llm.default,
  });
  const router = new LLMRouter(cfg, audit);
  const planner = new Planner(router.for('Planner'), audit);

  const trace = (msg: string) => {
    if (process.env.TOAA_TRACE === '1') process.stderr.write(`[toaa-trace] ${msg}\n`);
  };

  // 1. Intake
  trace('intake.start');
  const rawRequirement = await intake(opts.inputFile);
  trace(`intake.done len=${rawRequirement.length}`);
  if (!rawRequirement.trim()) {
    console.error(chalk.red('需求为空，已退出。'));
    await audit.end({ status: 'aborted', reason: 'empty requirement' });
    process.exit(1);
  }
  trace('audit.userInput.intake');
  await audit.userInput('原始需求 (Intake)', rawRequirement);
  trace('audit.userInput.intake.done');

  // 2. Clarify
  trace('clarify.section.enter');
  const clarifications: Array<{ question: string; answer: string }> = [];
  trace(`clarify.section.flag yes=${opts.yes}`);
  if (!opts.yes) {
    trace('ora.clarify.start');
    const spin = ora('Planner 正在澄清需求…').start();
    trace('ora.clarify.started');
    let questions: Awaited<ReturnType<Planner['clarify']>> = [];
    try {
      trace('planner.clarify.call');
      questions = await planner.clarify(rawRequirement);
      trace(`planner.clarify.return n=${questions.length}`);
      spin.succeed(`澄清问题：${questions.length} 条`);
    } catch (err) {
      spin.fail('澄清失败');
      throw err;
    }
    for (const q of questions) {
      const ans = await input({ message: `${q.id} ${q.question}` });
      clarifications.push({ question: q.question, answer: ans });
      await audit.userInput(`澄清回答 ${q.id}: ${q.question}`, ans);
    }
  }

  // 2.5 用户自定义补充需求（预留位，可为空）
  let userAddenda = '';
  if (!opts.yes) {
    const want = await confirm({
      message: '是否有补充需求要追加？（会连同澄清一起发给 Planner，并保留在 plan.userAddenda 字段）',
      default: false,
    });
    if (want) {
      userAddenda = (
        await editor({
          message: '输入自定义补充需求（多行、Markdown 可）',
          default: '',
          postfix: '.md',
        })
      ).trim();
      if (userAddenda) {
        await audit.userInput('用户补充需求 (Addenda)', userAddenda);
      }
    }
  }

  // 3. Draft topic.md + 确认门 1
  //   topic.md 是“需求澄清后的项目选题书”，作为后续 V 模型拆解的唯一输入。
  const draftDir = 'docs/.draft';
  const draftTopic = `${draftDir}/topic.md`;
  trace('ws.ensure.draftDir');
  await ws.ensure(draftDir);
  trace('renderTopicDraft');
  const topicMd = renderTopicDraft(rawRequirement, clarifications, userAddenda);
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
    await audit.userDecision('需求确认门 (Gate 1)', decision);
    if (decision === 'cancel') {
      await ws.remove(draftDir);
      console.log(chalk.yellow('已取消，未写入任何文件。'));
      await audit.end({ status: 'cancelled', gate: 1 });
      return;
    }
    if (decision === 'edit') {
      const edited = await editor({ message: '编辑 topic.md', default: topicMd, postfix: '.md' });
      await ws.writeFile(draftTopic, edited);
      await audit.userInput('编辑后的 topic.md', edited);
    }
  }

  // 4. Decompose — 以 topic.md 作为 V 模型输入
  trace('ws.readFile.finalTopic');
  const finalTopicMd = await ws.readFile(draftTopic);
  trace('ora.spin2.start');
  const spin2 = ora('Planner 正在按 V 模型拆解…').start();
  trace('ora.spin2.started');
  let draft;
  try {
    draft = await planner.decompose({
      rawRequirement: finalTopicMd,
      clarifications,
      userAddenda,
    });
  } catch (err) {
    spin2.fail('Planner 拆解失败');
    const msg = (err as Error).message ?? String(err);
    console.error(chalk.red('Planner 无法生成有效 plan：'), msg);
    console.error(chalk.gray('  常见原因：所有 LLM provider 都返回了非法/截断 JSON（如 token loop）。'));
    console.error(chalk.gray('  排查：检查 .toaa/audit.jsonl 中的 llm.error / planner.thought 原文。'));
    await audit.event('llm.error', 'planner.decompose failed', { stage: 'decompose', error: msg });
    await audit.end({ status: 'error', stage: 'decompose', error: msg });
    process.exit(4);
  }
  spin2.succeed(`已生成 ${draft.steps.length} 个 Step`);

  // 5. 构建并校验 plan
  const plan = buildPlan(draft, { userAddenda });
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    console.error(chalk.red('Plan schema 校验失败：'));
    console.error(parsed.error.format());
    await ws.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    console.error(chalk.gray(`  完整 plan 已落盘：${ws.abs(`${draftDir}/plan.invalid.json`)}`));
    process.exit(2);
  }
  const issues = lintPlan(parsed.data).filter((i) => i.level === 'error');
  if (issues.length > 0) {
    console.error(chalk.red(`Plan lint 失败（${issues.length}）：`));
    for (const i of issues) console.error(` - [${i.stepId ?? '*'}] ${i.message}`);
    // 落到 draft 便于排查
    await ws.writeFile(`${draftDir}/plan.invalid.json`, JSON.stringify(plan, null, 2));
    process.exit(3);
  }

  const planMd = renderPlanMarkdown(parsed.data);
  await ws.writeFile(`${draftDir}/plan.md`, planMd);

  // 6. 确认门 2
  if (!opts.yes) {
    console.log('\n' + chalk.cyan('─── plan.md (preview) ───'));
    console.log(planMd.split('\n').slice(0, 60).join('\n'));
    if (planMd.split('\n').length > 60) console.log(chalk.gray('… (截断，详见 docs/plan.md)'));
    console.log(chalk.cyan('─────────────────────────'));
    const ok = await confirm({
      message: '是否确认该计划? (此为最终确认，确认后将写入 plan.json)',
      default: false,
    });
    await audit.userDecision('计划确认门 (Gate 2)', ok ? 'confirm' : 'reject');
    if (!ok) {
      await ws.remove(draftDir);
      console.log(chalk.yellow('未确认，已放弃。plan.json 未写入。'));
      await audit.end({ status: 'rejected', gate: 2 });
      return;
    }
  }

  // 7. Persist
  const planPath = opts.outputFile
    ? path.resolve(opts.outputFile)
    : ws.abs('plan.json');
  await savePlan(planPath, parsed.data);
  // 归档上一版本（如有），再写入新版本
  await archiveIfExists(ws, DOC_NAMES.plan, audit);
  await archiveIfExists(ws, DOC_NAMES.topic, audit);
  await ws.writeFile(DOC_NAMES.plan, planMd);
  await ws.writeFile(DOC_NAMES.topic, finalTopicMd);
  await ws.remove(draftDir);
  await audit.event('plan.persist', `plan.json written: ${planPath}`, {
    planPath,
    steps: parsed.data.steps.length,
  });

  console.log(chalk.green('✔'), '已写入', planPath);
  console.log('  下一步：', chalk.cyan(`toaa run ${path.relative(process.cwd(), planPath)}`));
  await audit.end({ status: 'ok', planPath, steps: parsed.data.steps.length });
  } finally {
    await lock.release();
  }
}

async function intake(inputFile?: string): Promise<string> {
  if (inputFile) {
    return fs.readFile(path.resolve(inputFile), 'utf8');
  }
  console.log(chalk.gray('请描述你的需求（多行，输入空行结束）:'));
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
  const lines: string[] = [];
  lines.push('# Project Topic (项目选题)');
  lines.push('');
  lines.push('> 本文件是需求澄清后冻结的项目选题，后续 V 模型拆解与所有阶段产出皆以本文件为唯一需求输入。');
  lines.push('');
  lines.push('## 原始需求');
  lines.push('');
  lines.push(raw.trim());
  lines.push('');
  if (qa.length > 0) {
    lines.push('## 澄清记录');
    lines.push('');
    for (const [i, c] of qa.entries()) {
      lines.push(`- **Q${i + 1}** ${c.question}`);
      lines.push(`  - **A** ${c.answer}`);
    }
    lines.push('');
  }
  const trimmed = addenda.trim();
  if (trimmed) {
    lines.push('## 用户补充需求 (Addenda)');
    lines.push('');
    lines.push(trimmed);
    lines.push('');
  }
  return lines.join('\n');
}
