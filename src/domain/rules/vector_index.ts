import { z } from 'zod';

const Text = z.string().refine((value) => value.trim().length > 0, 'Value must not be blank');
export const RuleDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const RULE_VECTOR_INPUT_VERSION = 'rule-retrieval/1' as const;

/** An explicit space version changes whenever the provider's encoding identity changes. */
export const RuleEmbeddingIdentitySchema = z.object({
  provider: Text,
  model: Text,
  spaceVersion: Text,
  dimensions: z.number().int().positive(),
}).strict();
export type RuleEmbeddingIdentity = z.infer<typeof RuleEmbeddingIdentitySchema>;

export const RuleVectorDocumentSchema = z.object({
  ruleId: z.uuid(),
  ruleVersion: Text,
  ruleListId: z.uuid(),
  ruleListVersion: Text,
  contentDigest: RuleDigestSchema,
  retrievalDescription: Text,
}).strict();
export type RuleVectorDocument = z.infer<typeof RuleVectorDocumentSchema>;

export const RuleVectorIndexSchema = z.object({
  schemaVersion: z.literal(1),
  id: RuleDigestSchema,
  vectorDigest: RuleDigestSchema,
  inputVersion: z.literal(RULE_VECTOR_INPUT_VERSION),
  identity: RuleEmbeddingIdentitySchema,
  documents: z.array(RuleVectorDocumentSchema),
  vectors: z.array(z.array(z.number().finite())),
}).strict().superRefine((index, context) => {
  if (index.documents.length !== index.vectors.length) context.addIssue({
    code: 'custom', path: ['vectors'], message: 'Each indexed Rule must have exactly one vector',
  });
  const ids = new Set<string>();
  index.documents.forEach((document, i) => {
    const id = document.ruleId.toLowerCase();
    if (ids.has(id)) context.addIssue({ code: 'custom', path: ['documents', i, 'ruleId'], message: 'Duplicate Rule identity' });
    ids.add(id);
  });
  index.vectors.forEach((vector, i) => {
    if (vector.length !== index.identity.dimensions || !vector.some((coordinate) => coordinate !== 0)) {
      context.addIssue({ code: 'custom', path: ['vectors', i], message: 'Vector has the wrong dimensions or zero norm' });
    }
  });
});
export type RuleVectorIndex = z.infer<typeof RuleVectorIndexSchema>;
