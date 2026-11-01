import { z } from 'zod';

/**
 * The languages XCompiler speaks, and the one place a new one is added.
 *
 * The list used to be restated wherever a locale was read: request schemas, configuration, the
 * translation cache, the Rule catalogue, the CLI aliases, two tables of language names. Each copy is
 * now derived from this one, and the types make every derived table name every language here.
 */
export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const LocaleSchema = z.enum(LOCALES);

interface LocaleDefinition {
  /** What `--lang`, `XC_LANG` and configuration accept for it, lower case. */
  readonly aliases: readonly string[];
  /** How the CLI names it to the user. */
  readonly flag: string;
  /** Its name written in each locale, for prompts and translation. */
  readonly names: Readonly<Record<Locale, string>>;
}

const LOCALE_REGISTRY: Readonly<Record<Locale, LocaleDefinition>> = Object.freeze({
  en: Object.freeze({
    aliases: ['en', 'us', 'uk', 'gb', 'en-us', 'en-gb'],
    flag: 'EN',
    names: Object.freeze({ en: 'English', zh: '英文' }),
  }),
  zh: Object.freeze({
    aliases: ['zh', 'cn', 'zh-cn', 'zh-hans', 'chinese'],
    flag: 'CN',
    names: Object.freeze({ en: 'Simplified Chinese', zh: '中文' }),
  }),
});

/** The locale an alias names, or nothing when no registered language answers to it. */
export function resolveLocale(value: string): Locale | undefined {
  const alias = value.trim().toLowerCase();
  return LOCALES.find((locale) => LOCALE_REGISTRY[locale].aliases.includes(alias));
}

/** The name of `language` as written in `locale`. */
export function languageName(language: Locale, locale: Locale): string {
  return LOCALE_REGISTRY[language].names[locale];
}

/** The flags the CLI offers, for help and error messages. */
export function localeFlags(): string[] {
  return LOCALES.map((locale) => LOCALE_REGISTRY[locale].flag);
}

/**
 * A language was asked for that XCompiler does not speak. It used to fall back to English silently,
 * so a mistyped or not-yet-supported language looked like a working setting.
 */
export class UnsupportedLocaleError extends Error {
  readonly code = 'unsupported_locale';
  constructor(readonly value: string) {
    super(`Unsupported language "${value}"; supported: ${localeFlags().join(', ')}.`);
    this.name = 'UnsupportedLocaleError';
  }
}
