import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { beforeEach, describe, expect, it } from 'vitest';
import { DomainAttemptRunner, type AttemptInput } from '../src/application/execution/attempt_runner.js';
import type { Step } from '../src/domain/planning/execution_plan.js';
import { FileDebugWiki } from '../src/infrastructure/knowledge/file_debug_wiki.js';
import { GitService } from '../src/workspace/git.js';
import { moveIntoRuntimeTemp, workingChanges } from '../src/workspace/runtime_temp.js';
import { Workspace } from '../src/workspace/workspace.js';
import { singlePhaseRepository } from './support/domain_objects.js';
import { withFixtureExecutionRequests } from './support/execution_request_fixture.js';

/**
 * What running the product leaves in the working copy is set aside, never committed or deleted.
 *
 * A live functional-test Step committed the workbook its CLI wrote; the Phase gate's scenario then
 * overwrote that committed file in the canonical working copy, and every merge after it was refused.
 */
let workspace: Workspace;
let git: GitService;

beforeEach(async () => {
  workspace = new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-set-aside-')));
  git = new GitService(workspace);
  await git.ensureRepo();
  await workspace.writeFile('artifacts/signals.xlsx', 'committed workbook');
  await git.snapshot('init', 0, 'seed');
});

describe('moving run outputs into the runtime temp directory', () => {
  it('saves a changed committed file and restores it, and moves a new file, deleting nothing', async () => {
    await workspace.writeFile('artifacts/signals.xlsx', 'workbook the gate wrote');
    await workspace.writeFile('out/report.txt', 'new output');
    const changes = await workingChanges(git.raw());
    expect(changes).toEqual(expect.arrayContaining([
      { path: 'artifacts/signals.xlsx', tracked: true }, { path: 'out/report.txt', tracked: false },
    ]));

    await moveIntoRuntimeTemp(workspace, git.raw(), changes, '.xc-tmp/gates/P1-delivery/now');

    expect(await workspace.readFile('artifacts/signals.xlsx')).toBe('committed workbook');
    expect(await workspace.exists('out/report.txt')).toBe(false);
    expect(await workspace.readFile('.xc-tmp/gates/P1-delivery/now/artifacts/signals.xlsx')).toBe('workbook the gate wrote');
    expect(await workspace.readFile('.xc-tmp/gates/P1-delivery/now/out/report.txt')).toBe('new output');
    // The temp directory is ignored, so the working copy is clean again.
    expect(await workingChanges(git.raw())).toEqual([]);
  });
});

