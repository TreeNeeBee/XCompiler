import { describe, expect, it, vi } from 'vitest';
import { normaliseLocale, UnsupportedLocaleError } from '../src/i18n/index.js';
import { languageName, LOCALES, LocaleSchema } from '../src/domain/locale.js';
import {
  localeFromArgv,
  startupLocale,
  parseIntent,
  parseLocale,
  parseNonNegativeInteger,
} from '../src/cli/arguments.js';

describe('CLI argument validation', () => {
  it('normalizes supported enum arguments', () => {
    expect(parseLocale('CN')).toBe('zh');
    expect(parseIntent('FEATURE')).toBe('feature');
    expect(parseNonNegativeInteger('0')).toBe(0);
  });

  it('rejects invalid values before command execution', () => {
    expect(() => parseLocale('jp')).toThrow(/Unsupported|不支持/);
    expect(() => parseIntent('patch')).toThrow(/intent/);
    expect(() => parseNonNegativeInteger('-1')).toThrow(/integer|整数/);
  });

  // A language XCompiler does not speak used to become English without a word, so a mistyped or
  // not-yet-supported language looked like a working setting.
  it('refuses a language it does not speak instead of falling back to English', () => {
    expect(() => normaliseLocale('ja')).toThrow(UnsupportedLocaleError);
    expect(() => normaliseLocale('ja')).toThrow(/supported: EN, CN/u);
    expect(normaliseLocale('zh-CN')).toBe('zh');
    expect(() => parseLocale('jp')).toThrow(/one of: EN, CN/u);
  });

  it('starts in the requested language, and reports an XC_LANG it cannot honour', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(startupLocale(['node', 'xcompiler', '--lang', 'CN'], 'en')).toBe('zh');
      expect(startupLocale(['node', 'xcompiler'], 'CN')).toBe('zh');
      expect(startupLocale(['node', 'xcompiler'], undefined)).toBe('en');
      expect(errors).not.toHaveBeenCalled();
      // The option parser refuses an unknown --lang itself, with its own message.
      expect(startupLocale(['node', 'xcompiler', '--lang', 'ja'], undefined)).toBe('en');
      expect(errors).not.toHaveBeenCalled();
      expect(startupLocale(['node', 'xcompiler'], 'ja')).toBe('en');
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('"ja"'));
    } finally {
      errors.mockRestore();
    }
  });

  // One registry: every schema and table that names locales is derived from it.
  it('derives every locale list from the registry', () => {
    expect(LocaleSchema.options).toEqual([...LOCALES]);
    for (const language of LOCALES) {
      for (const locale of LOCALES) expect(languageName(language, locale).trim()).not.toBe('');
    }
    expect(languageName('zh', 'en')).toBe('Simplified Chinese');
  });

  it('finds locale flags early enough to translate help', () => {
    expect(localeFromArgv(['node', 'xcompiler', 'run', '--lang', 'CN', '--help'])).toBe('CN');
    expect(localeFromArgv(['node', 'xcompiler', '--lang=EN', '--help'])).toBe('EN');
  });
});
