import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { formatPlannerValidationFeedback } from '../src/agents/planning/validation_retry.js';
import { renderExecutionFeedback } from '../src/agents/execution/feedback_renderer.js';
import { injectSrcBootstrap } from '../src/application/execution/entry_gate.js';
import { renderFileManifest } from '../src/application/workspace/file_manifest.js';
import { setLocale, setPromptTranslation, tFor } from '../src/i18n/index.js';
import { renderRules } from '../src/runtime/rule_maintenance.js';
import { EditGuard } from '../src/tools/guard.js';
import { buildDefaultRegistry } from '../src/tools/index.js';
import { Workspace } from '../src/workspace/workspace.js';

const HAN = /[一-鿿]/u;

afterEach(() => {
  setPromptTranslation(false);
  setLocale('en');
});

/** A Chinese user, with prompt translation off (models read Chinese) or on (models read English). */
function chineseUser(translate: boolean) {
  setLocale('zh');
  setPromptTranslation(translate);
}

describe('text models read follows the prompt language', () => {
  it('describes every built-in tool in the prompt language', () => {
    chineseUser(true);
    const tools = buildDefaultRegistry().list();
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.filter((tool) => HAN.test(tool.description)).map((tool) => tool.name)).toEqual([]);
    chineseUser(false);
    expect(buildDefaultRegistry().list().find((tool) => tool.name === 'write_file')!.description)
      .toBe(tFor('zh').tools.writeFile.description);
  });

  it('keeps a write tool EditGuard wrapped earlier describing itself in the current prompt language', () => {
    const writeFile = buildDefaultRegistry().list().find((tool) => tool.name === 'write_file')!;
    const wrapped = new EditGuard({ ws: new Workspace(os.tmpdir()), stepId: 'S001', maxLines: 10 }).wrap(writeFile);
    chineseUser(false);
    expect(wrapped.description).toBe(tFor('zh').tools.writeFile.description);
    chineseUser(true);
    expect(wrapped.description).toBe(tFor('en').tools.writeFile.description);
  });

  it('corrects the planner in the prompt language', () => {
    chineseUser(true);
    expect(formatPlannerValidationFeedback(new Error('bad'))).toBe(tFor('en').prompts.plannerValidationFeedback('bad'));
    chineseUser(false);
    expect(formatPlannerValidationFeedback(new Error('bad'))).toBe(tFor('zh').prompts.plannerValidationFeedback('bad'));
  });

  it('reports tool results to the Executor in the prompt language', () => {
    chineseUser(true);
    const feedback = renderExecutionFeedback([], { ok: true, missing: [] }, { declaredDone: false, actionCount: 0 });
    expect(feedback.startsWith(tFor('en').prompts.executorFeedbackHeader)).toBe(true);
  });

  it('renders a request\'s Rule block in its prompt language, naming the user\'s language for deliverables', async () => {
    const block = await renderRules({ role: 'project-manager', work: 'plan.clarify' }, 'en', undefined, 'zh');
    expect(block).toContain('deliverables (documents, reports and commit messages) in Simplified Chinese');
  });
});

describe('text written into the generated project follows the user\'s language', () => {
  it('writes the sys.path bootstrap comments in the user\'s language, even with prompt translation on', () => {
    chineseUser(true);
    const zh = injectSrcBootstrap('from src.app import main\n');
    expect(zh).toContain(`# ${tFor('zh').generated.pathBootstrap[0]}`);
    setLocale('en');
    expect(injectSrcBootstrap('from src.app import main\n')).toContain(`# ${tFor('en').generated.pathBootstrap[0]}`);
  });

  it('writes the file manifest heading and labels in the user\'s language', () => {
    chineseUser(true);
    expect(renderFileManifest([])).toContain(tFor('zh').generated.fileManifest.heading);
    setLocale('en');
    expect(renderFileManifest([])).toContain('## File manifest');
  });
});
