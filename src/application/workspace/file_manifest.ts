import type { FileTreeEntry } from '../../domain/workspace/file_tree.js';
import { getLocale, tFor } from '../../i18n/index.js';

/**
 * The delivered file manifest: the files the release holds.
 *
 * The section is generated, never authored. A Step asked to write this by hand would restate what
 * it believed it had produced, which is the one thing the manifest exists to check — and it would
 * be stale the moment the next Step wrote a file.
 *
 * Because it shares a document with authored prose, the generated region is fenced by markers and
 * only that region is ever replaced. Without them, regenerating means either appending duplicates
 * or overwriting a delivery document somebody wrote.
 */
export const FILE_MANIFEST_BEGIN = '<!-- xcompiler:file-manifest:begin -->';
export const FILE_MANIFEST_END = '<!-- xcompiler:file-manifest:end -->';

/** Formats an epoch-millisecond stamp as UTC seconds, so two runs of the same tree render alike. */
/**
 * Renders the manifest section.
 *
 * Rows carry path and type only. Size and timestamps are deliberately left out of the delivered
 * document even though the tree records them: this section is written *into* a file the manifest
 * itself lists, so the moment it lands, that file's size and mtime differ from the row describing
 * it. A delivered record that contradicts itself on its own first entry is worse than one that
 * scopes itself to the facts the write cannot invalidate. The full stat data stays queryable on the
 * file-tree object, which is reconciled again after the manifest commit.
 */
export function renderFileManifest(
  entries: readonly Pick<FileTreeEntry, 'path' | 'type'>[],
  options: { scannedAt?: string } = {},
): string {
  const files = entries.filter((entry) => entry.type !== 'directory');
  const rows = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `| \`${entry.path}\` | ${entry.type} |`);

  // The manifest is part of a delivered document, so it is written in the user's language; its markers never change.
  const text = tFor(getLocale()).generated.fileManifest;
  return [
    FILE_MANIFEST_BEGIN,
    '',
    text.heading,
    '',
    text.intro(options.scannedAt),
    '',
    text.count(files.length),
    '',
    `| ${text.path} | ${text.type} |`,
    '| --- | --- |',
    ...(rows.length > 0 ? rows : ['| _(empty)_ | — |']),
    '',
    FILE_MANIFEST_END,
  ].join('\n');
}

export function upsertFileManifest(document: string, section: string): string {
  const begin = document.indexOf(FILE_MANIFEST_BEGIN);
  const end = document.indexOf(FILE_MANIFEST_END);
  if (begin >= 0 && end > begin) {
    const before = document.slice(0, begin);
    const after = document.slice(end + FILE_MANIFEST_END.length);
    return `${before}${section}${after}`;
  }
  const body = document.replace(/\s*$/u, '');
  return body.length > 0 ? `${body}\n\n${section}\n` : `${section}\n`;
}
