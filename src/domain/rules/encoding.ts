import { createHash } from 'node:crypto';

export function ruleEvidenceDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalRuleJson(value)).digest('hex')}`;
}

/** Field order is presentation; literal strings and array order are part of the evidence. */
export function canonicalRuleJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRuleJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalRuleJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Rule evidence must be JSON data');
  return encoded;
}
