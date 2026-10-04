import { z } from 'zod';

export const JSON_PROOF_VERSION = 'json-representation-proof/1' as const;
const Transform = z.enum(['json-fence', 'trailing-comma', 'raw-string-control']);
const Text = z.string().refine((value) => value.trim().length > 0);
const Protocol = z.object({
  id: Text, version: Text,
  root: z.enum(['any', 'object', 'array']), transformations: z.array(Transform),
}).strict().refine((value) => new Set(value.transformations).size === value.transformations.length,
  'A protocol transformation may be declared only once');
export type JsonOutputProtocol = z.infer<typeof Protocol>;
export type JsonTransformation = z.infer<typeof Transform>;

/** All offsets are zero-based UTF-16 code-unit offsets; end is exclusive. */
export interface JsonSourceSpan { readonly start: number; readonly end: number }
export interface JsonRepresentationEdit extends JsonSourceSpan {
  readonly kind: JsonTransformation; readonly replacement: string;
}
export interface JsonEvidenceToken extends JsonSourceSpan {
  readonly kind: 'punctuation' | 'string' | 'number' | 'literal';
  readonly text: string;
  /** Exact decoded UTF-16 value, without newline or Unicode normalization. */
  readonly decoded?: string;
}
export interface JsonProtocolDiagnostic {
  readonly code: 'invalid_envelope' | 'unexpected_token' | 'unexpected_end' | 'invalid_escape'
    | 'raw_control' | 'duplicate_key' | 'trailing_comma' | 'root_shape'
    | 'candidate_invalid' | 'values_changed' | 'unchanged_candidate';
  readonly offset: number; readonly line: number; readonly column: number;
  readonly expected?: string;
}
interface InspectionBase { readonly original: string; readonly protocol: JsonOutputProtocol }
export type JsonProtocolInspection = InspectionBase & (
  | { readonly status: 'valid' | 'repairable'; readonly normalized: string;
      readonly proofVersion: typeof JSON_PROOF_VERSION; readonly tokens: readonly JsonEvidenceToken[];
      readonly edits: readonly JsonRepresentationEdit[] }
  | { readonly status: 'unresolved'; readonly diagnostic: JsonProtocolDiagnostic }
);
export type JsonCorrectionProof = {
  readonly original: string; readonly candidate: string; readonly protocol: JsonOutputProtocol;
} & (
  | { readonly status: 'preserved'; readonly proofVersion: typeof JSON_PROOF_VERSION;
      readonly edits: readonly JsonRepresentationEdit[];
      readonly correspondence: readonly { readonly original: JsonEvidenceToken; readonly candidate: JsonEvidenceToken }[] }
  | { readonly status: 'unresolved'; readonly diagnostic: JsonProtocolDiagnostic;
      readonly candidateDiagnostic?: JsonProtocolDiagnostic }
);

class InvalidRepresentation extends Error {
  constructor(readonly code: JsonProtocolDiagnostic['code'], readonly offset: number, readonly expected?: string) {
    super(`JSON protocol rejected: ${code}`);
  }
}

/** A proof scanner, not a business parser. No partial value or guessed structure is returned. */
export function inspectJsonProtocol(original: string, input: JsonOutputProtocol): JsonProtocolInspection {
  const protocol = freezeProtocol(input);
  try {
    const edits: JsonRepresentationEdit[] = [];
    const range = envelope(original, protocol, edits);
    const tokens = tokenize(original, range, protocol, edits);
    const effective = validateStructure(tokens, range.end, protocol, edits);
    const first = effective[0]!;
    if (protocol.root !== 'any' && first.text !== (protocol.root === 'object' ? '{' : '[')) {
      throw new InvalidRepresentation('root_shape', first.start, protocol.root);
    }
    edits.sort((left, right) => left.start - right.start);
    let normalized = '';
    let cursor = 0;
    for (const edit of edits) {
      normalized += original.slice(cursor, edit.start) + edit.replacement;
      cursor = edit.end;
    }
    normalized += original.slice(cursor);
    return Object.freeze({ original, protocol, status: edits.length ? 'repairable' : 'valid', normalized,
      proofVersion: JSON_PROOF_VERSION, tokens: Object.freeze(effective.map((token) => Object.freeze(token))),
      edits: Object.freeze(edits.map((edit) => Object.freeze(edit))) });
  } catch (cause) {
    if (!(cause instanceof InvalidRepresentation)) throw cause;
    return Object.freeze({ original, protocol, status: 'unresolved', diagnostic: diagnostic(original, cause) });
  }
}

