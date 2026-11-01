import en from './en.js';
import zh from './zh.js';
import type { Locale, Messages } from './types.js';
import { resolveLocale, UnsupportedLocaleError } from '../domain/locale.js';

// Adapters reach the locale registry through here, never through the domain layer itself.
export { localeFlags, resolveLocale, UnsupportedLocaleError } from '../domain/locale.js';

export type { Locale, Messages } from './types.js';

const TABLES: Record<Locale, Messages> = { en, zh };

let current: Locale = 'en';

/** Current active locale (defaults to `en`). */
export function getLocale(): Locale {
  return current;
}

/** Set active locale. Accepts any alias the locale registry lists (`en`, `EN`, `cn`, `zh-CN`, …). */
export function setLocale(loc: string | Locale | undefined): Locale {
  current = normaliseLocale(loc);
  return current;
}

/** Normalise CLI / config inputs to internal {@link Locale}; a language not registered is refused. */
export function normaliseLocale(loc: string | undefined | null): Locale {
  if (!loc) return current;
  const locale = resolveLocale(String(loc));
  if (!locale) throw new UnsupportedLocaleError(String(loc));
  return locale;
}

/** Active message bundle for the current locale. */
export function t(): Messages {
  return TABLES[current];
}

let promptTranslation = false;

/**
 * Whether prompts reach models in English and cross the locale boundary by translation
 * (`prompt_translate: on`). Off, models read the same locale the user does.
 */
export function setPromptTranslation(on: boolean): void {
  promptTranslation = on;
}

/**
 * The language of everything a model reads: prompt templates and Rule text. The locale itself
 * stays the language of the CLI, interactive prompts and every text shown to the user.
 */
export function getPromptLocale(): Locale {
  return promptTranslation ? 'en' : current;
}

/** Whether text must be translated between the user's locale and the models' English. */
export function isPromptTranslationActive(): boolean {
  return promptTranslation && current !== 'en';
}

/** Explicit lookup against an arbitrary locale (does not change current). */
export function tFor(loc: Locale): Messages {
  return TABLES[loc];
}
