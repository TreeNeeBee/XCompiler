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
  /** DELIVERY gate：探测入口 `--help` 是否开箱即用。返回 null 表示跳过。 */
  probeEntry?(ws: Workspace, sandbox: Sandbox): Promise<EntrypointProbe | null>;
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

const TS_PLANNER_OVERRIDE = `

──────────────────────────────────────────────────────────────────────────
## LANGUAGE OVERRIDE — THIS IS A TYPESCRIPT / NODE.JS PROJECT
plan.language is "typescript". The Python-specific instructions above are
SUPERSEDED by the rules in this block. Follow ONLY these for language specifics:

T1. Target a standalone runnable Node.js (TypeScript) application. Source lives
    under \`src/**/*.ts\`; tests under \`tests/**/*.test.ts\` (Vitest). The CODE phase
    must produce a directly runnable entry \`src/main.ts\` whose bottom calls a
    \`main()\` that prints help/usage and runs with no extra arguments.
T2. **Dependency manifest is \`package.json\` (NOT requirements.txt).** Exactly one
    ARCH Step must list \`package.json\` in its outputs and author it with:
      - "type": "module",
      - "scripts": { "test": "vitest run", "start": "tsx src/main.ts" },
      - runtime deps in "dependencies",
      - devDependencies MUST include: "vitest", "typescript", "tsx", "@types/node".
    A \`tsconfig.json\` at the repo root may also be an ARCH output. Do NOT list
    \`requirements.txt\` anywhere. Later runtime deps go through the \`add_dependency\`
    tool (it appends to package.json and reinstalls).
T3. The \`dependencies\` plan field: list runtime npm packages (bare names, no
    version ranges). It is advisory context — the authoritative manifest is the
    \`package.json\` written by ARCH. \`pytest\` is irrelevant; tests use Vitest.
T4. **Import conventions**: use ESM relative imports between local modules with
    explicit \`.js\` extensions (TS+NodeNext), e.g. \`import { parse } from './parser.js';\`
    (the source file is \`parser.ts\` but the import specifier ends in \`.js\`). Never
    use \`from src.x\`-style or bare local imports.
T5. The DELIVERY \`docs/05-delivery.md\` run command must be copy-pasteable, e.g.
    \`npx tsx src/main.ts --help\` (after \`npm install\`).
T6. Phase purity still holds: REQUIREMENT/ARCH/TASK/DELIVERY must not output
    \`src/**/*.ts\` or \`tests/**/*.ts\` (only docs/*.md, plus package.json/tsconfig.json
    for ARCH). All implementation/tests live in CODE/TEST.
──────────────────────────────────────────────────────────────────────────`;

const TS_EXECUTOR_OVERRIDE = `

──────────────────────────────────────────────────────────────────────────
LANGUAGE OVERRIDE — TYPESCRIPT / NODE.JS PROJECT (supersedes Python rule 3 & 6):
- Generated code is TypeScript (strict, typed). Local module imports use ESM
  relative specifiers ending in ".js" (e.g. import { x } from "./util.js"; the
  file on disk is util.ts). Never use Python-style imports or sys.path hacks.
- Tests use Vitest: import { describe, it, expect } from "vitest". Run them with
  the run_tests tool (it executes "npm test"). Self-contained tests only — create
  any fixture files with write_file under tests/fixtures/ instead of reading files
  that do not exist.
- The dependency manifest is package.json. Use add_dependency to add npm packages
  (it rewrites package.json + reinstalls); never hand-edit requirements.txt.
- run_program runs "npx tsx <args>" (e.g. args ["src/main.ts","--help"]).
- Chunked writes: keep each write_file/append_file under 6000 bytes; the
  concatenated file must be valid TypeScript — never split inside a function body.
──────────────────────────────────────────────────────────────────────────`;

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
  plannerPromptOverride: TS_PLANNER_OVERRIDE,
  executorPromptOverride: TS_EXECUTOR_OVERRIDE,
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
): Promise<EntrypointProbe | null> {
  const tail = (s: string): string => s.split('\n').slice(-30).join('\n');
  let entry: string | null = null;
  for (const cand of ['src/main.ts', 'src/index.ts', 'src/main.tsx']) {
    if (await ws.exists(cand)) {
      entry = cand;
      break;
    }
  }
  if (!entry) {
    return {
      ok: false,
      command: 'npx tsx src/main.ts --help',
      exitCode: -1,
      timedOut: false,
      stdoutTail: '',
      stderrTail: 'missing TypeScript entrypoint: expected one of src/main.ts, src/index.ts, src/main.tsx',
    };
  }
  const argv = [entry, '--help'];
  const command = `npx tsx ${argv.join(' ')}`;
  let r;
  try {
    r = await sandbox.runProgram(argv, { timeoutMs: 60_000 });
  } catch (err) {
    return {
      ok: false,
      command,
      exitCode: -1,
      timedOut: false,
      stdoutTail: '',
      stderrTail: (err as Error).message,
    };
  }
  const ok = r.exitCode === 0 && !r.timedOut;
  return {
    ok,
    command,
    exitCode: r.exitCode,
    timedOut: r.timedOut ?? false,
    stdoutTail: tail(r.stdout),
    stderrTail: tail(r.stderr),
  };
}
