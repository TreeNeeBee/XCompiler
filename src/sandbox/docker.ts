import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import type { Sandbox, SandboxLimits, ExecResult, ExecExtra } from './types.js';
import { execRaw, sanitizeVenvName } from './subprocess.js';

export interface DockerSandboxOptions {
  ws: Workspace;
  limits: SandboxLimits;
  audit?: AuditLogger;
  /** 镜像名，默认 python:3.11-slim */
  image?: string;
  /** 容器内挂载点，默认 /workspace */
  workdir?: string;
  /** 沙盒目录相对 workspace，venv 等放这里；默认 .sandbox */
  sandboxDir?: string;
  /** docker 可执行路径，默认 PATH 中的 docker */
  dockerBin?: string;
  /** 是否在 build 时强制 docker pull（拉取最新镜像） */
  pull?: boolean;
  /** 额外 docker run 参数（高级用户） */
  extraRunArgs?: string[];
}

/**
 * DockerSandbox：使用系统 docker daemon，将工程目录 bind-mount 到容器内运行。
 *
 * - 不构建自定义镜像。直接以 `python:3.11-slim`（或 cfg.image）为基底，
 *   在 bind-mount 的工程目录下创建 `.sandbox/venv` 并 `pip install -r requirements.txt`，
 *   把"环境构建产物"全部落在挂载卷里 → 重启容器后立即复用，无 docker volume 黏性。
 * - exec/runPython/runPytest：每次起一个临时容器（--rm），cgroup 限制由 --cpus / --memory 提供，
 *   wall-clock 超时由 host 端 spawn 控制。
 * - "debug 时直接修改工程代码"：因为是 bind mount，TOAA 工具在宿主机上的写入会瞬时反映到容器；
 *   下一次 exec 直接看到新代码，无需重新构建镜像。
 *
 * 网络策略：
 *   - `off`        → `--network none`
 *   - `pypi-only`  → 默认网络（Docker 网络层无法只放行 PyPI；TOAA 依赖镜像源 + 文档约束实现"只装包不联网"）
 *   - `full`       → 默认网络
 *   build 阶段必须能联网拉取依赖；exec 阶段若设 `off` 则完全断网。
 */
