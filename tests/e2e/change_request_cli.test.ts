import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { ProjectGraphPersistenceService, materializeProjectGraph } from '../../src/application/planning/project_graph_persistence_service.js';
import type { Plan } from '../../src/domain/planning/execution_plan.js';
import { FilePlanStore } from '../../src/infrastructure/planning/file_plan_store.js';
import { DomainObjectRepository } from '../../src/infrastructure/repository/domain_object_repository.js';
import { ProjectContainer } from '../../src/workspace/project_container.js';
import { iterationPlan } from '../support/two_phase_plan.js';

const repository = path.resolve(__dirname, '..', '..');
let root: string;

beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-change-request-cli-'))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function cli(entry: string, ...args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, '--lang', 'en', ...args], {
      cwd: repository, env: { ...process.env, XC_PATH: path.join(root, 'installation'), XCOMPILER_PATH: path.join(root, 'installation') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function project() {
  const container = new ProjectContainer(path.join(root, 'project'));
  await container.canonical().workspace.ensure('.');
  const domain = new DomainObjectRepository(container.state);
  await domain.load();
  const plan: Plan = { ...iterationPlan('P1'), complexityAssessment: { level: 'simple', rationale: 'One iteration.',
    splitRecommended: false, userForcedPhaseSplit: false } };
  await new ProjectGraphPersistenceService(domain).persistGraph(
    materializeProjectGraph({ draft: plan, topic: 'Export signals.', projectName: 'signals' }));
  const planPath = container.control.abs('plan.P1.json');
  await new FilePlanStore().savePlan(planPath, plan);
  const config = YAML.parse(await fs.readFile(path.join(repository, 'config.example.yaml'), 'utf8')) as Record<string, unknown>;
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify(config));
  return { container, planPath, configPath };
}

describe('--change-request (real CLI process)', () => {
  it.each([
    ['xcompiler run', 'src/cli/xcompiler.ts', ['run']],
    ['xcompiler_run', 'src/cli/xcompiler_run.ts', []],
  ])('reaches the run through %s', async (_name, entry, command) => {
    const { container, planPath, configPath } = await project();
    const missing = path.join(root, 'no-such-change.yaml');
    const result = await cli(entry, ...command, planPath, '-w', container.root, '-c', configPath, '--dry-run', '--change-request', missing);
    // Exit 7 and this path: the option arrived, and the run read it before anything else.
    expect(result.output).toContain(missing);
    expect(result.code).toBe(7);
  }, 60_000);
});
