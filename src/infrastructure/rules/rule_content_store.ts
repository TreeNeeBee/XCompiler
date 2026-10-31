import { RuleDefinitionSchema, promptRuleText, type RuleDefinition, type RuleLocale } from '../../domain/rules/catalogue.js';
import { ruleEvidenceDigest } from '../../domain/rules/encoding.js';
import { RuleDigestSchema } from '../../domain/rules/vector_index.js';
import { publishImmutableJson, readImmutableJson } from '../persistence/immutable_json_artifact.js';

/**
 * Rule bodies are stored once, by content (revision 7a, O-9): a draft or snapshot keeps each
 * considered Rule as a `ruleRef` digest, and the body lives in `<content root>/<hex>.json`. A
 * snapshot's rendered entries drop their instruction text, which is the referenced body's text in
 * the request locale. A request file is therefore as small as its references, however many
 * executions pin the same Rules; reading rebuilds and the snapshot digest verifies the result.
 */
export interface CompactRuleMaterial {
  readonly document: Record<string, unknown>;
  readonly contents: readonly { readonly ref: string; readonly rule: RuleDefinition }[];
}

type WithConsidered = {
  readonly consideredRules: readonly { readonly rule: RuleDefinition }[];
  readonly rules?: readonly { readonly instruction: string }[];
};

/** The stored form of a draft or snapshot, and the Rule bodies it references. */
export function compactRuleMaterial(value: WithConsidered): CompactRuleMaterial {
  const contents = new Map<string, RuleDefinition>();
  const consideredRules = value.consideredRules.map(({ rule, ...entry }) => {
    const ref = ruleEvidenceDigest(rule);
    contents.set(ref, rule);
    return { ...entry, ruleRef: ref };
  });
  const rendered = value.rules ? { rules: value.rules.map(({ instruction: _instruction, ...entry }) => entry) } : {};
  return { document: { ...value, consideredRules, ...rendered }, contents: [...contents].map(([ref, rule]) => ({ ref, rule })) };
}

/** The file a Rule body is stored under. */
export function ruleContentName(ref: string): string {
  return `${RuleDigestSchema.parse(ref).slice('sha256:'.length)}.json`;
}

export class RuleContentError extends Error {
  readonly code = 'rule_content_failed';
  constructor(readonly reason: 'invalid' | 'missing' | 'read_failed' | 'write_failed', readonly details: Readonly<Record<string, unknown>>, options?: ErrorOptions) {
    super(`Rule content failed: ${reason}`, options);
    this.name = 'RuleContentError';
  }
}

export class FileRuleContentStore {
  constructor(private readonly root: string, private readonly boundaryRoot?: string) {}

  /** Publishes each body before the request file that references it; a stored body must match its digest. */
  async publish(contents: CompactRuleMaterial['contents']): Promise<void> {
    for (const { ref, rule } of contents) {
      let stored: unknown;
      try { stored = await publishImmutableJson(this.root, ruleContentName(ref), rule, this.boundaryRoot); }
      catch (cause) { throw new RuleContentError('write_failed', { ref }, { cause }); }
      if (ruleEvidenceDigest(stored) !== ref) throw new RuleContentError('invalid', { ref });
    }
  }

  /** The stored document with each `ruleRef` replaced by its verified body; any other shape is invalid. */
  async expand(raw: unknown): Promise<unknown> {
    const document = raw as { consideredRules?: unknown; rules?: unknown; context?: { locale?: RuleLocale } } | null;
    if (!document || typeof document !== 'object' || !Array.isArray(document.consideredRules)) {
      throw new RuleContentError('invalid', { field: 'consideredRules' });
    }
    const consideredRules = [];
    for (const entry of document.consideredRules as Record<string, unknown>[]) {
      if (!entry || typeof entry !== 'object' || 'rule' in entry || typeof entry.ruleRef !== 'string') {
        throw new RuleContentError('invalid', { field: 'ruleRef' });
      }
      const { ruleRef, ...rest } = entry;
      consideredRules.push({ ...rest, rule: await this.read(ruleRef) });
    }
    if (document.rules === undefined) return { ...document, consideredRules };
    if (!Array.isArray(document.rules)) throw new RuleContentError('invalid', { field: 'rules' });
    const bodies = new Map(consideredRules.map((entry) => [String(entry.rule.id).toLowerCase(), entry.rule]));
    const rules = (document.rules as Record<string, unknown>[]).map((entry) => {
      const body = entry && typeof entry === 'object' && !('instruction' in entry) ? bodies.get(String(entry.ruleId).toLowerCase()) : undefined;
      if (!body) throw new RuleContentError('invalid', { field: 'rules' });
      return { ...entry, instruction: promptRuleText(body.instruction, document.context ?? {}) };
    });
    return { ...document, consideredRules, rules };
  }

  private async read(ref: string): Promise<RuleDefinition> {
    let raw: unknown;
    try { raw = await readImmutableJson(this.root, ruleContentName(ref), this.boundaryRoot); }
    catch (cause) { throw new RuleContentError('read_failed', { ref }, { cause }); }
    if (raw === undefined) throw new RuleContentError('missing', { ref });
    const parsed = RuleDefinitionSchema.safeParse(raw);
    if (!parsed.success || ruleEvidenceDigest(parsed.data) !== ref) throw new RuleContentError('invalid', { ref });
    return parsed.data;
  }
}