export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const;

  private readonly image: string;
  private readonly workdir: string;
  private readonly sandboxRel: string;
  private readonly cacheRel: string;
  private readonly dockerBin: string;
  private readonly extraRunArgs: string[];
  private readonly pull: boolean;
  private readonly venvName: string;

  constructor(private readonly opts: DockerSandboxOptions) {
    this.image = opts.image ?? 'python:3.11-slim';
    this.workdir = opts.workdir ?? '/workspace';
    this.sandboxRel = (opts.sandboxDir ?? '.sandbox').replaceAll('\\', '/');
    this.cacheRel = `${this.sandboxRel}/requirements.sha256`;
    this.dockerBin = opts.dockerBin ?? 'docker';
    this.extraRunArgs = opts.extraRunArgs ?? [];
    this.pull = !!opts.pull;
    // venv 目录名 = 项目名（与 SubprocessSandbox 保持一致）
    this.venvName = sanitizeVenvName(path.basename(opts.ws.root));
  }

  /** 容器内 venv 路径 */
  private get venvInContainer(): string {
    return `${this.workdir}/${this.sandboxRel}/${this.venvName}`;
  }

  private get pythonInContainer(): string {
    return `${this.venvInContainer}/bin/python`;
  }

  private get pipInContainer(): string {
    return `${this.venvInContainer}/bin/pip`;
  }

  /** 检查 docker 是否可用 */
  async assertDocker(): Promise<void> {
    const r = await execRaw(this.dockerBin, ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 5000,
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `docker daemon not reachable via ${this.dockerBin}: ${r.stderr || r.stdout || 'unknown error'}`,
      );
    }
  }

  /**
   * 构建/复用环境：
   * 1. 哈希 requirements.txt → 命中缓存（venv 存在 + sha 一致）则直接返回；
   * 2. 否则起一次性容器，在 bind-mount 的 .sandbox/ 内创建 venv + pip install。
   */
  async build(requirementsTxt = 'requirements.txt'): Promise<{ rebuilt: boolean; reason: string }> {
    await this.assertDocker();
    const sandboxAbs = this.opts.ws.abs(this.sandboxRel);
    await fs.mkdir(sandboxAbs, { recursive: true });

    const reqAbs = this.opts.ws.abs(requirementsTxt);
    let reqContent = '';
    try {
      reqContent = await fs.readFile(reqAbs, 'utf8');
    } catch {
      reqContent = '';
    }
    const sig = crypto.createHash('sha256').update(this.image + '\n' + reqContent).digest('hex');
    const cacheAbs = this.opts.ws.abs(this.cacheRel);
    const cached = await fs.readFile(cacheAbs, 'utf8').catch(() => '');
    const venvExists = await fs
      .stat(path.join(sandboxAbs, this.venvName, 'bin', 'python'))
      .then(() => true)
      .catch(() => false);

    if (venvExists && cached === sig) {
      return { rebuilt: false, reason: 'cache hit' };
    }

    if (this.pull) {
      const r = await execRaw(this.dockerBin, ['pull', this.image], { timeoutMs: 300_000 });
      if (r.exitCode !== 0) {
        throw new Error(`docker pull ${this.image} failed: ${r.stderr || r.stdout}`);
      }
    }

    const reqInContainer = `${this.workdir}/${requirementsTxt}`;
    const installCmd =
      reqContent.trim().length > 0
        ? `python -m venv ${this.venvInContainer} && ${this.pipInContainer} install --quiet -r ${reqInContainer}`
        : `python -m venv ${this.venvInContainer}`;

    const r = await execRaw(
      this.dockerBin,
      [
        'run',
        '--rm',
        '-v',
        `${this.opts.ws.root}:${this.workdir}`,
        '-w',
        this.workdir,
        ...this.extraRunArgs,
        this.image,
        'bash',
        '-lc',
        installCmd,
      ],
      { timeoutMs: this.opts.limits.wall_seconds * 1000 * 10 },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `docker sandbox build failed (exit=${r.exitCode}):\n${r.stderr || r.stdout}`,
      );
    }
    await fs.writeFile(cacheAbs, sig, 'utf8');
    await this.opts.audit?.event('sandbox.exec', `docker sandbox built (${reqContent ? 'with deps' : 'empty'})`, {
      image: this.image,
    });
    return { rebuilt: true, reason: venvExists ? 'requirements changed' : 'venv created' };
  }

  /** 在容器内执行任意命令。cwd 视为 workspace 内相对路径或绝对宿主路径（后者会被映射回容器）。 */
  async exec(cmd: string, argv: string[], extra?: ExecExtra): Promise<ExecResult> {
    const containerCwd = this.toContainerPath(extra?.cwd) ?? this.workdir;
    const timeoutMs = extra?.timeoutMs ?? this.opts.limits.wall_seconds * 1000;

    const dockerArgs: string[] = [
      'run',
      '--rm',
      '-v',
      `${this.opts.ws.root}:${this.workdir}`,
      '-w',
      containerCwd,
      `--cpus=${this.opts.limits.cpu}`,
      `--memory=${this.opts.limits.memory_mb}m`,
      '--pids-limit',
      '256',
      '-e',
      `VIRTUAL_ENV=${this.venvInContainer}`,
      '-e',
      `PATH=${this.venvInContainer}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ];
    for (const [k, v] of Object.entries(extra?.env ?? {})) {
      dockerArgs.push('-e', `${k}=${v}`);
    }
    if (this.opts.limits.network === 'off') dockerArgs.push('--network', 'none');
    dockerArgs.push(...this.extraRunArgs, this.image, cmd, ...argv);

    await this.opts.audit?.event('sandbox.exec', `docker ${cmd} ${argv.join(' ')}`, {
      cwd: containerCwd,
      timeoutMs,
      image: this.image,
      network: this.opts.limits.network,
    });
    return execRaw(this.dockerBin, dockerArgs, { timeoutMs });
  }

  async runPython(args: string[], extra?: ExecExtra): Promise<ExecResult> {
    return this.exec(this.pythonInContainer, args, extra);
  }

  async runPytest(args: string[] = [], extra?: ExecExtra): Promise<ExecResult> {
    return this.exec(this.pythonInContainer, ['-m', 'pytest', ...args], extra);
  }

  async pipInstall(packages: string[]): Promise<ExecResult> {
    return this.exec(this.pipInContainer, ['install', '--quiet', ...packages]);
  }

  /** 将宿主机绝对路径映射回容器路径；相对路径或 undefined 原样返回（相对则拼到 workdir）。 */
  private toContainerPath(p?: string): string | null {
    if (!p) return null;
    if (path.isAbsolute(p)) {
      const root = path.resolve(this.opts.ws.root);
      const norm = path.resolve(p);
      if (norm === root) return this.workdir;
      if (norm.startsWith(root + path.sep)) {
        return this.workdir + '/' + norm.slice(root.length + 1).replaceAll(path.sep, '/');
      }
      // 不在 workspace 内的绝对路径不可见 — fallback 至 workdir
      return this.workdir;
    }
    return `${this.workdir}/${p.replaceAll('\\', '/')}`;
  }
}
