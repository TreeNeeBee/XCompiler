import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import { t } from '../i18n/index.js';
import type { Language } from '../core/plan.js';
import type { Sandbox, SandboxLimits, ExecResult, ExecExtra } from './types.js';
import { normalizeTypeScriptTestArgs } from './test_args.js';
import { resolveTypeScriptProgramCommand } from './program_args.js';

export type { SandboxLimits, ExecResult } from './types.js';

export interface SubprocessSandboxOptions {
  ws: Workspace;
  limits: SandboxLimits;
  audit?: AuditLogger;
  /** 目标语言，决定运行时（venv/pip/pytest vs node_modules/npm/vitest）。默认 python。 */
  language?: Language;
  /** 沙盒根目录相对 workspace，默认 `.sandbox` */
  sandboxDir?: string;
  /** Python 解释器。默认从 PATH 找 python3 / python。 */
  pythonBin?: string;
  /** 是否继承宿主进程环境。默认 true；验证不可信候选时应设为 false。 */
  inheritEnv?: boolean;
}

/**
 * SubprocessSandbox：
 *  - 在 workspace/.sandbox/venv 内创建 Python 虚拟环境
 *  - `requirements.txt` 哈希作为缓存键，未变更跳过 pip install
 *  - exec(): 强制 wall-clock 超时（subprocess 模式下 cpu/memory 仅做软限制）
 *
 * 注意：subprocess 模式不做强网络隔离；`network` 配置在该模式下仅作记录。
 * 真正的网络/资源隔离由 M4 的 DockerSandbox 提供。
 */
