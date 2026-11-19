import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StepExecutor } from '../../src/agents/executor.js';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { collectTestOutcomes, collectVerificationRuns } from '../../src/application/execution/test_outcome.js';
import type { Step } from '../../src/domain/planning/execution_plan.js';
import { SubprocessSandbox } from '../../src/sandbox/subprocess.js';
import { runTestsTool } from '../../src/tools/sandbox.js';
import { Workspace } from '../../src/workspace/workspace.js';

describe('test scope through the executor and real sandbox', () => {
  it.each([false, true])('requires a refused scope to stay corrected before completion (repeat=%s)', async repeat => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-test-scope-correction-'));
    try {
      const ws = new Workspace(root);
      const unit = 'tests/unit/pass.test.cjs';
      const integration = 'tests/integration/fail.test.cjs';
      await ws.writeFile('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
      await ws.writeFile(unit, "require('node:test')('unit', () => require('node:assert/strict').ok(true));\n");
      await fs.symlink(root, ws.abs('root-alias'), 'dir');
      const sandbox = new SubprocessSandbox({ ws, language: 'typescript', environmentRoot: path.join(root, 'environment'),
        limits: { cpu: 1, memory_mb: 256, wall_seconds: 20, network: 'off' } });
      const step: Step = { id: 'S004', iterationId: 'P1', phase: 'CODE', title: 'Correct verification request',
        description: 'Complete only after correcting misuse', systemPrompt: 'Verify the required gate.', tools: ['run_tests'],
        inputs: [], outputs: [], dependsOn: [], acceptance: 'Retain the test result', maxAttempts: 1 };
      let turn = 0;
      const result = await new StepExecutor({ maxRounds: 3, request: { name: 'scope-correction', async send() {
        turn++;
        return { provider: 'scope-correction', text: JSON.stringify(turn <= 2 ? { thoughts: 'Execute verification',
          actions: [{ tool: 'run_tests', args: { cwd: 'root-alias', args: [unit] } },
            ...(turn === 1 || repeat ? [{ tool: 'run_tests', args: { args: [integration] } }] : [])], done: false,
        } : { thoughts: 'Finish with the required scope', actions: [], done: true,
          qualityAssessment: { completion: 1, upstreamAlignment: 1, metrics: {},
            tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 }, evidence: ['Retained test receipts'],
            unavailableMetrics: [], gaps: [], blockedBy: [] } }) };
      } } }).run({ step, tools: [runTestsTool], ctx: { ws, sandbox, language: 'typescript', allowedWrites: [],
        stepId: step.id, testGateArgs: [unit] } });
      expect(result.success).toBe(!repeat);
      expect(result.toolCalls.filter(call => call.ok)).toHaveLength(1);
      expect(result.toolCalls.find(call => !call.ok)?.code).toBe('test_scope_not_allowed');
      expect(result.validationDefect).toBeUndefined();
      expect(collectVerificationRuns(result.toolCalls)).toEqual([{
        callId: result.toolCalls[0]!.callId, runner: 'vitest', cwd: '.', selectors: [unit], exitCode: 0,
      }]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(['fixed-gate', 'caller-scope', 'identical'] as const)('keeps the actual verdict and scope for %s', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-test-scope-'));
    try {
      const ws = new Workspace(root);
      const unit = 'tests/unit/pass.test.cjs';
      const integration = 'tests/integration/fail.test.cjs';
      await ws.writeFile('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
      await ws.writeFile(unit, "require('node:test')('unit', () => require('node:assert/strict').ok(true));\n");
      await ws.writeFile(integration, "require('node:test')('integration', () => require('node:assert/strict').fail('actual integration failure'));\n");
      const sandbox = new SubprocessSandbox({ ws, language: 'typescript', environmentRoot: path.join(root, 'environment'),
        limits: { cpu: 1, memory_mb: 256, wall_seconds: 20, network: 'off' } });
      expect((await sandbox.runTests([integration])).exitCode).toBe(1);
      const audit = new AuditLogger({ root, command: 'test-scope' });
      await audit.start();
      const step: Step = { id: 'S004', iterationId: 'P1', phase: 'CODE', title: 'Verify current code',
        description: 'Retain execution evidence', systemPrompt: 'Run the requested verification.', tools: ['run_tests'],
        inputs: [], outputs: [], dependsOn: [], acceptance: 'Retain the test result', maxAttempts: 1 };
      const result = await new StepExecutor({ maxRounds: 1, request: { name: 'deterministic-test',
        async send() { return { provider: 'deterministic-test', text: JSON.stringify({ thoughts: 'Run both requests',
          actions: [{ tool: 'run_tests', args: { args: [unit] } },
            { tool: 'run_tests', args: { args: [mode === 'identical' ? unit : integration] } }], done: false }) }; },
      } }).run({ step, tools: [runTestsTool], ctx: { ws, sandbox, language: 'typescript', allowedWrites: [],
        stepId: step.id, audit, testGateArgs: mode === 'fixed-gate' ? [unit] : undefined } });
      await audit.end();
      const records = (await fs.readFile(path.join(root, 'audit/audit.jsonl'), 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as AuditEvent);
      const reused = records.filter(event => event.messageId === 'audit.executor_redundant_test_gate_reused');
      if (mode === 'identical') {
        expect(result.toolCalls).toHaveLength(1);
        expect(reused).toHaveLength(1);
        expect(reused[0]!.data?.originalCallId).toBe(result.toolCalls[0]!.callId);
        expect(reused[0]!.message).toContain(unit);
      } else {
        expect(reused).toHaveLength(0);
        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolCalls[1]).toMatchObject({ ok: false, args: { args: [integration] } });
        if (mode === 'fixed-gate') {
          expect(result.toolCalls[1]!.code).toBe('test_scope_not_allowed');
          expect(result.toolCalls[1]!.data).toBeUndefined();
          expect(collectTestOutcomes(result.toolCalls, 'CODE')[1]!.status).toBe('incomplete');
        } else {
          expect(result.toolCalls[1]!.data).toMatchObject({ exitCode: 1, effectiveArgs: [integration] });
        }
        expect(result.success).toBe(false);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
