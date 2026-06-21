import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { getLanguageProfile } from '../src/core/language.js';
import { runProjectAudit, shouldRunProjectAudit } from '../src/core/project_audit.js';
import type { Plan } from '../src/core/plan.js';
import type { ExecExtra, ExecResult, Sandbox } from '../src/sandbox/types.js';

class FakeSandbox implements Sandbox {
  readonly kind = 'subprocess' as const;
  constructor(
    private readonly handlers: Partial<Record<'exec' | 'runProgram' | 'runTests', ExecResult>>,
  ) {}
  async build(): Promise<{ rebuilt: boolean; reason: string }> {
    return { rebuilt: false, reason: 'stubbed' };
  }
  async exec(_cmd: string, _argv: string[], _extra?: ExecExtra): Promise<ExecResult> {
    return this.handlers.exec ?? okResult();
  }
  async runProgram(_args: string[], _extra?: ExecExtra): Promise<ExecResult> {
    return this.handlers.runProgram ?? okResult();
  }
  async runTests(_args?: string[], _extra?: ExecExtra): Promise<ExecResult> {
    return this.handlers.runTests ?? okResult();
  }
  async installDeps(): Promise<ExecResult> {
    return okResult();
  }
}

function okResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 1,
    ...overrides,
  };
}

function tsPlan(): Plan {
  return {
    version: '1',
    language: 'typescript',
    intent: 'feature',
    requirementDigest: 'demo',
    globalPrompt: '',
    baselineSummary: '',
    userAddenda: '',
    dependencies: ['zod'],
    createdAt: new Date().toISOString(),
    steps: [],
  };
}

describe('project quality audit', () => {
  it('skips final audit for partial executions', () => {
    const plan = {
      ...tsPlan(),
      steps: [
        { id: 'S001', phase: 'REQUIREMENT', title: 'a', description: 'a', systemPrompt: 'x'.repeat(30), role: 'Planner', tools: [], inputs: [], outputs: ['docs/01-requirement.md'], dependsOn: [], acceptance: 'ok', status: 'DONE', retries: 0, maxRetries: 3 },
        { id: 'S002', phase: 'DELIVERY', title: 'b', description: 'b', systemPrompt: 'x'.repeat(30), role: 'Planner', tools: [], inputs: [], outputs: ['docs/05-delivery.md'], dependsOn: ['S001'], acceptance: 'ok', status: 'SKIPPED', retries: 0, maxRetries: 3 },
      ],
    } as Plan;
    expect(shouldRunProjectAudit(plan, { onlyPhase: 'CODE' })).toBe(false);
    expect(shouldRunProjectAudit(plan, { onlyPhase: undefined })).toBe(false);
    plan.steps[1]!.status = 'DONE';
    expect(shouldRunProjectAudit(plan, { onlyPhase: undefined })).toBe(true);
  });

  it('passes when tests, entrypoint, build and lint succeed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-audit-'));
    const ws = new Workspace(root);
    await ws.writeFile('docs/05-delivery.md', 'delivery');
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json', lint: 'eslint .' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ exec: okResult(), runProgram: okResult(), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it('fails a Python project that has no runnable entrypoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-audit-'));
    const ws = new Workspace(root);
    await ws.writeFile('docs/05-delivery.md', 'delivery');
    await ws.writeFile('tests/test_app.py', 'def test_ok(): assert True\n');
    const plan = { ...tsPlan(), language: 'python' as const };

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ runTests: okResult() }),
      plan,
      profile: getLanguageProfile('python'),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'entrypoint', severity: 'error', ok: false,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'test-files', severity: 'info', ok: true,
    }));
  });

  it('warns when TypeScript project has no build or lint script', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-audit-'));
    const ws = new Workspace(root);
    await ws.writeFile('docs/05-delivery.md', 'delivery');
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({ runProgram: okResult(), runTests: okResult() }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toBe(2);
    expect(result.checks.some((check) => check.name === 'build-script' && !check.ok)).toBe(true);
    expect(result.checks.some((check) => check.name === 'lint-script' && !check.ok)).toBe(true);
  });

  it('fails when the build audit fails after execution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-audit-'));
    const ws = new Workspace(root);
    await ws.writeFile('docs/05-delivery.md', 'delivery');
    await ws.writeFile('src/main.ts', 'export function main() {}\n');
    await ws.writeFile('tests/main.test.ts', 'import { describe, it, expect } from "vitest";\n');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'audit-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsc -p tsconfig.json' },
    }, null, 2));

    const result = await runProjectAudit({
      ws,
      sandbox: new FakeSandbox({
        runProgram: okResult(),
        runTests: okResult(),
        exec: okResult({ exitCode: 1, stderr: 'build failed' }),
      }),
      plan: tsPlan(),
      profile: getLanguageProfile('typescript'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.checks.some((check) => check.name === 'build' && !check.ok)).toBe(true);
  });
});
