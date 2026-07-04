import { beforeEach, describe, expect, it } from 'vitest';
import { getLanguageProfile } from '../src/core/language.js';
import { setLocale, t } from '../src/i18n/index.js';

describe('language-specific planner/executor prompts', () => {
  beforeEach(() => setLocale('en'));

  it('uses a dedicated TypeScript planner prompt instead of Python-first instructions', () => {
    const prompt = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('TypeScript / Node.js only');
    expect(prompt).not.toContain('Output language: Python only');
    expect(prompt).toContain('Exactly one ARCH Step must output `package.json`');
  });

  it('keeps REFACTOR aligned with source/test refactoring instead of docs-only purity', () => {
    const py = t().prompts.plannerSystem(getLanguageProfile('python'));
    const ts = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    expect(py).toContain('REFACTOR is the sole exception');
    expect(py).toContain('may also re-declare refactored src/tests files');
    expect(py).not.toContain('REQUIREMENT / ARCH / TASK / REFACTOR / DELIVERY outputs must NOT contain src/**/*.py');
    expect(ts).toContain('REFACTOR is the sole exception');
    expect(ts).toContain('may also re-declare refactored src/tests files');
    expect(ts).not.toContain('REQUIREMENT / ARCH / TASK / REFACTOR / DELIVERY outputs must NOT contain `src/**/*.ts`');
  });

  it('describes architecture sizing as adaptive rather than a fixed module formula', () => {
    const py = t().prompts.plannerSystem(getLanguageProfile('python'));
    const ts = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    expect(py).toContain('validator recomputes the exact minimum from topic/baseline/intent');
    expect(ts).toContain('validator recomputes the exact minimum from topic/baseline/intent');
    expect(py).not.toContain('max(4, surface count + 2)');
    expect(ts).not.toContain('max(4, surface count + 2)');

    setLocale('zh');
    const zh = t().prompts.plannerSystem(getLanguageProfile('python'));
    expect(zh).toContain('validator 会从 topic/baseline/intent 复算 exact minimum');
    expect(zh).not.toContain('max(4, 关注面数量 + 2)');
    expect(zh).not.toContain('最多 12');
  });

  it('requires the delivery documentation bundle and project type classification', () => {
    const py = t().prompts.plannerSystem(getLanguageProfile('python'));
    const ts = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    for (const prompt of [py, ts]) {
      expect(prompt).toContain('"projectType": "application | library | mixed"');
      expect(prompt).toContain('README.md');
      expect(prompt).toContain('docs/quickstart.md');
      expect(prompt).toContain('docs/api-guide.md');
      expect(prompt).toContain('active i18n language');
      expect(prompt).toContain('there is no CLI project-type override');
      expect(prompt).toContain('For `projectType="library"`, do not invent an application entrypoint');
    }

    setLocale('zh');
    const zh = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    expect(zh).toContain('"projectType": "application | library | mixed"');
    expect(zh).toContain('README.md');
    expect(zh).toContain('docs/quickstart.md');
    expect(zh).toContain('docs/api-guide.md');
    expect(zh).toContain('当前 i18n 语言');
    expect(zh).toContain('不存在命令行 project-type 覆盖');
    expect(zh).toContain('当 `projectType="library"` 时，不要为了满足入口规则而虚构应用入口');
  });

  it('requires macro Step subtasks and deferred implementation phases', () => {
    const py = t().prompts.plannerSystem(getLanguageProfile('python'));
    const ts = t().prompts.plannerSystem(getLanguageProfile('typescript'));
    for (const prompt of [py, ts]) {
      expect(prompt).toContain('Macro Step decomposition');
      expect(prompt).toContain('complete V-model macro plan covering the required phases');
      expect(prompt).toContain('CODE < TEST < DEBUG < REFACTOR');
      expect(prompt).toContain('subTasks');
      expect(prompt).toContain('complexityAssessment');
      expect(prompt).toContain('implementationPhases');
      expect(prompt).toContain('moderate => P1 current + at least P2 deferred');
      expect(prompt).toContain('complex => P1 current + at least P2/P3 deferred');
      expect(prompt).toContain('"status": "deferred"');
      expect(prompt).not.toContain('at least 7 Steps');
    }

    setLocale('zh');
    const zh = t().prompts.plannerSystem(getLanguageProfile('python'));
    expect(zh).toContain('宏 Step 拆分');
    expect(zh).toContain('完整 V 模型宏 Step 计划');
    expect(zh).toContain('CODE < TEST < DEBUG < REFACTOR');
    expect(zh).toContain('subTasks');
    expect(zh).toContain('implementationPhases');
    expect(zh).toContain('moderate 至少 P1 current + P2 deferred');
    expect(zh).toContain('complex 至少 P1 current + P2/P3 deferred');
    expect(zh).not.toContain('至少 7 个 Step');
  });

  it('provides a self-bootstrap override that preserves existing entrypoints and manifests', () => {
    const prompt = t().prompts.plannerSelfMode;
    expect(prompt).toContain('SELF-BOOTSTRAP OVERRIDE');
    expect(prompt).toContain('Do not create src/main.ts');
    expect(prompt).toContain('package.json');
  });

  it('uses a dedicated TypeScript executor prompt instead of Python import rules', () => {
    const prompt = t().prompts.executorSystem(getLanguageProfile('typescript'));
    expect(prompt).toContain('TypeScript / Node.js best practice');
    expect(prompt).toContain('ESM relative imports with explicit ".ts" specifiers');
    expect(prompt).toContain("Node's native TypeScript type stripping");
    expect(prompt).not.toContain('sys.path.insert');
  });

  it('keeps executor chunking guidance tied to runtime limits rather than fixed bytes', () => {
    const py = t().prompts.executorSystem(getLanguageProfile('python'));
    const ts = t().prompts.executorSystem(getLanguageProfile('typescript'));
    expect(py).toContain("current Step's runtime chunk limit");
    expect(ts).toContain("current Step's runtime chunk limit");
    expect(py).toContain('separate CODE/TEST/REFACTOR Steps');
    expect(ts).toContain('separate CODE/TEST/REFACTOR Steps');
    expect(py).not.toContain('6000 bytes');
    expect(ts).not.toContain('6000 bytes');
  });

  it('keeps Python-specific executor guidance for Python projects', () => {
    const prompt = t().prompts.executorSystem(getLanguageProfile('python'));
    expect(prompt).toContain('sys.path.insert');
    expect(prompt).toContain('The concatenated result must be valid Python');
  });

  it('requires a function-majority multi-dimensional clarification set', () => {
    const prompt = t().prompts.plannerClarify('Build a platform.', { complex: true });
    expect(prompt).toContain('8-10');
    expect(prompt).toContain('At least 5 function-focused questions');
    expect(prompt).toContain('At least one boundary question');
    expect(prompt).toContain('At least one quality question');
    expect(prompt).toContain('At least one extensibility question');
    expect(prompt).toContain('API library/SDK/package');
  });

  it('adds an explicit project-shape clarification when the topic is ambiguous', () => {
    const prompt = t().prompts.plannerClarify('Build an API for weather data.', {
      complex: true,
      projectShapeAmbiguous: true,
    });
    expect(prompt).toContain('Required for this topic');
    expect(prompt).toContain('API library vs runnable application vs mixed-deliverable');
  });

  it('keeps the same clarification dimensions in the Chinese prompt', () => {
    setLocale('zh');
    const prompt = t().prompts.plannerClarify('构建复杂业务平台', { complex: true });
    expect(prompt).toContain('8-10');
    expect(prompt).toContain('至少 5 个功能性问题');
    expect(prompt).toContain('至少 1 个 boundary');
    expect(prompt).toContain('至少 1 个 quality');
    expect(prompt).toContain('至少 1 个 extensibility');
    expect(prompt).toContain('API library/SDK/软件包');
    expect(prompt).toContain('可运行应用/CLI/服务');
  });
});
