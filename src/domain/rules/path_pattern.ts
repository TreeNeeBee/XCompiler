/**
 * Workspace path patterns for Rule applicability (revision 11.4): `*` matches within one path
 * segment, `**` across segments, `?` one character. Patterns are workspace-relative and anchored.
 */
export function isRulePathPattern(pattern: string): boolean {
  return pattern.trim() === pattern && pattern.length > 0 && !pattern.startsWith('/') && !pattern.includes('\\')
    && !pattern.split('/').some((segment) => segment === '..' || segment === '');
}

function patternExpression(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      // `**/` may match no directories at all; a trailing `**` matches the rest of the path.
      if (pattern[index + 2] === '/') { source += '(?:.*/)?'; index += 2; } else { source += '.*'; index += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

/** Whether a workspace-relative path matches a pattern; `./` prefixes and backslashes are normalized. */
export function rulePathMatches(pattern: string, path: string): boolean {
  const normalized = path.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
  return patternExpression(pattern).test(normalized);
}

const isWildcard = (segment: string) => /[*?]/u.test(segment);

function segmentExpression(segment: string): RegExp {
  return new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]')}$`, 'u');
}

/** Whether some file below the directory `root` (as segments) could match the pattern's segments. */
function mayMatchBelow(pattern: readonly string[], root: readonly string[]): boolean {
  if (root.length === 0) return pattern.length > 0;
  const [head, ...rest] = pattern;
  if (head === undefined) return false;
  // `**`, or a segment holding one, may absorb the rest of the root and still match a file below it.
  if (head.includes('**')) return true;
  return segmentExpression(head).test(root[0]!) && mayMatchBelow(rest, root.slice(1));
}

/**
 * Whether a pattern applies to a path the request may write (revision 11.4): a file matches as in
 * `rulePathMatches`; a directory (written with a trailing `/`) matches when some file below it
 * could, since the request may create any file there. A glob is judged by its literal directory
 * prefix, which can only include a Rule, never leave one out.
 */
export function rulePathMayMatchWritable(pattern: string, writable: string): boolean {
  const normalized = writable.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
  const segments = normalized.split('/');
  const firstWildcard = segments.findIndex(isWildcard);
  if (firstWildcard < 0 && !normalized.endsWith('/')) return rulePathMatches(pattern, normalized);
  const root = (firstWildcard < 0 ? segments.slice(0, -1) : segments.slice(0, firstWildcard)).filter((segment) => segment !== '');
  return mayMatchBelow(pattern.split('/'), root);
}
