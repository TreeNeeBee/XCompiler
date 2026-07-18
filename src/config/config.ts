import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import 'dotenv/config';
import { t } from '../i18n/index.js';
import { xcEnv } from './env.js';

const ProviderStringScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const OptionalProviderStringSchema = ProviderStringScalarSchema.nullish().transform((v) =>
  v == null ? '' : String(v),
);
const RequiredProviderStringSchema = ProviderStringScalarSchema.transform((v) => String(v)).pipe(
  z.string().min(1),
);
const ProviderAccessTypeSchema = z.enum(['openai', 'ollama']);
const JsonResponseFormatSchema = z.enum(['json_object', 'json_schema', 'none']);
const ProviderTagsSchema = z.array(z.string().min(1)).optional().transform((tags) =>
  tags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
);

const ProviderSchema = z.object({
  /**
   * Transport/API family used by this provider.
   *  - openai: OpenAI-compatible /v1/chat/completions endpoint, including OpenRouter, vLLM, mlx-server.
   *  - ollama: native Ollama /api/chat endpoint.
   */
  type: ProviderAccessTypeSchema,
  api_key: OptionalProviderStringSchema,
  base_url: OptionalProviderStringSchema,
  model: RequiredProviderStringSchema,
  /**
   * Provider labels used by runtime policy.
   * - cluster: aggregated/route provider such as OpenRouter free routes. These are
   *   useful backups but should start below dedicated providers in score ranking.
   */
  tags: ProviderTagsSchema,
  /** 请求 wall-clock 总超时（毫秒）。默认 15 分钟。0 = 不限制。 */
  request_timeout_ms: z.number().int().nonnegative().optional(),
  /** 流式空闲超时（毫秒）。默认 5 分钟。0 = 不限制。 */
  stream_idle_timeout_ms: z.number().int().nonnegative().optional(),
  /** 流式异常保护阈值。真实有效输出不会因长度本身被截断；0 = 关闭该阈值。 */
  max_output_chars: z.number().int().nonnegative().optional(),
  /**
   * OpenAI-compatible structured JSON response format.
   * Some providers (for example selected OpenRouter routes) do not support
   * `json_object` but do support `json_schema`.
   */
  json_response_format: JsonResponseFormatSchema.optional(),
  /** Ollama thinking 模型是否启用长思考；弱服务器上的结构化任务可设为 false。 */
  think: z.boolean().optional(),
});

const LocaleSchema = z.enum(['en', 'zh']);

const LlmSchema = z.object({
  default: z.string(),
  providers: z.record(z.string(), ProviderSchema),
  /**
   * 角色 → provider 数组的映射。
   * 兼容旧格式：单字符串 `Coder: ollama_code` 自动归一化为 `[ollama_code]`。
   * 数组形式 `Coder: [ollama_code, openai]` 表示该角色的候选 LLM 池；
   * 实际选择顺序由 `llm.scores` 评分降序决定；用户显式设置评分=0 的 provider 直接跳过。
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
   * 用户手工设置评分 = 0 表示禁用；运行时自动评分只在 0.1～1.0 范围内调整。
   */
  scores: z.record(z.string(), z.number().min(0)).default({}),
  /**
   * Providers tagged `cluster` (for example aggregated free routes) use this
   * narrower dynamic score range so they naturally remain backup choices.
   */
  cluster_score_min: z.number().min(0.1).max(1).optional(),
  cluster_score_max: z.number().min(0.1).max(1).optional(),
}).superRefine((llm, ctx) => {
  const min = llm.cluster_score_min ?? 0.2;
  const max = llm.cluster_score_max ?? 0.5;
  if (min > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cluster_score_min'],
      message: 'cluster_score_min must be less than or equal to cluster_score_max',
    });
  }
});

const ConfigSchema = z.object({
  /** CLI / prompt locale. Accepts 'en' (default) or 'zh'. */
  locale: LocaleSchema.optional(),
  /** @deprecated use `locale` instead. Kept as a backwards-compatible alias. */
  ui_language: LocaleSchema.optional(),
  llm: LlmSchema,
  agent: z.object({
    language: z.enum(['python', 'typescript']).default('python'),
    max_steps: z.number().int().positive().default(50),
    max_debug_retries: z.number().int().positive().default(3),
    /** Debugger 滑动窗口的硬上限（默认 = max(max_debug_retries*4, 10)）。 */
    max_debug_retries_cap: z.number().int().positive().optional(),
    max_rounds_per_step: z.number().int().positive().default(6),
    max_debug_rounds_per_step: z.number().int().positive().optional(),
    max_edit_lines_per_step: z.union([z.literal('auto'), z.number().int().positive()]).default('auto'),
    max_write_chunk_bytes: z.union([z.literal('auto'), z.number().int().positive()]).default('auto'),
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
         *  - `pypi-only`      — legacy value; rejected at sandbox creation rather than silently
         *                       allowing unrestricted outbound traffic.
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
}).transform(({ locale, ui_language, ...rest }) => ({
  locale: locale ?? ui_language ?? 'en',
  ...rest,
}));

export type XCompilerConfig = z.infer<typeof ConfigSchema>;

/**
 * 配置文件查找顺序（优先级从高到低）：
 *   1. 显式 --config / explicitPath
 *   2. 当前目录 ./config.yaml
 *   3. $XC_PATH/config.yaml            （安装/全局配置目录，默认 ~/.xc）
 *   4. 当前目录 ./config.example.yaml  （仓库 fallback）
 *   5. $XC_PATH/config.example.yaml
 */
export function getXCompilerPath(): string {
  const env = xcEnv('PATH');
  if (env && env.trim()) return path.resolve(env.trim());
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/root';
  return path.join(home, '.xc');
}

function defaultSearchPaths(): string[] {
  const xcompilerPath = getXCompilerPath();
  return [
    path.resolve('config.yaml'),
    path.join(xcompilerPath, 'config.yaml'),
    path.resolve('config.example.yaml'),
    path.join(xcompilerPath, 'config.example.yaml'),
  ];
}

export async function loadConfig(explicitPath?: string): Promise<XCompilerConfig> {
  const r = await loadConfigWithPath(explicitPath);
  return r.config;
}

export interface LoadedConfig {
  config: XCompilerConfig;
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
      `\nHint: set XC_PATH to point at a directory containing config.yaml, ` +
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
    console.warn(t().system.configEnvMissing([...missing].join(', ')));
  }
  return out;
}
