/**
 * 沙盒抽象。subprocess 与 docker 实现共用。
 *
 * 设计要点（与用户约定一致）：
 *  - "开发工程时使用挂载的方式将工程目录挂载到 docker 中运行" —— Docker 实现使用 bind mount，
 *    工程目录在宿主机即可见。
 *  - "debug 时直接修改工程代码" —— 因为是 bind mount，TOAA 通过 Workspace 在宿主机上写入的
 *    任何文件都会立刻反映到容器内，无需复制 / 拷贝。
 */

export interface SandboxLimits {
  cpu: number;
  memory_mb: number;
  wall_seconds: number;
  network: 'off' | 'pypi-only' | 'full';
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecExtra {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** 沙盒统一接口。任意 phase / tool 都通过此接口与运行时交互。 */
export interface Sandbox {
  /** 实现标识，便于审计与日志区分。 */
  readonly kind: 'subprocess' | 'docker';

  /** 构建/复用环境（pip install -r requirements.txt + venv）。返回是否真正重建。 */
  build(requirementsTxt?: string): Promise<{ rebuilt: boolean; reason: string }>;

  /** 执行任意命令；cmd 视实现可能是宿主路径或容器内路径。 */
  exec(cmd: string, argv: string[], extra?: ExecExtra): Promise<ExecResult>;

  /** 在沙盒内运行 python（自动选用 venv 内解释器）。 */
  runPython(args: string[], extra?: ExecExtra): Promise<ExecResult>;

  /** 运行 pytest。 */
  runPytest(args?: string[], extra?: ExecExtra): Promise<ExecResult>;

  /** 安装额外依赖（不写入 requirements.txt）。 */
  pipInstall(packages: string[]): Promise<ExecResult>;
}