describe('an attempt whose run wrote outside its scope', () => {
  it('commits its own outputs and sets the rest aside', async () => {
    const step: Step = {
      id: 'S004', iterationId: 'P1', phase: 'CODE', title: 'CODE', description: 'CODE', systemPrompt: 'CODE',
      tools: ['write_file'], inputs: [], outputs: ['src/parser.py'], dependsOn: [], acceptance: 'Passes.', maxAttempts: 3,
    };
    const events: Array<Record<string, unknown>> = [];
    const runner = new DomainAttemptRunner(withFixtureExecutionRequests({
      workspace, git,
      sandbox: { kind: 'subprocess', runProgram: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) },
      router: {},
      repository: singlePhaseRepository(),
      audit: { event: async (_kind: string, _message: string, data: Record<string, unknown>) => { events.push(data); } },
      plugins: { size: 0 }, debugWiki: new FileDebugWiki(path.join(workspace.root, '.wiki')),
    } as never), 'python');
    const internals = runner as unknown as Record<string, unknown>;
    internals.recordTicketRevision = async () => {};
    internals.assembleContext = async () => ({ assembled: { text: '', debugWikiMatches: [] }, debugBrief: undefined });
    internals.rejectInvalidProjectContract = async () => undefined;
    internals.recordAssessment = async (_step: unknown, value: unknown) => ({ ...(value as object), passed: true });
    internals.failAttempt = async (_scope: unknown, _baseline: string, _input: unknown, failure: Record<string, unknown>) =>
      ({ ok: false, changedFiles: [], wikiEntryIds: [], testOutcomes: [], ...failure });
    internals.buildEnvironment = async () => ({
      baselineGateExecution: { mode: 'not-applicable', reason: 'fixture' },
      verificationScope: { testArgs: [], inheritedFromTicket: false },
      tools: [], context: {}, snippets: [], hints: [],
      executor: { run: async () => {
        await workspace.writeFile('src/parser.py', 'def run():\n    return 1\n');
        // What the product wrote when the Step ran it: outside every path this Step may write.
        await workspace.writeFile('artifacts/signals.xlsx', 'workbook the run wrote');
        return {
          success: true, rounds: 1, toolCalls: [],
          qualityAssessment: { completion: 1, upstreamAlignment: 1, metrics: {}, tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 }, evidence: ['ran'], gaps: [] },
          metrics: { rounds: 1, parseFailures: 0, repeatedTurns: 0, toolFailRatio: 0, progressRatio: 1, healthScore: 1, providers: [] },
        };
      } },
    });
    const outcome = await runner.run({
      plan: { language: 'python', requirementDigest: 'Parse input.', phaseId: 'P1',
        implementationPhases: [{ id: 'P1', title: 'Parser', objective: 'Parse input.', status: 'current', scope: ['parser'], deliverables: [], dependsOn: [] }], steps: [step] },
      executionStep: step, mode: 'normal',
      domainStep: { ...step, name: 'P1-S004', type: 'CODE', projectId: 'project-id', phaseId: 'phase-id', attempts: 1, agent: 'Developer' },
      ticket: { id: 'story-id', type: 'story', logIds: [], source: { correlationId: 'correlation-id' } },
    } as unknown as AttemptInput) as { ok: boolean };

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    const committed = await simpleGit(workspace.root).raw(['show', '--name-only', '--format=', 'HEAD']);
    expect(committed).toContain('src/parser.py');
    expect(committed).not.toContain('artifacts/signals.xlsx');
    expect(await workspace.readFile('artifacts/signals.xlsx')).toBe('committed workbook');
    expect(await workspace.readFile('.xc-tmp/steps/P1-S004/attempt-1/artifacts/signals.xlsx')).toBe('workbook the run wrote');
    expect(events).toContainEqual(expect.objectContaining({
      messageId: 'domain.run_outputs_set_aside', paths: ['artifacts/signals.xlsx'],
    }));
  });

  // A P2 CODE Step owns the P1 unit tests it inherited: updating one to the accepted contract is its
  // own work, committed with it, not a stray output set aside. Without a registered basis the same
  // change does not deliver: the write gate cannot see a change made by a program the Step ran.
  // An older registration of the same path is the third case: a basis covers what its write left, so
  // it cannot answer for whatever changed the file afterwards, while a retry of the same change can.
  const UPDATED = 'def test_header():\n    assert 19 == 19\n';
  const hashOf = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
  it.each([
    ['commits an inherited earlier-Phase test the Step updated under a registered basis', [{ path: 'tests/unit/test_cli.py', contentHash: hashOf(UPDATED) }], true],
    ['fails the attempt when an inherited test changed with no basis registered', [], false],
    ['fails the attempt when the registered basis covers other content of that test', [{ path: 'tests/unit/test_cli.py', contentHash: hashOf('assert True\n') }], false],
  ] as Array<[string, Array<{ path: string; contentHash: string }>, boolean]>)('%s', async (_name, bases, delivers) => {
    const step: Step = {
      id: 'S004', iterationId: 'P1', phase: 'CODE', title: 'CODE', description: 'CODE', systemPrompt: 'CODE',
      tools: ['write_file'], inputs: [], outputs: ['src/parser.py'], dependsOn: [], acceptance: 'Passes.', maxAttempts: 3,
    };
    const events: Array<Record<string, unknown>> = [];
    const runner = new DomainAttemptRunner(withFixtureExecutionRequests({
      workspace, git,
      sandbox: { kind: 'subprocess', runProgram: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }) },
      router: {},
      // A one-Phase Project: nothing earlier for this Step to inherit.
      repository: { list: async () => [], read: async (id: string) => ({
        'phase-id': { objectType: 'phase', id, name: 'P2', projectId: 'project-id', stepIds: [] },
        'p1-id': { objectType: 'phase', id, name: 'P1', projectId: 'project-id', stepIds: ['p1-code'] },
        'p1-code': { objectType: 'step', id, type: 'CODE', outputs: ['src/parser.py', 'tests/unit/test_cli.py'] },
        'story-id': { objectType: 'ticket', id, contractBases: bases },
      } as Record<string, unknown>)[id] ?? { objectType: 'project', id, name: 'parser', phaseIds: ['p1-id', 'phase-id'] } },
      audit: { event: async (_kind: string, _message: string, data: Record<string, unknown>) => { events.push(data); } },
      plugins: { size: 0 }, debugWiki: new FileDebugWiki(path.join(workspace.root, '.wiki')),
    } as never), 'python');
    const internals = runner as unknown as Record<string, unknown>;
    internals.recordTicketRevision = async () => {};
    internals.assembleContext = async () => ({ assembled: { text: '', debugWikiMatches: [] }, debugBrief: undefined });
    internals.rejectInvalidProjectContract = async () => undefined;
    internals.recordAssessment = async (_step: unknown, value: unknown) => ({ ...(value as object), passed: true });
    internals.failAttempt = async (_scope: unknown, _baseline: string, _input: unknown, failure: Record<string, unknown>) =>
      ({ ok: false, changedFiles: [], wikiEntryIds: [], testOutcomes: [], ...failure });
    internals.buildEnvironment = async () => ({
      baselineGateExecution: { mode: 'not-applicable', reason: 'fixture' },
      verificationScope: { testArgs: [], inheritedFromTicket: false },
      tools: [], context: {}, snippets: [], hints: [],
      executor: { run: async () => {
        await workspace.writeFile('src/parser.py', 'def run():\n    return 1\n');
        // What the product wrote when the Step ran it: outside every path this Step may write.
        await workspace.writeFile('tests/unit/test_cli.py', UPDATED);
        return {
          success: true, rounds: 1, toolCalls: [],
          qualityAssessment: { completion: 1, upstreamAlignment: 1, metrics: {}, tolerance: { failedTests: 0, skippedTests: 0, warnings: 0 }, evidence: ['ran'], gaps: [] },
          metrics: { rounds: 1, parseFailures: 0, repeatedTurns: 0, toolFailRatio: 0, progressRatio: 1, healthScore: 1, providers: [] },
        };
      } },
    });
    const outcome = await runner.run({
      plan: { language: 'python', requirementDigest: 'Parse input.', phaseId: 'P1',
        implementationPhases: [{ id: 'P1', title: 'Parser', objective: 'Parse input.', status: 'current', scope: ['parser'], deliverables: [], dependsOn: [] }], steps: [step] },
      executionStep: step, mode: 'normal',
      domainStep: { ...step, name: 'P1-S004', type: 'CODE', projectId: 'project-id', phaseId: 'phase-id', attempts: 1, agent: 'Developer' },
      ticket: { id: 'story-id', type: 'story', logIds: [], commits: [], source: { correlationId: 'correlation-id' } },
    } as unknown as AttemptInput) as { ok: boolean };

    if (!delivers) {
      expect(outcome).toMatchObject({ ok: false, failure: { category: 'quality', code: 'inherited_test_change_unregistered',
        details: { paths: ['tests/unit/test_cli.py'] } } });
      return;
    }
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    const committed = await simpleGit(workspace.root).raw(['show', '--name-only', '--format=', 'HEAD']);
    expect(committed).toContain('tests/unit/test_cli.py');
    expect(events.some((event) => event.messageId === 'domain.run_outputs_set_aside')).toBe(false);
  });
});

describe('the rules Runtime adds to .gitignore', () => {
  // The canonical branch moves only by XCompiler merges. Committing the rules there to unblock a merge
  // moved it under a merge already gated against the old head, and the run stopped on that instead;
  // the merge guard now puts Runtime's own rules back before it merges (see squash_merge.test.ts).
  async function olderProject(): Promise<{ ws: Workspace; service: GitService }> {
    const ws = new Workspace(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-ignore-rules-')));
    const service = new GitService(ws);
    await service.ensureRepo();
    const rules = (await ws.readFile('.gitignore')).split('\n').filter((line) => line !== '.xc-tmp/').join('\n');
    await ws.writeFile('.gitignore', rules);
    await simpleGit(ws.root).raw(['commit', '-am', 'rules of an older build']);
    return { ws, service };
  }

  it('appends them without moving the branch, which only XCompiler merges may move', async () => {
    const { ws, service } = await olderProject();
    await service.ensureRepo();
    expect(await ws.readFile('.gitignore')).toContain('.xc-tmp/');
    expect(await simpleGit(ws.root).raw(['log', '-1', '--format=%s'])).toBe('rules of an older build\n');
  });
});
