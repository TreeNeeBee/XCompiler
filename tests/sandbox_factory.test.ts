import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Workspace } from '../src/workspace/workspace.js';
import { createSandbox, isRunningInContainer } from '../src/sandbox/factory.js';
import { SubprocessSandbox } from '../src/sandbox/subprocess.js';
import type { ToaaConfig } from '../src/config/config.js';

const baseCfg = (sandbox: 'subprocess' | 'docker'): ToaaConfig =>
  ({
    llm: { default: 'ollama_code', providers: {}, roles: {}, fallbacks: [] },
    agent: {
      language: 'python',
      max_steps: 10,
      max_rounds_per_step: 6,
      max_debug_retries: 3,
      max_edit_lines_per_step: 400,
      sandbox,
      sandbox_limits: { cpu: 1, memory_mb: 512, wall_seconds: 60, network: 'pypi-only' },
      sandbox_docker: { image: 'python:3.11-slim', workdir: '/workspace', pull: false, docker_bin: 'docker', extra_run_args: [] },
    },
  }) as unknown as ToaaConfig;

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.TOAA_IN_CONTAINER;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.TOAA_IN_CONTAINER;
  else process.env.TOAA_IN_CONTAINER = savedEnv;
});

describe('sandbox factory — container detection', () => {
  it('TOAA_IN_CONTAINER=1 强制识别为容器', () => {
    process.env.TOAA_IN_CONTAINER = '1';
    expect(isRunningInContainer()).toBe(true);
  });

  it('TOAA_IN_CONTAINER=0 强制识别为宿主', () => {
    process.env.TOAA_IN_CONTAINER = '0';
    expect(isRunningInContainer()).toBe(false);
  });

  it('容器内创建 sandbox=docker 时抛出引导性错误', () => {
    process.env.TOAA_IN_CONTAINER = '1';
    const ws = new Workspace('/tmp/toaa-factory-test');
    expect(() => createSandbox(baseCfg('docker'), ws)).toThrowError(/sandbox=docker/);
    expect(() => createSandbox(baseCfg('docker'), ws)).toThrowError(/subprocess/);
  });

  it('容器内 sandbox=subprocess 正常返回 SubprocessSandbox', () => {
    process.env.TOAA_IN_CONTAINER = '1';
    const ws = new Workspace('/tmp/toaa-factory-test');
    const sb = createSandbox(baseCfg('subprocess'), ws);
    expect(sb).toBeInstanceOf(SubprocessSandbox);
  });

  it('宿主上 sandbox=docker 正常实例化（不抛错）', () => {
    process.env.TOAA_IN_CONTAINER = '0';
    const ws = new Workspace('/tmp/toaa-factory-test');
    expect(() => createSandbox(baseCfg('docker'), ws)).not.toThrow();
  });
});
