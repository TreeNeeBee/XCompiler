import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import type { Sandbox } from '../sandbox/types.js';
import type { Language } from './plan.js';
import {
  autoFixSrcImports,
  ensurePyTestBootstrap,
  probeEntrypoint,
  type EntrypointProbe,
} from './entry_gate.js';
import { t } from '../i18n/index.js';

/**
 * LanguageProfile：把"某种目标语言的工程化知识"集中到一处，
 * 让 sandbox / engine / lint / render / planner / executor 等都通过 profile 取用，
 * 而不是在各处硬编码 Python 的 venv / pip / pytest / requirements.txt 假设。
 *
 * 默认语言仍是 Python（完全向后兼容）；TypeScript 作为新 profile 接入。
 */
export interface LanguageProfile {
  readonly id: Language;
  readonly displayName: string;

  /** 依赖清单文件（相对 workspace 根）。python: requirements.txt；ts: package.json */
  readonly manifestFile: string;

  /** 源码/测试文件扩展名，用于 lint 阶段纯度检查与入口探测。 */
  readonly codeExtensions: string[];

  /**
   * 是否由 runtime（cli/execute）根据 plan.dependencies 生成 manifest。
   *  - Python：true —— 渲染器把依赖写入 requirements.txt，ARCH 不得直接产出该文件。
   *  - TypeScript：false —— package.json 由 ARCH 步骤撰写（含 scripts / devDependencies）。
   */
  readonly seedManifestFromDeps: boolean;

  /** 默认 Docker 镜像。 */
  readonly defaultDockerImage: string;

  /** 把依赖列表渲染为 manifest 文件内容（仅当 seedManifestFromDeps=true 时使用）。 */
  renderManifest(deps: string[]): string;

  /** 给 lint S004/S005 提示用：依据 CODE Step 的源码输出推导建议测试文件路径。 */
  testFileFor(srcOutput: string | undefined, stepId: string): string;

  /** 追加到 Planner system prompt 末尾的语言专属覆盖块（python 为空串）。 */
  readonly plannerPromptOverride: string;
  /** 追加到 Executor system prompt 末尾的语言专属覆盖块（python 为空串）。 */
  readonly executorPromptOverride: string;

  /** TEST/DEBUG 前置：确保测试可解析到源码（python 写 conftest.py；ts 无需）。 */
  ensureTestBootstrap?(ws: Workspace, audit: AuditLogger): Promise<void>;
  /** 通用兜底：修复入口 import 路径问题（python sys.path；ts 无需）。 */
  autoFixImports?(ws: Workspace, audit: AuditLogger): Promise<string[]>;
  /** DELIVERY gate：探测入口 `--help` 是否开箱即用；缺失入口必须返回失败。 */
  probeEntry(ws: Workspace, sandbox: Sandbox): Promise<EntrypointProbe>;
}

const PY_TEST_RE = /\.py$/;

