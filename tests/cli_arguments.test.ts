import { describe, expect, it } from 'vitest';
import {
  localeFromArgv,
  parseIntent,
  parseLocale,
  parseNonNegativeInteger,
  parsePhase,
  parseStepId,
} from '../src/cli/arguments.js';

describe('CLI argument validation', () => {
  it('normalizes supported enum arguments', () => {
    expect(parseLocale('CN')).toBe('zh');
    expect(parseIntent('FEATURE')).toBe('feature');
    expect(parsePhase('test')).toBe('TEST');
    expect(parseStepId('s007')).toBe('S007');
    expect(parseNonNegativeInteger('0')).toBe(0);
  });

  it('rejects invalid values before command execution', () => {
    expect(() => parseLocale('jp')).toThrow(/Unsupported|不支持/);
    expect(() => parseIntent('patch')).toThrow(/intent/);
    expect(() => parsePhase('BUILD')).toThrow(/phase|阶段/);
    expect(() => parseStepId('7')).toThrow(/Step ID/);
    expect(() => parseNonNegativeInteger('-1')).toThrow(/integer|整数/);
  });

  it('finds locale flags early enough to translate help', () => {
    expect(localeFromArgv(['node', 'toaa', 'run', '--lang', 'CN', '--help'])).toBe('CN');
    expect(localeFromArgv(['node', 'toaa', '--lang=EN', '--help'])).toBe('EN');
  });
});
