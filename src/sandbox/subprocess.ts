import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import type { Sandbox, SandboxLimits, ExecResult, ExecExtra } from './types.js';

export type { SandboxLimits, ExecResult } from './types.js';

export interface SubprocessSandboxOptions {
  ws: Workspace;
  limits: SandboxLimits;
  audit?: AuditLogger;
  /** 沙盒根目录相对 workspace，默认 `.sandbox` */
  sandboxDir?: string;
  /** Python 解释器。默认从 PATH 找 python3 / python。 */
  pythonBin?: string;
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
  private readonly sandboxAbs: string;
  private readonly venvAbs: string;
  private readonly cacheFile: string;
  private pyBin: string | null = null;

  constructor(private readonly opts: SubprocessSandboxOptions) {
    const dir = opts.sandboxDir ?? '.sandbox';
    this.sandboxAbs = opts.ws.abs(dir);
    // venv 目录名 = 项目名（workspace 目录的 basename，做安全清洗），方便 `source` 后
    // shell prompt 显示 `(<projectName>)`，多项目时一眼可辨。
    const projectName = sanitizeVenvName(path.basename(opts.ws.root));
    this.venvAbs = path.join(this.sandboxAbs, projectName);
    this.cacheFile = path.join(this.sandboxAbs, 'requirements.sha256');
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
   * 构建/复用沙盒。requirementsTxt 为 `requirements.txt` 在 workspace 内的相对路径；不存在则跳过 pip install。
   */
  async build(requirementsTxt = 'requirements.txt'): Promise<{ rebuilt: boolean; reason: string }> {
    await fs.mkdir(this.sandboxAbs, { recursive: true });
    const reqAbs = this.opts.ws.abs(requirementsTxt);
    let reqContent = '';
    try {
      reqContent = await fs.readFile(reqAbs, 'utf8');
    } catch {
      reqContent = '';
    }
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
      let r = await execRaw(py, ['-m', 'venv', this.venvAbs], { timeoutMs: 60_000 });
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
      throw new Error(`venv python missing after creation: ${pyVenv}（请安装系统包 python3-venv / python3-virtualenv）`);
    }
    const pipCheck = await execRaw(pyVenv, ['-m', 'pip', '--version'], { timeoutMs: 30_000 });
    if (pipCheck.exitCode !== 0) {
      const ep = await execRaw(pyVenv, ['-m', 'ensurepip', '--upgrade', '--default-pip'], { timeoutMs: 60_000 });
      if (ep.exitCode !== 0) {
        throw new Error(
          `venv pip 不可用，且 ensurepip 失败 (venv=${this.venvAbs}):\n${ep.stderr || ep.stdout}\n\n` +
            '请在宿主机安装：apt-get install python3-venv python3-pip   或   yum install python3-pip',
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
    await this.opts.audit?.event('sandbox.exec', `sandbox built (${reqContent ? 'with deps' : 'empty'})`);
    return { rebuilt: true, reason: venvExists ? 'requirements changed' : 'venv created' };
  }

  /** 执行任意命令（默认 cwd = workspace.root）。 */
  async exec(
    cmd: string,
    argv: string[],
    extra?: ExecExtra,
  ): Promise<ExecResult> {
    const cwd = extra?.cwd ?? this.opts.ws.root;
    const timeoutMs = extra?.timeoutMs ?? this.opts.limits.wall_seconds * 1000;
    const env = {
      ...process.env,
      PATH: `${path.join(this.venvAbs, 'bin')}:${process.env.PATH ?? ''}`,
      VIRTUAL_ENV: this.venvAbs,
      ...(extra?.env ?? {}),
    };
    await this.opts.audit?.event('sandbox.exec', `${cmd} ${argv.join(' ')}`, {
      cwd,
      timeoutMs,
    });
    const r = await execRaw(cmd, argv, { cwd, env, timeoutMs });
    return r;
  }

  /** 在沙盒 venv 内运行 python。 */
  async runPython(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    return this.exec(this.pythonInVenv, args, extra);
  }

  /** 运行 pytest。 */
  async runPytest(args: string[] = [], extra?: ExecExtra): Promise<ExecResult> {
    return this.exec(this.pythonInVenv, ['-m', 'pytest', ...args], extra);
  }

  /** 安装额外依赖（不会写入 requirements.txt，需要由调用方自行回写）。 */
  async pipInstall(packages: string[]): Promise<ExecResult> {
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