export class SubprocessSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  private readonly language: Language;
  private readonly sandboxAbs: string;
  private readonly venvAbs: string;
  private readonly cacheFile: string;
  private pyBin: string | null = null;

  constructor(private readonly opts: SubprocessSandboxOptions) {
    this.language = opts.language ?? 'python';
    const dir = opts.sandboxDir ?? '.sandbox';
    this.sandboxAbs = opts.ws.abs(dir);
    // venv 目录名 = 项目名（workspace 目录的 basename，做安全清洗），方便 `source` 后
    // shell prompt 显示 `(<projectName>)`，多项目时一眼可辨。
    const projectName = sanitizeVenvName(path.basename(opts.ws.root));
    this.venvAbs = path.join(this.sandboxAbs, projectName);
    this.cacheFile = path.join(
      this.sandboxAbs,
      this.language === 'typescript' ? 'package.sha256' : 'requirements.sha256',
    );
  }

  get root(): string {
    return this.sandboxAbs;
  }

  get pythonInVenv(): string {
    return path.join(this.venvAbs, 'bin', 'python');
  }

  get pipInVenv(): string {
    return path.join(this.venvAbs, 'bin', 'pip');
  }

  /** 解析当前可用的 system python。未找到则抛错。 */
  async resolvePython(): Promise<string> {
    if (this.pyBin) return this.pyBin;
    if (this.opts.pythonBin) {
      this.pyBin = this.opts.pythonBin;
      return this.pyBin;
    }
    for (const cand of ['python3', 'python']) {
      try {
        const r = await execRaw(cand, ['--version'], { timeoutMs: 3000 });
        if (r.exitCode === 0) {
          this.pyBin = cand;
          return cand;
        }
      } catch {
        /* try next */
      }
    }
    throw new Error('no python interpreter found in PATH (need python3 or python)');
  }

  /**
   * 构建/复用沙盒。manifestFile 为依赖清单在 workspace 内的相对路径；不存在则跳过安装。
   * Python → requirements.txt (venv + pip)；TypeScript → package.json (npm install)。
   */
  async build(manifestFile?: string): Promise<{ rebuilt: boolean; reason: string }> {
    await fs.mkdir(this.sandboxAbs, { recursive: true });
    if (this.opts.inheritEnv === false) {
      await Promise.all([
        fs.mkdir(path.join(this.sandboxAbs, 'home'), { recursive: true }),
        fs.mkdir(path.join(this.sandboxAbs, 'tmp'), { recursive: true }),
        fs.mkdir(path.join(this.sandboxAbs, 'npm-cache'), { recursive: true }),
      ]);
    }
    if (this.language === 'typescript') {
      return this.buildNode(manifestFile ?? 'package.json');
    }
    return this.buildPython(manifestFile ?? 'requirements.txt');
  }

  private async buildPython(requirementsTxt: string): Promise<{ rebuilt: boolean; reason: string }> {
    const reqAbs = this.opts.ws.abs(requirementsTxt);
    const reqContent = await fs.readFile(reqAbs, 'utf8').catch(() => '');
    const sig = crypto.createHash('sha256').update(reqContent).digest('hex');
    const cached = await fs.readFile(this.cacheFile, 'utf8').catch(() => '');
    const venvExists = await fs
      .stat(this.pythonInVenv)
      .then(() => true)
      .catch(() => false);

    if (venvExists && cached === sig) {
      return { rebuilt: false, reason: 'cache hit' };
    }

    const py = await this.resolvePython();
    if (!venvExists) {
      // 优先尝试带 pip 的 venv；某些发行版（如 Debian/Ubuntu 默认 python3 不含 ensurepip）
      // 会失败，再退回 --without-pip + 手动 ensurepip。
      const r = await execRaw(py, ['-m', 'venv', this.venvAbs], { timeoutMs: 60_000 });
      if (r.exitCode !== 0) {
        const r2 = await execRaw(py, ['-m', 'venv', '--without-pip', this.venvAbs], { timeoutMs: 60_000 });
        if (r2.exitCode !== 0) {
          throw new Error(`venv creation failed: ${r.stderr || r.stdout}\n\n--without-pip retry: ${r2.stderr || r2.stdout}`);
        }
      }
    }
    // 确保 venv 内有可用 pip：bin/pip 文件可能根本不存在（python3-venv 缺包 / --without-pip）。
    // 统一通过 python -m pip 调用，并在缺失时自动 ensurepip。
    const pyVenv = this.pythonInVenv;
    const pyVenvExists = await fs.stat(pyVenv).then(() => true).catch(() => false);
    if (!pyVenvExists) {
      throw new Error(`venv python missing after creation: ${pyVenv} (install system package python3-venv / python3-virtualenv)`);
    }
    const pipCheck = await execRaw(pyVenv, ['-m', 'pip', '--version'], { timeoutMs: 30_000 });
    if (pipCheck.exitCode !== 0) {
      const ep = await execRaw(pyVenv, ['-m', 'ensurepip', '--upgrade', '--default-pip'], { timeoutMs: 60_000 });
      if (ep.exitCode !== 0) {
        throw new Error(
          `venv pip unavailable and ensurepip failed (venv=${this.venvAbs}):\n${ep.stderr || ep.stdout}\n\n` +
            'Install on the host: apt-get install python3-venv python3-pip   or   yum install python3-pip',
        );
      }
    }
    if (reqContent.trim().length > 0) {
      const r = await execRaw(pyVenv, ['-m', 'pip', 'install', '-r', reqAbs, '--quiet', '--disable-pip-version-check'], {
        timeoutMs: this.opts.limits.wall_seconds * 1000 * 5,
      });
      if (r.exitCode !== 0) {
        throw new Error(
          `pip install failed (venv=${this.venvAbs}, requirements=${reqAbs}):\n${
            r.stderr || r.stdout
          }`,
        );
      }
    }
    await fs.writeFile(this.cacheFile, sig, 'utf8');
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.subprocessBuilt(!!reqContent), {
      messageId: 'sandbox.subprocess_built',
    });
    return { rebuilt: true, reason: venvExists ? 'requirements changed' : 'venv created' };
  }

  private async buildNode(manifestFile: string): Promise<{ rebuilt: boolean; reason: string }> {
    const pkgAbs = this.opts.ws.abs(manifestFile);
    const pkgContent = await fs.readFile(pkgAbs, 'utf8').catch(() => '');
    if (!pkgContent) {
      // package.json 尚未生成（HIGH_LEVEL_DESIGN 之前）→ 跳过 npm install。
      return { rebuilt: false, reason: 'no package.json yet' };
    }
    const lockAbs = this.opts.ws.abs('package-lock.json');
    const lockContent = await fs.readFile(lockAbs, 'utf8').catch(() => '');
    const sig = crypto.createHash('sha256').update(pkgContent + '\n' + lockContent).digest('hex');
    const cached = await fs.readFile(this.cacheFile, 'utf8').catch(() => '');
    const modulesExist = await fs
      .stat(this.opts.ws.abs('node_modules'))
      .then(() => true)
      .catch(() => false);
    if (modulesExist && cached === sig) {
      return { rebuilt: false, reason: 'cache hit' };
    }
    const installArgs = lockContent.trim()
      ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
    const r = await execRaw('npm', installArgs, {
      cwd: this.opts.ws.root,
      env: this.baseEnvironment(),
      timeoutMs: this.opts.limits.wall_seconds * 1000 * 10,
    });
    if (r.exitCode !== 0) {
      throw new Error(`npm dependency install failed (cwd=${this.opts.ws.root}):\n${r.stderr || r.stdout}`);
    }
    await fs.writeFile(this.cacheFile, sig, 'utf8');
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.subprocessNodeBuilt, {
      messageId: 'sandbox.subprocess_node_built',
    });
    return { rebuilt: true, reason: modulesExist ? 'package.json changed' : 'node_modules created' };
  }

  /** 执行任意命令（默认 cwd = workspace.root）。 */
  async exec(
    cmd: string,
    argv: string[],
    extra?: ExecExtra,
  ): Promise<ExecResult> {
    const cwd = extra?.cwd ?? this.opts.ws.root;
    const timeoutMs = extra?.timeoutMs ?? this.opts.limits.wall_seconds * 1000;
    const baseEnv = this.baseEnvironment();
    const env =
      this.language === 'typescript'
        ? {
            ...baseEnv,
            PATH: `${this.opts.ws.abs('node_modules/.bin')}:${baseEnv.PATH ?? ''}`,
            ...(extra?.env ?? {}),
          }
        : {
            ...baseEnv,
            PATH: `${path.join(this.venvAbs, 'bin')}:${baseEnv.PATH ?? ''}`,
            VIRTUAL_ENV: this.venvAbs,
            ...(extra?.env ?? {}),
          };
    await this.opts.audit?.event('sandbox.exec', t().sandboxLog.command('subprocess', `${cmd} ${argv.join(' ')}`), {
      messageId: 'sandbox.command',
      cwd,
      timeoutMs,
    });
    const r = await execRaw(cmd, argv, { cwd, env, timeoutMs });
    return r;
  }

  private baseEnvironment(): NodeJS.ProcessEnv {
    if (this.opts.inheritEnv !== false) return { ...process.env };
    return {
      PATH: process.env.PATH ?? '',
      HOME: path.join(this.sandboxAbs, 'home'),
      TMPDIR: path.join(this.sandboxAbs, 'tmp'),
      CI: '1',
      NO_COLOR: '1',
      NPM_CONFIG_CACHE: path.join(this.sandboxAbs, 'npm-cache'),
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    };
  }

  /** 运行工程入口程序。Python → venv python；TypeScript → npx tsx。 */
  async runProgram(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    if (this.language === 'typescript') {
      const command = resolveTypeScriptProgramCommand(args);
      return this.exec(command.cmd, command.argv, extra);
    }
    return this.exec(this.pythonInVenv, args, extra);
  }

  /** 运行测试。Python → pytest；TypeScript → npm test（Vitest）。 */
  async runTests(args: string[] = [], extra?: ExecExtra): Promise<ExecResult> {
    if (this.language === 'typescript') {
      const normalizedArgs = normalizeTypeScriptTestArgs(args);
      const argv = normalizedArgs.length > 0 ? ['test', '--silent', '--', ...normalizedArgs] : ['test', '--silent'];
      return this.exec('npm', argv, extra);
    }
    return this.exec(this.pythonInVenv, ['-m', 'pytest', ...args], extra);
  }

  /** 安装额外依赖（不会写入依赖清单，需要由调用方自行回写）。 */
  async installDeps(packages: string[]): Promise<ExecResult> {
    if (this.language === 'typescript') {
      return this.exec('npm', ['install', '--no-audit', '--no-fund', ...packages]);
    }
    return this.exec(this.pythonInVenv, ['-m', 'pip', 'install', ...packages, '--quiet', '--disable-pip-version-check']);
  }
}

/** 把任意 workspace 目录名规整为 venv 安全名（保留 [A-Za-z0-9._-]，回退到 'venv'）。 */
export function sanitizeVenvName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'venv';
}

/** 不依赖沙盒的底层 spawn 封装。 */
export async function execRaw(
  cmd: string,
  argv: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const t = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('error', (err) => {
      if (t) clearTimeout(t);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
    child.on('close', (code) => {
      if (t) clearTimeout(t);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}
