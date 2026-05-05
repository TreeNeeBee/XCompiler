import { describe, it, expect } from 'vitest';
import { normalizePythonRequirements } from '../src/agents/planner.js';
import { sanitizeVenvName } from '../src/sandbox/subprocess.js';

describe('normalizePythonRequirements', () => {
  it('rewrites hallucinated CAN .dbc package names to cantools and strips version pins', () => {
    const out = normalizePythonRequirements(['pydbc==0.1.*', 'python-can==4.*']);
    expect(out).toContain('cantools');
    expect(out).toContain('python-can');
    // 版本锁定被剥离
    expect(out.some((r) => r.includes('=='))).toBe(false);
    // pytest 自动补齐
    expect(out.some((r) => /^pytest$/.test(r))).toBe(true);
  });

  it('strips markdown bullets / quotes / blank lines and dedupes', () => {
    const out = normalizePythonRequirements([
      '- pytest',
      '"requests==2.*"',
      '',
      'pytest',
      '# comment line',
    ]);
    expect(out.filter((r) => /^pytest$/.test(r))).toHaveLength(1);
    expect(out).toContain('requests');
    expect(out.some((r) => r.startsWith('#'))).toBe(false);
    expect(out.some((r) => r.includes('=='))).toBe(false);
  });

  it('always ensures pytest is present', () => {
    const out = normalizePythonRequirements(['requests']);
    expect(out.some((r) => /^pytest$/.test(r))).toBe(true);
  });

  it('strips PEP 440 version specifiers from arbitrary packages', () => {
    const out = normalizePythonRequirements([
      'cantools==4.3.*', // hallucinated version
      'pandas>=1.5,<2',
      'numpy~=1.26',
      'requests!=2.30',
    ]);
    expect(out).toEqual(expect.arrayContaining(['cantools', 'pandas', 'numpy', 'requests', 'pytest']));
    expect(out.some((r) => /[<>=!~]/.test(r))).toBe(false);
  });
});

describe('sanitizeVenvName', () => {
  it('keeps simple names untouched', () => {
    expect(sanitizeVenvName('myproject')).toBe('myproject');
    expect(sanitizeVenvName('my-proj_1.2')).toBe('my-proj_1.2');
  });
  it('replaces unsafe chars and trims hyphens', () => {
    expect(sanitizeVenvName('hello world!@#')).toBe('hello-world');
    expect(sanitizeVenvName('---')).toBe('venv');
    expect(sanitizeVenvName('')).toBe('venv');
  });
});
