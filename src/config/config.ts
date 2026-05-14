import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import 'dotenv/config';

const ProviderSchema = z.object({
  api_key: z.string().nullish().transform((v) => v ?? ''),
  base_url: z.string().nullish().transform((v) => v ?? ''),
  model: z.string().min(1),
  /** 请求 wall-clock 总超时（毫秒）。默认 10 分钟。0 = 不限制。 */
  request_timeout_ms: z.number().int().nonnegative().optional(),
  /** 流式空闲超时（毫秒）。默认 60s。0 = 不限制。 */
  stream_idle_timeout_ms: z.number().int().nonnegative().optional(),
  /** 流式输出字符上限。默认 200000。0 = 不限制。 */
  max_output_chars: z.number().int().nonnegative().optional(),
});

const ConfigSchema = z.object({
  /** UI / prompt language. Accepts 'en' (default) or 'zh'. */
  ui_language: z.enum(['en', 'zh']).default('en'),
  llm: z.object({
    default: z.string(),
    providers: z.record(z.string(), ProviderSchema),
    /**
     * 角色 → provider 数组的映射。
     * 兼容旧格式：单字符串 `Coder: ollama_code` 自动归一化为 `[ollama_code]`。
     * 数组形式 `Coder: [ollama_code, openai]` 表示该角色的候选 LLM 池；
     * 实际选择顺序由 `llm.scores` 评分降序决定，评分=0 的 provider 直接跳过。
     */
    roles: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .default({})
      .transform((obj) => {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(obj)) {
          out[k] = Array.isArray(v) ? [...v] : [v];
        }
        return out;
      }),
    /** 全局 fallback 链：当主 provider 调用报错时依次尝试 */
    fallbacks: z.array(z.string()).default([]),
    /** 可选：按角色指定 fallback 链（覆盖全局） */
    role_fallbacks: z.record(z.string(), z.array(z.string())).default({}),
    /**
     * Provider 评分快照（启动时从 sidecar 文件加载，运行时由 ScoreStore 维护并自动落盘）。
     * 配置文件里也可以手工设置初始值；不存在的 provider 默认评分 = 1。
     * 评分 = 0 表示禁用（preflight 检测到模型不在 ollama 服务器时也会置 0）。
     */
    scores: z.record(z.string(), z.number().min(0)).default({}),
  }),
  agent: z.object({
    language: z.literal('python'),
    max_steps: z.number().int().positive().default(50),
    max_debug_retries: z.number().int().positive().default(3),
    /** Debugger 滑动窗口的硬上限（默认 = max(max_debug_retries*4, 10)）。 */
    max_debug_retries_cap: z.number().int().positive().optional(),
    max_rounds_per_step: z.number().int().positive().default(6),
    max_debug_rounds_per_step: z.number().int().positive().optional(),
    max_edit_lines_per_step: z.number().int().positive().default(400),
    sandbox: z.enum(['subprocess', 'docker', 'firejail']).default('subprocess'),
    sandbox_limits: z
      .object({
        cpu: z.number().positive().default(1),
        memory_mb: z.number().int().positive().default(1024),
        wall_seconds: z.number().int().positive().default(60),
        /**
         * Sandbox network policy.
         *  - `off`            — no network at all (`docker --network none`).
         *  - `download-only`  — outbound traffic allowed, no inbound port publishing
         *                       (default; lets python pip-install / fetch web pages).
         *  - `pypi-only`      — alias of `download-only` (kept for backward compatibility).
         *  - `full`           — outbound + every port in `expose_ports` is published
         *                       to `127.0.0.1` so host-side tests can reach the app.
         */
        network: z
          .enum(['off', 'pypi-only', 'download-only', 'full'])
          .default('download-only'),
        /** Container ports to publish to 127.0.0.1 when `network=full`. */
        expose_ports: z.array(z.number().int().min(1).max(65535)).default([]),
      })
      .default({
        cpu: 1,
        memory_mb: 1024,
        wall_seconds: 60,
        network: 'download-only',
        expose_ports: [],
      }),
    sandbox_docker: z
      .object({
        image: z.string().default('python:3.11-slim'),
        workdir: z.string().default('/workspace'),
        pull: z.boolean().default(false),
        docker_bin: z.string().default('docker'),
        extra_run_args: z.array(z.string()).default([]),
      })
      .default({
        image: 'python:3.11-slim',
        workdir: '/workspace',
        pull: false,
        docker_bin: 'docker',
        extra_run_args: [],
      }),
  }),
});

export type ToaaConfig = z.infer<typeof ConfigSchema>;

/**
 * 配置文件查找顺序（优先级从高到低）：
 *   1. 显式 --config / explicitPath
 *   2. 当前目录 ./config.yaml
 *   3. $TOAA_PATH/config.yaml          （安装/全局配置目录，默认 ~/.toaa）
 *   4. 当前目录 ./config.example.yaml  （仓库 fallback）
 *   5. $TOAA_PATH/config.example.yaml
 */
export function getToaaPath(): string {
  const env = process.env.TOAA_PATH;
  if (env && env.trim()) return path.resolve(env.trim());
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/root';
  return path.join(home, '.toaa');
}

function defaultSearchPaths(): string[] {
  const toaaPath = getToaaPath();
  return [
    path.resolve('config.yaml'),
    path.join(toaaPath, 'config.yaml'),
    path.resolve('config.example.yaml'),
    path.join(toaaPath, 'config.example.yaml'),
  ];
}

export async function loadConfig(explicitPath?: string): Promise<ToaaConfig> {
  const r = await loadConfigWithPath(explicitPath);
  return r.config;
}

export interface LoadedConfig {
  config: ToaaConfig;
  /** 实际命中的 config 文件绝对路径（供 ScoreStore 在同目录下落盘 sidecar 评分文件）。 */
  path: string;
}

export async function loadConfigWithPath(explicitPath?: string): Promise<LoadedConfig> {
  const tried: string[] = [];
  const candidates = explicitPath ? [path.resolve(explicitPath)] : defaultSearchPaths();
  for (const abs of candidates) {
    tried.push(abs);
    try {
      const raw = await fs.readFile(abs, 'utf8');
      const expanded = expandEnv(raw);
      const data = YAML.parse(expanded);
      return { config: ConfigSchema.parse(data), path: abs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  throw new Error(
    `No config file found. Tried (in order):\n  ${tried.join('\n  ')}\n` +
      `\nHint: set TOAA_PATH to point at a directory containing config.yaml, ` +
      `or run from a directory that contains config.yaml.`,
  );
}

function expandEnv(s: string): string {
  const missing = new Set<string>();
  const out = s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === '') {
      missing.add(name);
      return '';
    }
    return v;
  });
  if (missing.size > 0) {
    // 不抛错（OPENAI_* 在不使用 openai provider 时确实可缺），但给出明显提示。
    // 若关键 provider 因此变成空 base_url，createClient 会兜底到 localhost。
    // eslint-disable-next-line no-console
    console.warn(
      `[toaa] config 中以下环境变量未设置（已替换为空串）：${[...missing].join(', ')}`,
    );
  }
  return out;
}
