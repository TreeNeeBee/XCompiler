import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTranslationMessages,
  PromptTranslator, TranslationContractViolation, validateTranslationResponse, type TextTranslationPort,
} from '../src/application/translation/text_translation.js';
import { topicAddenda, topicForModels, topicTranslationPairs } from '../src/application/planning/requirement_intake.js';
import { getPromptLocale, isPromptTranslationActive, setLocale, setPromptTranslation, tFor } from '../src/i18n/index.js';
import { FileTranslationCache } from '../src/infrastructure/translation/file_translation_cache.js';
import { LLMRequestError, ProviderCapacityExhausted } from '../src/llm/errors.js';
import { Workspace } from '../src/workspace/workspace.js';
import { translationPool } from '../src/runtime/translation_request.js';
import { BASE_CONFIG } from './support/config.js';

afterEach(() => {
  setPromptTranslation(false);
  setLocale('en');
});

describe('the language models read', () => {
  it('is the locale unless prompt translation is on, which makes it English', () => {
    setLocale('zh');
    expect(getPromptLocale()).toBe('zh');
    expect(isPromptTranslationActive()).toBe(false);
    setPromptTranslation(true);
    expect(getPromptLocale()).toBe('en');
    expect(isPromptTranslationActive()).toBe(true);
    // An English user needs no translation even with it on.
    setLocale('en');
    expect(isPromptTranslationActive()).toBe(false);
  });

  it('runs translations in the translation pool when one is configured, otherwise in PM\'s pool', () => {
    expect(translationPool(BASE_CONFIG)).toBe('management');
    expect(translationPool({ llm: { ...BASE_CONFIG.llm, pools: { ...BASE_CONFIG.llm.pools, translation: ['p'] } } })).toBe('translation');
  });
});

describe('a translation reply', () => {
  const sources = ['报表按 `report.csv` 导出', '使用 {{outputLanguage}}'];

  it('is accepted with one translation per text that keeps code and variables unchanged', () => {
    expect(validateTranslationResponse(JSON.stringify({ translations: ['Export the report as `report.csv`', 'Use {{outputLanguage}}'] }), sources))
      .toEqual(['Export the report as `report.csv`', 'Use {{outputLanguage}}']);
  });

  it.each([
    ['a list instead of an object', ['a', 'b']],
    ['a missing translation', { translations: ['Export the report as `report.csv`'] }],
    ['a non-text translation', { translations: ['Export the report as `report.csv`', 3] }],
    ['an empty translation', { translations: ['Export the report as `report.csv`', ' '] }],
    ['translated inline code', { translations: ['Export the report as `报表.csv`', 'Use {{outputLanguage}}'] }],
    ['a translated variable', { translations: ['Export the report as `report.csv`', 'Use the output language'] }],
  ])('is refused for %s, so the model is asked again', (_name, reply) => {
    expect(() => validateTranslationResponse(JSON.stringify(reply), sources)).toThrow(TranslationContractViolation);
  });
});

describe('the prompt translator', () => {
  const portReturning = (impl: TextTranslationPort['translate']) => {
    const translate = vi.fn(impl);
    return { port: { name: 'fake', translate } satisfies TextTranslationPort, translate };
  };
  const tagged: TextTranslationPort['translate'] = async ({ to, texts }) => texts.map((text) => `[${to}] ${text}`);

  it('passes text through untouched, asking no model, when translation is off or the user reads English', async () => {
    const { port, translate } = portReturning(tagged);
    expect(await new PromptTranslator({ userLocale: 'zh', enabled: false, port }).toModel(['需求'])).toEqual(['需求']);
    expect(await new PromptTranslator({ userLocale: 'en', enabled: true, port }).toUser(['Question'])).toEqual(['Question']);
    expect(translate).not.toHaveBeenCalled();
  });

  it('translates each distinct text once per direction, skipping blanks, and reuses what it cached', async () => {
    const { port, translate } = portReturning(tagged);
    const store = new Map<string, string>();
    const cache = { read: async (key: { from: string; to: string; text: string }) => store.get(JSON.stringify(key)),
      write: async (key: { from: string; to: string; text: string }, value: string) => { store.set(JSON.stringify(key), value); } };
    const translator = new PromptTranslator({ userLocale: 'zh', enabled: true, port, cache });
    expect(await translator.toModel(['需求', '', '需求', '回答'])).toEqual(['[en] 需求', '', '[en] 需求', '[en] 回答']);
    expect(translate).toHaveBeenCalledExactlyOnceWith({ from: 'zh', to: 'en', texts: ['需求', '回答'], signal: undefined });
    expect(await translator.toModel(['回答'])).toEqual(['[en] 回答']);
    expect(await translator.toUser(['Question'])).toEqual(['[zh] Question']);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['every candidate failing', new LLMRequestError('failed', { code: 'all_providers_failed', mode: 'router', retryable: true, switchProvider: true })],
    ['no provider holding the request', new ProviderCapacityExhausted([])],
  ])('keeps the text as written and reports it when the service fails by %s', async (_name, error) => {
    const onFallback = vi.fn();
    const { port } = portReturning(async () => { throw error; });
    const translator = new PromptTranslator({ userLocale: 'zh', enabled: true, port, onFallback });
    expect(await translator.toModel(['需求'])).toEqual(['需求']);
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ from: 'zh', to: 'en', texts: 1 }));
  });

  it.each([
    ['a cancellation', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['an unconfigured pool', new LLMRequestError('no pool', { code: 'provider_not_configured', mode: 'router', retryable: false, switchProvider: false })],
  ])('lets %s propagate: it is not a translation the service could not give', async (_name, error) => {
    const { port } = portReturning(async () => { throw error; });
    await expect(new PromptTranslator({ userLocale: 'zh', enabled: true, port }).toModel(['需求'])).rejects.toBe(error);
  });
});

