import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { z } from 'zod';
import { SCENARIO_REPAIR_TARGETS } from '../../domain/quality/delivery_gate.js';
import { t } from '../../i18n/index.js';

const Text = z.string().trim().min(1);

/**
 * A contract change a person asks of a Phase in progress.
 *
 * A Change Request otherwise only comes from a gate or a Step, so a defect no gate can see, such as
 * two contradictory design sections, had no way in. It carries what a contract change needs and
 * nothing about how to carry it out: from here on it is an ordinary Change Request.
 */
export const UserChangeRequestSchema = z.object({
  /** Stable across runs, so running the same file again does not open the change twice. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  /** A development level: only those own a contract. */
  target: z.enum(SCENARIO_REPAIR_TARGETS),
  summary: Text,
  expected: Text,
  evidence: z.array(Text).min(1),
  affectedArtifacts: z.array(Text).min(1),
}).strict();

export type UserChangeRequest = z.infer<typeof UserChangeRequestSchema>;

export type UserChangeRequestProblem =
  | 'unreadable' | 'malformed' | 'phase-not-open' | 'artifact-missing' | 'artifact-not-owned' | 'id-conflict';

/** Everything wrong is found before any model is called, and named so the file can be corrected. */
export class UserChangeRequestError extends Error {
  readonly code = 'user_change_request_invalid';
  constructor(readonly problem: UserChangeRequestProblem, message: string) {
    super(message);
    this.name = 'UserChangeRequestError';
  }
}

export interface ParsedUserChangeRequest {
  readonly request: UserChangeRequest;
  /** Of the request, not the file: reformatting or a comment is not a different change. */
  readonly digest: string;
}

export function parseUserChangeRequest(text: string): ParsedUserChangeRequest {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (cause) {
    throw new UserChangeRequestError('malformed', t().execute.userChangeRequestMalformed((cause as Error).message));
  }
  const parsed = UserChangeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ');
    throw new UserChangeRequestError('malformed', t().execute.userChangeRequestMalformed(issues));
  }
  // Listing the same evidence in another order is not a different change either.
  const canonical = JSON.stringify({
    ...parsed.data,
    evidence: [...parsed.data.evidence].sort(),
    affectedArtifacts: [...parsed.data.affectedArtifacts].sort(),
  });
  return { request: parsed.data, digest: createHash('sha256').update(canonical).digest('hex') };
}

const EXTERNAL_ID_PREFIX = 'user-change-request';

/** What identifies the request across runs; the digest tells a repeat from a different change. */
export function userChangeRequestExternalId(phaseName: string, id: string, digest: string): string {
  return `${userChangeRequestExternalPrefix(phaseName, id)}${digest}`;
}

export function userChangeRequestExternalPrefix(phaseName: string, id: string): string {
  return `${EXTERNAL_ID_PREFIX}:${phaseName}:${id}@`;
}
