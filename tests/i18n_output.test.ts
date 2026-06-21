import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tFor } from '../src/i18n/index.js';

describe('user-visible output i18n catalog', () => {
  it('provides localized Coder/Debugger model advice', () => {
    const en = tFor('en').llm.coderDebuggerSameModel('qwen', 'code', 'debug');
    const zh = tFor('zh').llm.coderDebuggerSameModel('qwen', 'code', 'debug');
    expect(en).toContain('Prefer different models');
    expect(zh).toContain('建议配置不同模型');
    expect(en).not.toBe(zh);
  });

  it('localizes audit templates and score-file headers', () => {
    expect(tFor('en').audit.toolDenied('write_file')).toBe('denied tool write_file');
    expect(tFor('zh').audit.toolDenied('write_file')).toBe('拒绝调用工具 write_file');
    expect(tFor('en').llm.scoreFileHeader).toContain('score snapshot');
    expect(tFor('zh').llm.scoreFileHeader).toContain('评分快照');
  });

  it('localizes interactive Gate 1 labels and sandbox failures', async () => {
    expect(tFor('en').compile.gate1Confirm).not.toBe(tFor('zh').compile.gate1Confirm);
    expect(tFor('en').system.unsupportedPypiOnlyNetwork).toContain('pypi-only');
    expect(tFor('zh').system.unsupportedPypiOnlyNetwork).toContain('pypi-only');

    const source = await fs.readFile(new URL('../src/cli/compile.ts', import.meta.url), 'utf8');
    expect(source).toContain('message: M.compile.gate1Confirm');
    expect(source).not.toContain("message: '需求是否符合预期?'");
  });
});