/** Independently parse the entire candidate strictly, then compare structure and every scalar. */
export function proveJsonProtocolCorrection(original: string, candidate: string, input: JsonOutputProtocol): JsonCorrectionProof {
  const source = inspectJsonProtocol(original, input);
  const base = { original, candidate, protocol: source.protocol };
  if (source.status === 'unresolved') return Object.freeze({ ...base, status: 'unresolved', diagnostic: source.diagnostic });
  if (candidate === original) return Object.freeze({ ...base, status: 'unresolved',
    diagnostic: diagnostic(original, new InvalidRepresentation('unchanged_candidate', 0)) });
  const target = inspectJsonProtocol(candidate, { ...source.protocol, transformations: [] });
  if (target.status === 'unresolved') return Object.freeze({ ...base, status: 'unresolved',
    diagnostic: diagnostic(candidate, new InvalidRepresentation('candidate_invalid', target.diagnostic.offset)),
    candidateDiagnostic: target.diagnostic });
  const mismatch = source.tokens.findIndex((token, index) => {
    const other = target.tokens[index];
    return !other || token.kind !== other.kind
      || (token.kind === 'string' ? token.decoded !== other.decoded : token.text !== other.text);
  });
  if (mismatch >= 0 || source.tokens.length !== target.tokens.length) return Object.freeze({
    ...base, status: 'unresolved', diagnostic: diagnostic(candidate, new InvalidRepresentation(
      'values_changed', target.tokens[mismatch >= 0 ? mismatch : source.tokens.length]?.start ?? candidate.length,
    )),
  });
  return Object.freeze({ ...base, status: 'preserved', proofVersion: JSON_PROOF_VERSION, edits: source.edits,
    correspondence: Object.freeze(source.tokens.map((token, index) => Object.freeze({
      original: token, candidate: target.tokens[index]!,
    }))) });
}

function freezeProtocol(input: JsonOutputProtocol): JsonOutputProtocol {
  const protocol = Protocol.parse(input);
  Object.freeze(protocol.transformations);
  return Object.freeze(protocol);
}

function envelope(source: string, protocol: JsonOutputProtocol, edits: JsonRepresentationEdit[]): JsonSourceSpan {
  let start = 0;
  let end = source.length;
  while (start < end && whitespace(source[start]!)) start++;
  while (end > start && whitespace(source[end - 1]!)) end--;
  if (!source.startsWith('```', start)) return { start, end };
  const opening = /^```(?:json)?[\t ]*(?:\r\n|\n)/u.exec(source.slice(start, end));
  const close = end - 3;
  if (!protocol.transformations.includes('json-fence') || !opening || close < start + opening[0].length
    || source.slice(close, end) !== '```' || source[close - 1] !== '\n') {
    throw new InvalidRepresentation('invalid_envelope', start, 'one complete JSON fence');
  }
  const bodyStart = start + opening[0].length;
  edits.push({ kind: 'json-fence', start, end: bodyStart, replacement: '' },
    { kind: 'json-fence', start: close, end, replacement: '' });
  return { start: bodyStart, end: close };
}

function tokenize(source: string, range: JsonSourceSpan, protocol: JsonOutputProtocol, edits: JsonRepresentationEdit[]): JsonEvidenceToken[] {
  const tokens: JsonEvidenceToken[] = [];
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  for (let position = range.start; position < range.end;) {
    const start = position;
    const char = source[position]!;
    if (whitespace(char)) { position++; continue; }
    if ('{}[]:,'.includes(char)) {
      tokens.push({ kind: 'punctuation', text: char, start, end: ++position });
      continue;
    }
    if (char === '"') {
      let encoded = '"';
      position++;
      let closed = false;
      while (position < range.end) {
        const current = source[position]!;
        if (current === '"') { encoded += current; position++; closed = true; break; }
        if (current === '\\') {
          const escape = source[position + 1];
          if (escape !== undefined && '"\\/bfnrt'.includes(escape)) {
            encoded += source.slice(position, position + 2); position += 2; continue;
          }
          if (escape === 'u' && /^[0-9a-fA-F]{4}$/u.test(source.slice(position + 2, position + 6))
            && position + 6 <= range.end) {
            encoded += source.slice(position, position + 6); position += 6; continue;
          }
          throw new InvalidRepresentation('invalid_escape', position);
        }
        if (current.charCodeAt(0) < 0x20) {
          const replacement = current === '\n' ? '\\n' : current === '\r' ? '\\r' : current === '\t' ? '\\t' : undefined;
          if (!replacement || !protocol.transformations.includes('raw-string-control')) {
            throw new InvalidRepresentation('raw_control', position);
          }
          edits.push({ kind: 'raw-string-control', start: position, end: position + 1, replacement });
          encoded += replacement;
        } else encoded += current;
        position++;
      }
      if (!closed) throw new InvalidRepresentation('unexpected_end', position, 'closing string quote');
      tokens.push({ kind: 'string', text: source.slice(start, position), decoded: JSON.parse(encoded) as string, start, end: position });
      continue;
    }
    const literal = ['true', 'false', 'null'].find((value) => source.startsWith(value, position));
    if (literal && position + literal.length <= range.end) {
      position += literal.length; tokens.push({ kind: 'literal', text: literal, start, end: position }); continue;
    }
    number.lastIndex = position;
    const matched = number.exec(source);
    if (matched && number.lastIndex <= range.end) {
      position = number.lastIndex; tokens.push({ kind: 'number', text: matched[0], start, end: position }); continue;
    }
    throw new InvalidRepresentation('unexpected_token', position, 'JSON token');
  }
  return tokens;
}

