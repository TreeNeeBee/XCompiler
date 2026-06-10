import { beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlan } from '../src/agents/planner.js';
import { resolveCompileLanguage } from '../src/cli/compile.js';
import { loadIncrementalBaseline } from '../src/core/incremental.js';
import { renderPlanMarkdown } from '../src/core/render.js';
import { PlanSchema, type Step } from '../src/core/plan.js';
import { setLocale, t } from '../src/i18n/index.js';
import { Workspace } from '../src/workspace/workspace.js';

const baseStep = (over: Partial<Step> = {}): Step =>
  ({
    id: 'S001',
    phase: 'REQUIREMENT',
    title: 'Requirement',
    description: 'Capture the requirement.',
    systemPrompt: 'Document the requirement clearly.',
    role: 'Planner',
    tools: ['write_file'],
    inputs: [],
    outputs: ['docs/01-requirement.md'],
    dependsOn: [],
    acceptance: 'Requirement document is written.',
    maxRetries: 3,
    ...over,
  }) as Step;

describe('incremental development support', () => {
  beforeEach(() => setLocale('en'));

  it('summarizes an existing workspace baseline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-incremental-'));
    const ws = new Workspace(root);
    const plan = buildPlan(
      {
        requirementDigest: 'Add a reporting dashboard.',
        globalPrompt: 'Keep the CLI structure.',
        dependencies: ['vitest'],
        steps: [baseStep()],
      },
      {
        language: 'typescript',
        intent: 'feature',
        baselineSummary: 'Existing reporting service.',
      },
    );

    await ws.writeFile('plan.json', `${JSON.stringify(plan, null, 2)}\n`);
    await ws.writeFile('docs/topic.md', 'Current product manages invoices.');
    await ws.writeFile('package.json', JSON.stringify({
      name: 'sample-app',
      type: 'module',
      scripts: { test: 'vitest run', build: 'tsup' },
      dependencies: { zod: '^3.0.0' },
      devDependencies: { vitest: '^2.0.0' },
    }, null, 2));
    await ws.writeFile('src/main.ts', 'export const main = () => "ok";\n');
    await ws.writeFile('tests/main.test.ts', 'import { expect, test } from "vitest";\n');

    const baseline = await loadIncrementalBaseline(ws);

    expect(baseline.summary).toContain('## Existing plan summary');
    expect(baseline.summary).toContain('- language: typescript');
    expect(baseline.summary).toContain('- intent: feature');
    expect(baseline.summary).toContain('## Existing document: docs/topic.md');
    expect(baseline.summary).toContain('## Existing manifest: package.json');
    expect(baseline.summary).toContain('src/main.ts');
    expect(baseline.summary).toContain('tests/main.test.ts');
    expect(baseline.language).toBe('typescript');
    expect(baseline.languageSource).toBe('plan.json');
    expect(baseline.sources).toEqual(
      expect.arrayContaining(['plan.json', 'docs/topic.md', 'package.json', 'src/**', 'tests/**']),
    );
  });

  it('supports an explicit baseline plan outside the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-incremental-'));
    const ws = new Workspace(root);
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-external-plan-'));
    const externalPlanPath = path.join(externalDir, 'baseline-plan.json');
    const externalPlan = buildPlan(
      {
        requirementDigest: 'Stabilize the generated API.',
        globalPrompt: 'Preserve public behavior.',
        dependencies: ['pytest'],
        steps: [baseStep()],
      },
      {
        language: 'python',
        intent: 'refactor',
        baselineSummary: 'Original service baseline.',
      },
    );

    await fs.writeFile(externalPlanPath, `${JSON.stringify(externalPlan, null, 2)}\n`, 'utf8');

    const baseline = await loadIncrementalBaseline(ws, { planPath: externalPlanPath });

    expect(baseline.summary).toContain('## Existing plan summary');
    expect(baseline.summary).toContain('- intent: refactor');
    expect(baseline.language).toBe('python');
    expect(baseline.sources.some((source) => source.endsWith('baseline-plan.json'))).toBe(true);
  });

  it('strips previously embedded baseline blocks from topic.md when reloading baseline context', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-incremental-'));
    const ws = new Workspace(root);
    await ws.writeFile(
      'docs/topic.md',
      [
        '# Project Topic',
        '',
        '## Original requirement',
        '',
        'Add export support.',
        '',
        '## Existing project baseline',
        '',
        'Old generated baseline that must not recurse.',
      ].join('\n'),
    );

    const baseline = await loadIncrementalBaseline(ws);

    expect(baseline.summary).toContain('Add export support.');
    expect(baseline.summary).not.toContain('Old generated baseline that must not recurse.');
  });

  it('stores incremental metadata in the plan and renders it', () => {
    const plan = buildPlan(
      {
        requirementDigest: 'Add audit export support.',
        globalPrompt: 'Reuse the existing audit pipeline.',
        dependencies: ['vitest'],
        steps: [baseStep()],
      },
      {
        language: 'typescript',
        intent: 'feature',
        baselineSummary: 'Existing CLI already exports JSON reports.',
      },
    );

    const parsed = PlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
    expect(plan.intent).toBe('feature');
    expect(plan.baselineSummary).toContain('Existing CLI');

    const markdown = renderPlanMarkdown(plan);
    expect(markdown).toContain('- Intent: feature');
    expect(markdown).toContain(t().render.sectionBaselineSummary);
    expect(markdown).toContain('Existing CLI already exports JSON reports.');
  });

  it('prefers the baseline language during incremental compile resolution', () => {
    expect(resolveCompileLanguage('python', 'feature', { language: 'typescript' })).toBe('typescript');
    expect(resolveCompileLanguage('python', 'greenfield', { language: 'typescript' })).toBe('python');
  });
});