const pythonProfile: LanguageProfile = {
  id: 'python',
  displayName: 'Python',
  manifestFile: 'requirements.txt',
  codeExtensions: ['.py'],
  seedManifestFromDeps: true,
  defaultDockerImage: 'python:3.11-slim',
  renderManifest(deps) {
    return [...new Set(deps.map((d) => d.trim()).filter(Boolean))].sort().join('\n') + '\n';
  },
  testFileFor(srcOutput, stepId) {
    if (srcOutput && srcOutput.startsWith('src/') && PY_TEST_RE.test(srcOutput)) {
      const base = srcOutput.replace(/^src\//, '').replace(/\.py$/, '').replace(/\//g, '_');
      return `tests/test_${base}.py`;
    }
    return `tests/test_${stepId.toLowerCase()}.py`;
  },
  plannerPromptOverride: '',
  executorPromptOverride: '',
  async ensureTestBootstrap(ws, audit) {
    await ensurePyTestBootstrap(ws, audit);
  },
  async autoFixImports(ws, audit) {
    return autoFixSrcImports(ws, audit);
  },
  async probeEntry(ws, sandbox) {
    return probeEntrypoint(ws, sandbox);
  },
};

const typescriptProfile: LanguageProfile = {
  id: 'typescript',
  displayName: 'TypeScript',
  manifestFile: 'package.json',
  codeExtensions: ['.ts', '.tsx'],
  seedManifestFromDeps: false,
  defaultDockerImage: 'node:20-slim',
  renderManifest(deps) {
    const pkg = {
      name: 'app',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: { test: 'vitest run', start: 'tsx src/main.ts' },
      dependencies: Object.fromEntries(
        [...new Set(deps.map((d) => d.trim()).filter(Boolean))].sort().map((d) => [d, '*']),
      ),
      devDependencies: {
        vitest: '*',
        typescript: '*',
        tsx: '*',
        '@types/node': '*',
      },
    };
    return JSON.stringify(pkg, null, 2) + '\n';
  },
  testFileFor(srcOutput, stepId) {
    if (srcOutput && srcOutput.startsWith('src/') && /\.tsx?$/.test(srcOutput)) {
      const base = srcOutput.replace(/^src\//, '').replace(/\.tsx?$/, '').replace(/\//g, '_');
      return `tests/${base}.test.ts`;
    }
    return `tests/${stepId.toLowerCase()}.test.ts`;
  },
  plannerPromptOverride: '',
  executorPromptOverride: '',
  async probeEntry(ws, sandbox) {
    return probeTsEntrypoint(ws, sandbox);
  },
};

const PROFILES: Record<Language, LanguageProfile> = {
  python: pythonProfile,
  typescript: typescriptProfile,
};

export function getLanguageProfile(language: Language): LanguageProfile {
  return PROFILES[language] ?? pythonProfile;
}

/** DELIVERY gate（TypeScript）：尝试 `npx tsx src/main.ts --help`，确保入口开箱即用。 */
async function probeTsEntrypoint(
  ws: Workspace,
  sandbox: Sandbox,
): Promise<EntrypointProbe> {
  const tail = (s: string): string => s.split('\n').slice(-30).join('\n');
  const entry = await detectTsEntrypoint(ws);
  if (!entry) {
    return {
      ok: false,
      command: 'npm run start -- --help',
      exitCode: -1,
      timedOut: false,
      stdoutTail: '',
      stderrTail: t().engine.missingTypeScriptEntrypoint,
    };
  }
  let r;
  try {
    r = await runTsEntryProbe(entry, sandbox);
  } catch (err) {
    return {
      ok: false,
      command: entry.command,
      exitCode: -1,
      timedOut: false,
      stdoutTail: '',
      stderrTail: (err as Error).message,
    };
  }
  const ok = r.exitCode === 0 && !r.timedOut;
  return {
    ok,
    command: entry.command,
    exitCode: r.exitCode,
    timedOut: r.timedOut ?? false,
    stdoutTail: tail(r.stdout),
    stderrTail: tail(r.stderr),
  };
}

async function detectTsEntrypoint(
  ws: Workspace,
): Promise<
  | { type: 'start-script'; command: string }
  | { type: 'run-program'; entry: string; command: string }
  | { type: 'exec'; cmd: string; argv: string[]; command: string }
  | null
> {
  const pkg = await readJsonFile<Record<string, unknown>>(ws, 'package.json');
  const scripts =
    pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  if (typeof scripts.start === 'string' && scripts.start.trim()) {
    return { type: 'start-script', command: 'npm run --silent start -- --help' };
  }

  const binValue = pkg?.bin;
  if (typeof binValue === 'string' && binValue.trim()) {
    return toTsBinProbe(binValue);
  }
  if (binValue && typeof binValue === 'object' && !Array.isArray(binValue)) {
    const firstBin = Object.values(binValue as Record<string, unknown>).find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    if (firstBin) return toTsBinProbe(firstBin);
  }

  const mainValue = typeof pkg?.main === 'string' ? pkg.main.trim() : '';
  if (mainValue && (mainValue.endsWith('.ts') || mainValue.endsWith('.tsx') || mainValue.endsWith('.js'))) {
    return mainValue.endsWith('.js')
      ? { type: 'exec', cmd: 'node', argv: [mainValue, '--help'], command: `node ${mainValue} --help` }
      : { type: 'run-program', entry: mainValue, command: `npx tsx ${mainValue} --help` };
  }

  for (const cand of ['src/main.ts', 'src/index.ts', 'src/main.tsx']) {
    if (await ws.exists(cand)) {
      return { type: 'run-program', entry: cand, command: `npx tsx ${cand} --help` };
    }
  }
  return null;
}

async function runTsEntryProbe(
  probe:
    | { type: 'start-script'; command: string }
    | { type: 'run-program'; entry: string; command: string }
    | { type: 'exec'; cmd: string; argv: string[]; command: string },
  sandbox: Sandbox,
): Promise<Awaited<ReturnType<Sandbox['runProgram']>>> {
  if (probe.type === 'start-script') {
    return sandbox.exec('npm', ['run', '--silent', 'start', '--', '--help'], { timeoutMs: 60_000 });
  }
  if (probe.type === 'exec') {
    return sandbox.exec(probe.cmd, probe.argv, { timeoutMs: 60_000 });
  }
  return sandbox.runProgram([probe.entry, '--help'], { timeoutMs: 60_000 });
}

function toTsBinProbe(
  entry: string,
): { type: 'run-program'; entry: string; command: string } | { type: 'exec'; cmd: string; argv: string[]; command: string } {
  if (entry.endsWith('.js')) {
    return { type: 'exec', cmd: 'node', argv: [entry, '--help'], command: `node ${entry} --help` };
  }
  return { type: 'run-program', entry, command: `npx tsx ${entry} --help` };
}

async function readJsonFile<T>(
  ws: Workspace,
  rel: string,
): Promise<T | null> {
  try {
    return JSON.parse(await ws.readFile(rel)) as T;
  } catch {
    return null;
  }
}
