import { languageName, type Locale } from '../../domain/locale.js';
import { LLMRequestError, ProviderCapacityExhausted } from '../../llm/errors.js';
import type { JsonOutputProtocol } from '../../llm/protocol_json.js';
import type { ChatMessage } from '../../llm/types.js';

/**
 * Translation between the user's locale and the English models read when `prompt_translate` is on.
 * Text with a preset English form (prompt templates, Rules, interface messages) never comes here:
 * it is substituted directly. Only free text does: what the user writes and what models write.
 */
export type TranslationLocale = Locale;

export const TEXT_TRANSLATION_TEMPLATE_VERSION = 'text-translation/1' as const;
const PROTOCOL_TRANSFORMATIONS: JsonOutputProtocol['transformations'] = [
  'json-fence', 'trailing-comma', 'raw-string-control', 'escape-insertion',
];
Object.freeze(PROTOCOL_TRANSFORMATIONS);
export const TEXT_TRANSLATION_PROTOCOL: JsonOutputProtocol = Object.freeze({
  id: 'text-translation', version: '1', root: 'object', transformations: PROTOCOL_TRANSFORMATIONS,
});


/** A reply that parses but is not a faithful translation set; the model is asked again with the reason. */
export class TranslationContractViolation extends Error {
  readonly code = 'translation_contract_violation';
  constructor(message: string) {
    super(message);
    this.name = 'TranslationContractViolation';
  }
}

export interface TextTranslationPort {
  readonly name: string;
  translate(input: {
    from: TranslationLocale; to: TranslationLocale; texts: readonly string[]; signal?: AbortSignal;
  }): Promise<string[]>;
}

/** One translation already made, keyed by everything that decides its result. */
export interface TranslationKey {
  readonly from: TranslationLocale;
  readonly to: TranslationLocale;
  readonly text: string;
}

export interface TranslationCache {
  read(key: TranslationKey): Promise<string | undefined>;
  write(key: TranslationKey, translation: string): Promise<void>;
}

/** The request: English instructions, the texts as JSON so every boundary between them is explicit. */
export function buildTranslationMessages(input: {
  from: TranslationLocale; to: TranslationLocale; texts: readonly string[];
}): ChatMessage[] {
  const from = languageName(input.from, 'en');
  const to = languageName(input.to, 'en');
  return [
    {
      role: 'system',
      content: `You translate text exchanged between a user and the models of a software build tool, from ${from} to ${to}.
Translate the meaning faithfully: do not add, drop, summarise, explain or answer anything.
Keep the structure: Markdown headings, list markers, line breaks, and option labels such as "A." at the start of a line.
Copy these unchanged: fenced code blocks, inline code, file paths, URLs, identifiers, commands, numbers, and anything in {{double braces}}.
Text that is already in ${to}, or has nothing to translate, is returned as it is.
Return ONLY one JSON object: {"translations":["…"]}, with exactly one translation per input text, in the same order.`,
    },
    { role: 'user', content: JSON.stringify({ texts: input.texts }) },
  ];
}

