import { existsSync, readFileSync } from 'node:fs';
import type { Workspace } from '../workspace/workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import type { ToaaConfig } from '../config/config.js';
import type { Language } from '../core/plan.js';
import { getLanguageProfile } from '../core/language.js';
import type { Sandbox } from './types.js';
import { SubprocessSandbox } from './subprocess.js';
import { DockerSandbox } from './docker.js';
import { t } from '../i18n/index.js';

/**
 * 检测当前进程是否跑在容器里。依据（任一命中即认为在容器内）：
 *  - 环境变量 TOAA_IN_CONTAINER=1（显式覆盖 / Dockerfile 中设置）
 *  - /.dockerenv 文件存在（docker 默认创建）
 *  - /run/.containerenv 存在（podman 默认创建）
 *  - /proc/1/cgroup 包含 'docker' / 'kubepods' / 'containerd'
 *
 * 显式设 TOAA_IN_CONTAINER=0 强制按"宿主"对待（仅在你确认 DooD 路径语义无误时使用）。
 */
export function isRunningInContainer(): boolean {
  const env = process.env.TOAA_IN_CONTAINER;
  if (env === '1') return true;
  if (env === '0') return false;
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  try {
    const cg = readFileSync('/proc/1/cgroup', 'utf8');
    if (/\b(docker|kubepods|containerd|podman)\b/.test(cg)) return true;
  } catch {
    /* not linux or unreadable */
  }
  return false;
}

/**
 * 工厂：按 config.agent.sandbox 选择实现。
 *
 * 约束：当 TOAA 本身运行在容器内时，**不支持** sandbox=docker（DooD 在多数
 * 部署中会造成 bind-mount 路径语义不一致、docker.sock GID 错位等问题）。给
 * 出明确错误信息，引导用户改用 sandbox=subprocess 或在宿主上运行 TOAA。
 */
export function createSandbox(
  cfg: ToaaConfig,
  ws: Workspace,
  audit?: AuditLogger,
  language: Language = cfg.agent.language,
): Sandbox {
  const profile = getLanguageProfile(language);
  // 默认镜像按实际执行语言推导。若当前 plan 语言与 config.agent.language 不同，
  // 说明我们在执行/恢复另一种语言的历史 plan，此时不能沿用配置里为默认语言定制的镜像。
  const configuredImage = cfg.agent.sandbox_docker.image;
  const image =
    language === cfg.agent.language
      ? configuredImage
      : profile.defaultDockerImage;
  const kind = cfg.agent.sandbox;
  if (cfg.agent.sandbox_limits.network === 'pypi-only') {
    throw new Error(t().system.unsupportedPypiOnlyNetwork);
  }
  if (kind === 'docker') {
    if (isRunningInContainer()) {
      throw new Error(t().system.dockerInsideContainerUnsupported);
    }
    return new DockerSandbox({
      ws,
      limits: cfg.agent.sandbox_limits,
      audit,
      language,
      image,
      workdir: cfg.agent.sandbox_docker.workdir,
      pull: cfg.agent.sandbox_docker.pull,
      dockerBin: cfg.agent.sandbox_docker.docker_bin,
      extraRunArgs: cfg.agent.sandbox_docker.extra_run_args,
    });
  }
  if (kind === 'firejail') {
    throw new Error(t().system.firejailUnsupported);
  }
  // 在容器内默认提示（但不抦截）：subprocess 是唯一推荐选项
  return new SubprocessSandbox({ ws, limits: cfg.agent.sandbox_limits, audit, language });
}
