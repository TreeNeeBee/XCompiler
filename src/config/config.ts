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
  llm: z.object({
    default: z.string(),
    providers: z.record(z.string(), ProviderSchema),
    roles: z.record(z.string(), z.string()).default({}),
    /** 全局 fallback 链：当主 provider 调用报错时依次尝试 */
    fallbacks: z.array(z.string()).default([]),
    /** 可选：按角色指定 fallback 链（覆盖全局） */
    role_fallbacks: z.record(z.string(), z.array(z.string())).default({}),
  }),
  agent: z.object({
    language: z.literal('python'),
    max_steps: z.number().int().positive().default(50),
    max_debug_retries: z.number().int().positive().default(3),
    max_rounds_per_step: z.number().int().positive().default(6),
    max_debug_rounds_per_step: z.number().int().positive().optional(),
    max_edit_lines_per_step: z.number().int().positive().default(400),
    sandbox: z.enum(['subprocess', 'docker', 'firejail']).default('subprocess'),
    sandbox_limits: z
      .object({
        cpu: z.number().positive().default(1),
        memory_mb: z.number().int().positive().default(1024),
        wall_seconds: z.number().int().positive().default(60),
        network: z.enum(['off', 'pypi-only', 'full']).default('pypi-only'),
      })
      .default({
        cpu: 1,
        memory_mb: 1024,
        wall_seconds: 60,
        network: 'pypi-only',
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
  const tried: string[] = [];
  const candidates = explicitPath ? [path.resolve(explicitPath)] : defaultSearchPaths();
  for (const abs of candidates) {
    tried.push(abs);
    try {
      const raw = await fs.readFile(abs, 'utf8');
      const expanded = expandEnv(raw);
      const data = YAML.parse(expanded);
      return ConfigSchema.parse(data);
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