describe('the topic models read', () => {
  const zh = tFor('zh').compile;
  const en = tFor('en').compile;
  const topic = ['---', 'xcompiler-topic: 1', 'language: python', '---', zh.topicTitle, '', zh.topicPreamble, '',
    zh.topicSecRequirement, '', '汇总文本文件', '', zh.topicSecAddenda, '', '导出 CSV', ''].join('\n');

  const modelTopic = ['---', 'xcompiler-topic: 1', 'language: python', '---', en.topicTitle, '', en.topicPreamble, '',
    en.topicSecRequirement, '', 'Summarise text files', '', en.topicSecAddenda, '', 'Export CSV', ''].join('\n');
  const translatorWith = () => {
    const translate = vi.fn<TextTranslationPort['translate']>(async ({ texts }) => texts.map((text) => `⟦en⟧${text}`));
    const store = new Map<string, string>();
    const cache = { read: async (key: { text: string }) => store.get(key.text),
      write: async (key: { text: string }, value: string) => { store.set(key.text, value); } };
    return { translate, translator: new PromptTranslator({ userLocale: 'zh', enabled: true, port: { name: 'fake', translate }, cache }) };
  };

  it('switches the lines XCompiler writes to their English presets and translates the text between them one section at a time', async () => {
    const { translate, translator } = translatorWith();
    expect(await topicForModels(topic, translator)).toBe(['---', 'xcompiler-topic: 1', 'language: python', '---', en.topicTitle, '',
      en.topicPreamble, '', en.topicSecRequirement, '', '⟦en⟧汇总文本文件', '', en.topicSecAddenda, '', '⟦en⟧导出 CSV', ''].join('\n'));
    // A long topic never has to come back in one reply.
    expect(translate.mock.calls.map(([request]) => request.texts)).toEqual([['汇总文本文件'], ['导出 CSV']]);
  });

  it('reuses what intake already translated, so only a section the user then edits is translated', async () => {
    const { translate, translator } = translatorWith();
    await translator.remember(topicTranslationPairs(topic, modelTopic, 'zh'));
    expect(await topicForModels(topic, translator)).toBe(modelTopic);
    expect(translate).not.toHaveBeenCalled();
    const edited = await topicForModels(topic.replace('导出 CSV', '导出 PDF'), translator);
    expect(edited).toContain('Summarise text files');
    expect(edited).toContain('⟦en⟧导出 PDF');
    expect(translate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ texts: ['导出 PDF'] }));
  });

  it('reads the addenda out of a topic in either language, so the plan records what planning read', () => {
    expect(topicAddenda(topic)).toBe('导出 CSV');
    expect(topicAddenda(modelTopic)).toBe('Export CSV');
    expect(topicAddenda(topic.slice(0, topic.indexOf(zh.topicSecAddenda)))).toBe('');
  });

  it('pairs nothing when the sections do not line up, rather than remember a wrong translation', () => {
    const quoting = topic.replace('汇总文本文件', `汇总文本文件\n${zh.topicSecAddenda}\n引用的标题`);
    expect(topicTranslationPairs(quoting, modelTopic, 'zh')).toEqual([]);
    expect(topicTranslationPairs(topic, modelTopic, 'zh')).toEqual([['汇总文本文件', 'Summarise text files'], ['导出 CSV', 'Export CSV']]);
  });

  it('is the topic itself when models read the user\'s language', async () => {
    const translate = vi.fn<TextTranslationPort['translate']>();
    expect(await topicForModels(topic, new PromptTranslator({ userLocale: 'zh', enabled: false, port: { name: 'fake', translate } }))).toBe(topic);
    expect(translate).not.toHaveBeenCalled();
  });
});

describe('the translation cache', () => {
  let root = '';
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it('returns a translation only for the exact text and direction it was made for', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-translation-cache-'));
    const cache = new FileTranslationCache(new Workspace(root));
    await cache.write({ from: 'zh', to: 'en', text: '需求' }, 'Requirement');
    expect(await cache.read({ from: 'zh', to: 'en', text: '需求' })).toBe('Requirement');
    expect(await cache.read({ from: 'en', to: 'zh', text: '需求' })).toBeUndefined();
    expect(await cache.read({ from: 'zh', to: 'en', text: '需求。' })).toBeUndefined();
    const [file] = await fs.readdir(path.join(root, 'translations'));
    await fs.writeFile(path.join(root, 'translations', file!), '{"schemaVersion":1');
    expect(await cache.read({ from: 'zh', to: 'en', text: '需求' })).toBeUndefined();
  });
});

// The translator model reads its instructions in English, so it is told both languages by their
// English names, whichever language the user speaks.
describe('the translation request names its languages in English', () => {
  it.each([['zh', 'en', 'from Simplified Chinese to English'], ['en', 'zh', 'from English to Simplified Chinese']] as const)(
    'names %s to %s as "%s"', (from, to, phrase) => {
      expect(buildTranslationMessages({ from, to, texts: ['x'] })[0]!.content).toContain(phrase);
    },
  );
});