/** Fenced blocks, inline code and `{{variables}}`: text the translation must carry over byte for byte. */
function protectedSpans(text: string): string[] {
  return [...text.matchAll(/```[\s\S]*?```|`[^`\n]+`|\{\{[^{}]*\}\}/gu)].map((match) => match[0]);
}

/** The translations a reply carries, in input order, after checking each is complete and keeps what must not change. */
export function validateTranslationResponse(text: string, sources: readonly string[]): string[] {
  const value: unknown = JSON.parse(text);
  const translations = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).translations : undefined;
  if (!Array.isArray(translations)) throw new TranslationContractViolation('Return one object with a "translations" list');
  if (translations.length !== sources.length) {
    throw new TranslationContractViolation(`Return exactly ${sources.length} translations, one per input text, in order`);
  }
  return translations.map((item, index) => {
    if (typeof item !== 'string') throw new TranslationContractViolation(`translations[${index}] must be a string`);
    const source = sources[index]!;
    if (source.trim() && !item.trim()) throw new TranslationContractViolation(`translations[${index}] is empty`);
    for (const span of protectedSpans(source)) {
      if (!item.includes(span)) {
        throw new TranslationContractViolation(`translations[${index}] must keep ${JSON.stringify(span.slice(0, 80))} unchanged`);
      }
    }
    return item;
  });
}

/**
 * A translation the service could not give. Only these fall back to the untranslated text; a
 * cancellation, a broken audit or a misconfigured pool is not a translation failure and propagates.
 */
export function isTranslationServiceFailure(error: unknown): error is LLMRequestError | ProviderCapacityExhausted {
  if (error instanceof ProviderCapacityExhausted) return true;
  return error instanceof LLMRequestError && error.failure.code !== 'provider_not_configured';
}

export interface TranslationFallback {
  readonly from: TranslationLocale;
  readonly to: TranslationLocale;
  readonly texts: number;
  readonly code: string;
}

/**
 * Translates at the boundary between the user and the models, and only when it is needed: with
 * `prompt_translate` on and a locale other than English. Each text is translated once (cached by
 * its content), and a failed translation leaves that text as it was, after `onFallback` reports it.
 */
export class PromptTranslator {
  constructor(private readonly options: {
    userLocale: TranslationLocale;
    enabled: boolean;
    port?: TextTranslationPort;
    cache?: TranslationCache;
    onFallback?: (event: TranslationFallback) => Promise<void> | void;
    signal?: AbortSignal;
  }) {}

  get active(): boolean {
    return this.options.enabled && this.options.userLocale !== 'en' && !!this.options.port;
  }

  /** The language the user reads and writes; models read English. */
  get userLocale(): TranslationLocale {
    return this.options.userLocale;
  }

  /** The user's text as models should read it. */
  toModel(texts: readonly string[]): Promise<string[]> {
    return this.translate(this.options.userLocale, 'en', texts);
  }

  /** A model's text as the user should read it. */
  toUser(texts: readonly string[]): Promise<string[]> {
    return this.translate('en', this.options.userLocale, texts);
  }

  async oneToModel(text: string): Promise<string> {
    return (await this.toModel([text]))[0]!;
  }

  async oneToUser(text: string): Promise<string> {
    return (await this.toUser([text]))[0]!;
  }

  /**
   * Keeps translations into English that were not asked of the service but are already known (the
   * topic as intake built it for models, section by section), so the same text is not sent again.
   */
  async remember(pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
    if (!this.active) return;
    for (const [text, translation] of pairs) {
      if (text.trim() && translation.trim()) await this.options.cache?.write({ from: this.options.userLocale, to: 'en', text }, translation);
    }
  }

  private async translate(from: TranslationLocale, to: TranslationLocale, texts: readonly string[]): Promise<string[]> {
    const result = [...texts];
    if (!this.active || from === to) return result;
    const { cache, port, signal } = this.options;
    const pending = new Map<string, number[]>();
    for (const [index, text] of texts.entries()) {
      if (!text.trim()) continue;
      const cached = await cache?.read({ from, to, text });
      if (cached !== undefined) result[index] = cached;
      else pending.set(text, [...(pending.get(text) ?? []), index]);
    }
    if (pending.size === 0) return result;
    const sources = [...pending.keys()];
    let translated: string[];
    try {
      translated = await port!.translate({ from, to, texts: sources, signal });
    } catch (error) {
      if (!isTranslationServiceFailure(error)) throw error;
      const code = error instanceof LLMRequestError ? error.failure.code : error.code;
      await this.options.onFallback?.({ from, to, texts: sources.length, code });
      return result;
    }
    for (const [position, source] of sources.entries()) {
      const translation = translated[position]!;
      for (const index of pending.get(source)!) result[index] = translation;
      await cache?.write({ from, to, text: source }, translation);
    }
    return result;
  }
}
