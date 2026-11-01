import { LocaleSchema } from '../../domain/locale.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  TEXT_TRANSLATION_TEMPLATE_VERSION, type TranslationCache, type TranslationKey,
} from '../../application/translation/text_translation.js';
import type { Workspace } from '../../workspace/workspace.js';

const EntrySchema = z.object({
  schemaVersion: z.literal(1),
  templateVersion: z.string().min(1),
  from: LocaleSchema,
  to: LocaleSchema,
  source: z.string(),
  translation: z.string(),
}).strict();

/**
 * Translations kept in the project state, one file per text, keyed by the template version, the
 * direction and the text itself. A text translated during build is found again by later phases;
 * an entry that does not read back as exactly what it claims to be is a miss, never a translation.
 */
export class FileTranslationCache implements TranslationCache {
  constructor(private readonly state: Workspace) {}

  async read(key: TranslationKey): Promise<string | undefined> {
    const file = this.path(key);
    if (!(await this.state.exists(file))) return undefined;
    let parsed: z.infer<typeof EntrySchema>;
    try {
      parsed = EntrySchema.parse(JSON.parse(await this.state.readFile(file)));
    } catch {
      return undefined;
    }
    const matches = parsed.templateVersion === TEXT_TRANSLATION_TEMPLATE_VERSION
      && parsed.from === key.from && parsed.to === key.to && parsed.source === key.text;
    return matches ? parsed.translation : undefined;
  }

  async write(key: TranslationKey, translation: string): Promise<void> {
    await this.state.writeFileAtomic(this.path(key), `${JSON.stringify({
      schemaVersion: 1, templateVersion: TEXT_TRANSLATION_TEMPLATE_VERSION, from: key.from, to: key.to, source: key.text, translation,
    } satisfies z.infer<typeof EntrySchema>)}\n`);
  }

  private path(key: TranslationKey): string {
    const digest = createHash('sha256')
      .update(JSON.stringify([TEXT_TRANSLATION_TEMPLATE_VERSION, key.from, key.to, key.text])).digest('hex');
    return `translations/${digest}.json`;
  }
}