type Frame = { kind: 'root' | 'object' | 'array'; state: 'first' | 'key' | 'colon' | 'value' | 'after'; keys: Set<string> };

/** Iterative grammar validation retains order and rejects duplicate decoded keys; no JS object folding. */
function validateStructure(tokens: JsonEvidenceToken[], end: number, protocol: JsonOutputProtocol, edits: JsonRepresentationEdit[]): JsonEvidenceToken[] {
  const frames: Frame[] = [{ kind: 'root', state: 'value', keys: new Set() }];
  const removed = new Set<number>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const frame = frames.at(-1)!;
    const punctuation = token.kind === 'punctuation' ? token.text : undefined;
    const close = frame.kind === 'object' ? '}' : ']';
    if (frame.kind !== 'root' && (frame.state === 'first' || frame.state === 'after') && punctuation === close) {
      frames.pop(); continue;
    }
    if (frame.state === 'after') {
      if (frame.kind !== 'root' && punctuation === ',') {
        const next = tokens[index + 1];
        if (next?.kind === 'punctuation' && next.text === close) {
          if (!protocol.transformations.includes('trailing-comma')) throw new InvalidRepresentation('trailing_comma', token.start);
          removed.add(index); edits.push({ kind: 'trailing-comma', start: token.start, end: token.end, replacement: '' });
        } else frame.state = frame.kind === 'object' ? 'key' : 'value';
        continue;
      }
      throw new InvalidRepresentation('unexpected_token', token.start, frame.kind === 'root' ? 'end of input' : 'comma or container end');
    }
    if (frame.kind === 'object' && (frame.state === 'first' || frame.state === 'key')) {
      if (token.kind !== 'string') throw new InvalidRepresentation('unexpected_token', token.start, 'object key');
      if (frame.keys.has(token.decoded!)) throw new InvalidRepresentation('duplicate_key', token.start);
      frame.keys.add(token.decoded!); frame.state = 'colon'; continue;
    }
    if (frame.state === 'colon') {
      if (punctuation !== ':') throw new InvalidRepresentation('unexpected_token', token.start, 'colon');
      frame.state = 'value'; continue;
    }
    if (token.kind !== 'punctuation' || punctuation === '{' || punctuation === '[') {
      frame.state = 'after';
      if (punctuation === '{' || punctuation === '[') frames.push({
        kind: punctuation === '{' ? 'object' : 'array', state: 'first', keys: new Set(),
      });
      continue;
    }
    throw new InvalidRepresentation('unexpected_token', token.start, 'JSON value');
  }
  if (frames.length !== 1 || frames[0]!.state !== 'after') throw new InvalidRepresentation('unexpected_end', end, 'complete JSON value');
  return tokens.filter((_, index) => !removed.has(index));
}

function whitespace(char: string): boolean { return char === ' ' || char === '\t' || char === '\r' || char === '\n'; }
function diagnostic(source: string, failure: InvalidRepresentation): JsonProtocolDiagnostic {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < failure.offset; index++) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n' && index + 1 < failure.offset) index++;
      line++; lineStart = index + 1;
    } else if (source[index] === '\n') { line++; lineStart = index + 1; }
  }
  return Object.freeze({ code: failure.code, offset: failure.offset, line, column: failure.offset - lineStart + 1,
    ...(failure.expected ? { expected: failure.expected } : {}) });
}
