import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { buildPlan } from '../../src/agents/planner.js';
import { DomainAttemptRunner } from '../../src/application/execution/attempt_runner.js';
import { ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { buildPhasePlanFromCurrentPlan } from '../../src/application/planning/phase_plan_files.js';
import { ProjectOrchestrator } from '../../src/application/project_management/orchestrator.js';
import * as projectReports from '../../src/application/reporting/project_report.js';
import { compileProjectGraph } from '../../src/domain/planning/compiler.js';
import {
  deliveryDocsForIteration,
  phaseDocForIteration,
  testPlanDocForIteration,
} from '../../src/domain/planning/document_contract.js';
import { ROLES, type Phase, type Step } from '../../src/domain/planning/execution_plan.js';
import { phaseDeliveryGate } from '../../src/domain/quality/delivery_gate.js';
import { FileDebugWiki } from '../../src/infrastructure/knowledge/file_debug_wiki.js';
import { FilePlanStore } from '../../src/infrastructure/planning/file_plan_store.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { runExecute } from '../../src/runtime/run.js';
import { silentRuntimeIO } from '../../src/runtime/io.js';
import { createSandbox } from '../../src/sandbox/factory.js';
import type { Sandbox } from '../../src/sandbox/types.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';

// Provider discovery and environment installation are outside these wiring tests. Individual
// cases below name the controlled workflow boundary; Runtime composition and file adapters remain real.
vi.mock('../../src/llm/preflight.js', () => ({
  preflightProviders: vi.fn(async () => ({
    zeroed: [], unreachable: [], revived: [], autoAdded: {}, tags: {},
  })),
}));
vi.mock('../../src/sandbox/factory.js', () => ({ createSandbox: vi.fn() }));

describe('Runtime initializes the configured knowledge store', () => {
  it('loads installation seeds and the container project tier through the real attempt runner', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-runtime-wiki-')));
    const envKeys = ['XC_PATH', 'XCOMPILER_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const previous = envKeys.map((key) => process.env[key]);
    try {
      // A removed injection must never fall back to writing into the checkout or a user's Wiki.
      process.env.XC_PATH = path.join(root, 'fallback-installation');
      process.env.XCOMPILER_PATH = process.env.XC_PATH;
      process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
      const container = new ProjectContainer(path.join(root, 'project'));
      const workspace = container.canonical().workspace;
      await workspace.ensure('.');
      const draft = runtimePlan();
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(compileProjectGraph({
        draft, topic: 'Deliver a small reporting utility.', projectName: 'runtime-wiki',
      }));
      const planPath = container.control.abs('plan.P1.json');
      await new FilePlanStore().savePlan(planPath, draft);
      const configPath = await writeConfig(root);
      const debugWikiPath = path.join(root, 'configured-installation', 'debug-wiki');
      const stop = new Error('Stop after real attempt initialization for the Wiki wiring test.');
      const unexpectedExecution = vi.fn(async (): Promise<never> => {
        throw new Error('This initialization test must not execute project work.');
      });
      const sandbox: Sandbox = {
        kind: 'subprocess',
        build: vi.fn(async () => ({ rebuilt: false, reason: 'Installation is outside this test.' })),
        exec: unexpectedExecution,
        runProgram: unexpectedExecution,
        runTests: unexpectedExecution,
        installDeps: unexpectedExecution,
      };
      vi.mocked(createSandbox).mockReturnValue(sandbox);
      const wikiLoad = vi.spyOn(FileDebugWiki.prototype, 'load');
      const originalInitialize = DomainAttemptRunner.prototype.initialize;
      const initialize = vi.spyOn(DomainAttemptRunner.prototype, 'initialize')
        .mockImplementation(async function (this: DomainAttemptRunner) {
          await originalInitialize.call(this);
          throw stop;
        });
      const run = vi.spyOn(DomainAttemptRunner.prototype, 'run').mockImplementation(unexpectedExecution);

      const result = await runExecute({
        workspace: container.root, planPath, configPath, debugWikiPath,
        io: silentRuntimeIO, recordReplayMode: 'off',
      });

      expect(result).toMatchObject({ status: 'error', exitCode: 5, message: stop.message });
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(wikiLoad).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      expect(unexpectedExecution).not.toHaveBeenCalled();
      const index = JSON.parse(await fs.readFile(path.join(debugWikiPath, 'index.json'), 'utf8')) as {
        version: number; root: string; layers: Record<string, { entries: number; writable: boolean }>;
      };
      expect(index).toMatchObject({ version: 2, root: debugWikiPath });
      for (const layer of ['system', 'agent']) {
        expect(index.layers[layer]?.entries).toBeGreaterThan(0);
        expect((await fs.readdir(path.join(debugWikiPath, 'wiki', layer))).length).toBeGreaterThan(0);
      }
      expect(index.layers.project).toMatchObject({ entries: 0, writable: true });
      expect(await fs.readdir(container.state.abs('debug-wiki/wiki/project'))).toEqual([]);
      expect(await fs.readFile(path.join(debugWikiPath, 'log.md'), 'utf8')).toContain('#');
      expect(await workspace.exists('.xcompiler/debug-wiki')).toBe(false);
      await expect(fs.stat(path.join(root, 'fallback-installation', '.xcompiler', 'debug-wiki')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.restoreAllMocks();
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('Runtime preserves the Phase checkpoint across orchestration outcomes', () => {
  it.each(['complete', 'failed'] as const)('persists the expected checkpoint for %s work', async (outcome) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-runtime-checkpoint-')));
    const envKeys = ['XC_PATH', 'XCOMPILER_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
    const previous = envKeys.map((key) => process.env[key]);
    try {
      process.env.XC_PATH = path.join(root, 'fallback-installation');
      process.env.XCOMPILER_PATH = process.env.XC_PATH;
      process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty-git-config');
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      await fs.writeFile(process.env.GIT_CONFIG_GLOBAL, '');
      const container = new ProjectContainer(path.join(root, 'project'));
      const workspace = container.canonical().workspace;
      await workspace.ensure('.');
      const plan = runtimePlan();
      const repository = new DomainObjectRepository(container.state);
      await repository.load();
      await new ProjectGraphPersistenceService(repository).persistGraph(compileProjectGraph({
        draft: plan, topic: 'Deliver a small reporting utility.', projectName: 'runtime-checkpoint',
      }));
      const planPath = container.control.abs('plan.P1.json');
      const phasePlanPath = container.control.abs('phasePlan.json');
      const store = new FilePlanStore();
      const checkpoint = buildPhasePlanFromCurrentPlan({ plan, phasePlanPath, currentPlanPath: planPath });
      await store.savePlan(planPath, plan);
      await store.savePhasePlan(phasePlanPath, checkpoint);
      const originalCheckpoint = await fs.readFile(phasePlanPath, 'utf8');
      const unexpectedExecution = vi.fn(async (): Promise<never> => {
        throw new Error('Checkpoint wiring must not execute project commands.');
      });
      vi.mocked(createSandbox).mockReturnValue({
        kind: 'subprocess',
        build: vi.fn(async () => ({ rebuilt: false, reason: 'Installation is outside this test.' })),
        exec: unexpectedExecution, runProgram: unexpectedExecution,
        runTests: unexpectedExecution, installDeps: unexpectedExecution,
      });
      // Supply the typed workflow outcome, then exercise real Runtime -> PhaseProgression -> store
      // wiring. This fixture does not claim that the Project's complete lifecycle has executed.
      const run = vi.spyOn(ProjectOrchestrator.prototype, 'run').mockImplementation(async (phaseId) => ({
        phaseId,
        totalSteps: 8,
        executedSteps: outcome === 'complete' ? 8 : 3,
        ...(outcome === 'failed' ? { failedStepId: 'S004', failureReason: 'Controlled workflow failure.' } : {}),
      }));
      const stop = new Error('Stop at report generation after the checkpoint boundary.');
      const report = vi.spyOn(projectReports, 'generateProjectDevelopmentReport').mockRejectedValue(stop);

      const result = await runExecute({
        workspace: container.root, planPath: phasePlanPath, configPath: await writeConfig(root),
        debugWikiPath: path.join(root, 'configured-installation', 'debug-wiki'),
        io: silentRuntimeIO, recordReplayMode: 'off',
      });

      expect(run).toHaveBeenCalledTimes(1);
      expect(unexpectedExecution).not.toHaveBeenCalled();
      const restored = await new FilePlanStore().loadPhasePlan(phasePlanPath);
      const events = (await container.state.readFile('audit/audit.jsonl')).trim().split('\n')
        .map((line) => JSON.parse(line) as { messageId?: string });
      const completions = events.filter((event) => event.messageId === 'execute.phase_completed');
      if (outcome === 'complete') {
        expect(result).toMatchObject({ status: 'error', exitCode: 5, message: stop.message });
        expect(report).toHaveBeenCalledTimes(1);
        expect(restored.phases.map((phase) => [phase.id, phase.status])).toEqual([['P1', 'complete']]);
        expect(completions).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ status: 'failed', exitCode: 4, engine: { failedStepId: 'S004' } });
        expect(report).not.toHaveBeenCalled();
        expect(restored).toEqual(checkpoint);
        expect(await fs.readFile(phasePlanPath, 'utf8')).toBe(originalCheckpoint);
        expect(completions).toEqual([]);
      }
      expect(await workspace.exists('phasePlan.json')).toBe(false);
      expect(await workspace.exists('plan.P1.json')).toBe(false);
    } finally {
      vi.restoreAllMocks();
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function writeConfig(root: string): Promise<string> {
  const config = YAML.parse(await fs.readFile(path.resolve('config.example.yaml'), 'utf8')) as {
    llm: { providers: Record<string, unknown>; roles: Record<string, string[]> };
  };
  config.llm.providers = {
    local: {
      type: 'openai', api_key: '', base_url: 'http://127.0.0.1:1/v1', model: 'initialization-only',
      context_window: '128K', connect_timeout_ms: 1_000, request_timeout_ms: 1_000,
      stream_first_token_timeout_ms: 1_000, stream_idle_timeout_ms: 1_000,
    },
  };
  config.llm.roles = Object.fromEntries(ROLES.map((role) => [role, ['local']]));
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify(config));
  return configPath;
}

function runtimePlan() {
  const iterationId = 'P1';
  const baseline = (kind: string) => `tests/test_${kind}_p1.py`;
  const doc = (phase: Phase) => phaseDocForIteration(phase, iterationId)!;
  const testPlan = (phase: Phase) => testPlanDocForIteration(phase, iterationId)!;
  const specifications: Array<{ phase: Phase; role: Step['role']; outputs: string[]; inputs?: string[] }> = [
    { phase: 'REQUIREMENT_ANALYSIS', role: 'Planner', outputs: [doc('REQUIREMENT_ANALYSIS'), testPlan('FUNCTIONAL_TEST'), baseline('functional')] },
    { phase: 'HIGH_LEVEL_DESIGN', role: 'Architect', outputs: [doc('HIGH_LEVEL_DESIGN'), testPlan('MODULE_TEST'), baseline('module')] },
    { phase: 'DETAILED_DESIGN', role: 'Architect', outputs: [doc('DETAILED_DESIGN'), testPlan('INTEGRATION_TEST'), baseline('integration')] },
    { phase: 'CODE', role: 'Coder', outputs: ['src/main.py', testPlan('UNIT_TEST'), baseline('unit')] },
    { phase: 'UNIT_TEST', role: 'Tester', outputs: [doc('UNIT_TEST')], inputs: [baseline('unit')] },
    { phase: 'INTEGRATION_TEST', role: 'Tester', outputs: [doc('INTEGRATION_TEST')], inputs: [baseline('integration')] },
    { phase: 'MODULE_TEST', role: 'Tester', outputs: [doc('MODULE_TEST')], inputs: [baseline('module')] },
    { phase: 'FUNCTIONAL_TEST', role: 'Tester', outputs: [...deliveryDocsForIteration('application', iterationId)], inputs: [baseline('functional')] },
  ];
  return buildPlan({
    requirementDigest: 'Deliver a small reporting utility.',
    globalPrompt: 'Preserve the utility contract.',
    projectType: 'application',
    complexityAssessment: {
      level: 'simple', rationale: 'One utility iteration.', splitRecommended: false, userForcedPhaseSplit: false,
    },
    implementationPhases: [{
      id: iterationId, title: 'Core', objective: 'Deliver the utility.', status: 'current',
      scope: ['Core utility'], deliverables: ['Working utility'], dependsOn: [],
      verificationGate: {
        summary: 'The utility runs.', checks: ['python -m pytest'], failurePolicy: 'Return findings to the owner.',
      },
      deliveryGate: {
        ...phaseDeliveryGate(iterationId),
        scenarios: [{
          name: 'primary-flow', description: 'Run the utility.', operation: 'Execute the utility.',
          environment: 'live', expected: 'The command succeeds.',
          execution: { command: 'python', args: ['src/main.py'] },
        }],
      },
    }],
    dependencies: ['pytest'],
    steps: specifications.map((specification, index) => ({
      ...specification,
      id: `S${String(index + 1).padStart(3, '0')}`, iterationId,
      title: `${specification.phase} deliverables`, description: `Complete ${specification.phase}.`,
      systemPrompt: 'Complete this Step scope and verify its owned deliverables.', tools: [],
      inputs: specification.inputs ?? [],
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: 'The declared deliverables pass their checks.', maxAttempts: 3,
    })),
  }, { language: 'python', intent: 'feature' });
}
