import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Plan } from '../src/core/plan.js';
import {
  buildProjectProgress,
  defaultProjectFilePath,
  findProjectFile,
  loadXCompilerProject,
  updateProjectFile,
  XCOMPILER_PROJECT_KIND,
} from '../src/core/project_file.js';

describe('XCompiler project file', () => {
  it('creates a workspace-local XXX.xc file with resumable paths and progress', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
    const plan = samplePlan([
      ['S001', 'DONE'],
      ['S002', 'RUNNING'],
      ['S003', 'PENDING'],
    ]);
    const projectFile = await updateProjectFile({
      workspace,
      planPath: path.join(workspace, 'plan.json'),
      configPath: path.join(workspace, 'config.yaml'),
      command: 'build',
      intent: 'feature',
      plan,
      requirementFile: path.join(workspace, 'feature.md'),
      recordHistory: true,
    });

    expect(projectFile).toBe(defaultProjectFilePath(workspace));
    expect(projectFile.endsWith('.xc')).toBe(true);
    const loaded = await loadXCompilerProject(projectFile);
    expect(loaded.data.kind).toBe(XCOMPILER_PROJECT_KIND);
    expect(loaded.workspace).toBe(path.resolve(workspace));
    expect(loaded.planPath).toBe(path.join(workspace, 'plan.json'));
    expect(loaded.configPath).toBe(path.join(workspace, 'config.yaml'));
    expect(loaded.data.progress?.status).toBe('running');
    expect(loaded.data.progress?.currentStepId).toBe('S002');
    expect(loaded.data.progress?.done).toBe(1);
    expect(loaded.data.history).toHaveLength(1);
    expect(loaded.data.history[0]?.command).toBe('build');
  });

  it('does not auto-discover legacy .toaa project files', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
    await fs.writeFile(path.join(workspace, 'legacy.toaa'), JSON.stringify({
      kind: XCOMPILER_PROJECT_KIND,
      version: '1',
      name: 'legacy',
      workspace: '.',
      planPath: 'plan.json',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [],
    }));

    expect(await findProjectFile(workspace)).toBeUndefined();
    await expect(loadXCompilerProject(path.join(workspace, 'legacy.toaa'))).rejects.toThrow(/\.xc/);
  });

  it('rejects legacy toaa.project payloads', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
    const legacy = path.join(workspace, 'legacy.xc');
    await fs.writeFile(legacy, JSON.stringify({
      kind: 'toaa.project',
      version: '1',
      name: 'legacy',
      workspace: '.',
      planPath: 'plan.json',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [],
    }));

    await expect(loadXCompilerProject(legacy)).rejects.toThrow();
  });

  it('marks a failed plan as failed and records the failed step id', () => {
    const progress = buildProjectProgress(samplePlan([
      ['S001', 'DONE'],
      ['S002', 'FAILED'],
      ['S003', 'PENDING'],
    ]));

    expect(progress.status).toBe('failed');
    expect(progress.failedStepId).toBe('S002');
    expect(progress.percent).toBe(33);
  });

  it('stores the workspace as an absolute path in the .xc file', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
    const projectFile = await updateProjectFile({
      workspace,
      planPath: path.join(workspace, 'plan.json'),
      command: 'build',
      plan: samplePlan([['S001', 'DONE']]),
    });
    const raw = JSON.parse(await fs.readFile(projectFile, 'utf8')) as { workspace: string };
    expect(path.isAbsolute(raw.workspace)).toBe(true);
    expect(raw.workspace).toBe(path.resolve(workspace));
  });

  it('rejects a stale workspace path that no longer exists', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
    const projectFile = path.join(workspace, 'stale.xc');
    await fs.writeFile(projectFile, JSON.stringify(projectFilePayload(path.join(workspace, 'moved-away'))));

    await expect(loadXCompilerProject(projectFile)).rejects.toThrow(/does not exist/);
  });

  it('rejects a workspace that does not contain the project file (write-leak guard)', async () => {
    const wsA = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-a-'));
    const wsB = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-b-'));
    const projectFile = path.join(wsA, 'leak.xc');
    await fs.writeFile(projectFile, JSON.stringify(projectFilePayload(wsB)));

    await expect(loadXCompilerProject(projectFile)).rejects.toThrow(/not inside its declared workspace/);
  });

  it('rejects a workspace without write permission (permission mismatch guard)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-project-file-'));
    const projectFile = path.join(workspace, 'readonly.xc');
    await fs.writeFile(projectFile, JSON.stringify(projectFilePayload(workspace)));
    await fs.chmod(workspace, 0o555);
    try {
      await expect(loadXCompilerProject(projectFile)).rejects.toThrow(/not writable/);
    } finally {
      await fs.chmod(workspace, 0o755);
    }
  });
});

function projectFilePayload(workspace: string): Record<string, unknown> {
  return {
    kind: XCOMPILER_PROJECT_KIND,
    version: '1',
    name: 'sample',
    workspace,
    planPath: 'plan.json',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [],
  };
}

function samplePlan(statuses: Array<[string, Plan['steps'][number]['status']]>): Plan {
  return {
    version: '1',
    language: 'python',
    intent: 'feature',
    projectType: 'application',
    requirementDigest: 'sample',
    globalPrompt: '',
    baselineSummary: '',
    dependencies: ['pytest'],
    userAddenda: '',
    createdAt: '2026-06-30T00:00:00.000Z',
    steps: statuses.map(([id, status], index) => ({
      id,
      phase: index === 0 ? 'REQUIREMENT_ANALYSIS' : index === 1 ? 'CODE' : 'UNIT_TEST',
      title: `Step ${id}`,
      description: `Description for ${id}`,
      systemPrompt: `Prompt for ${id}`,
      role: index === 0 ? 'Planner' : index === 1 ? 'Coder' : 'Tester',
      tools: [],
      inputs: [],
      outputs: [`docs/${id}.md`],
      dependsOn: index === 0 ? [] : [statuses[index - 1]![0]],
      acceptance: `Acceptance for ${id}`,
      status,
      retries: status === 'FAILED' ? 2 : 0,
      maxRetries: 3,
    })),
  };
}
