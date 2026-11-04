import { z } from 'zod';
import type { ObjectId } from '../../domain/identity/object_id.js';
import type { TicketContractBasis } from '../../domain/tickets/ticket.js';
import { getPromptLocale, tFor } from '../../i18n/index.js';
import { isAllowedWrite } from '../../tools/types.js';

const ContractBasisInputSchema = z.object({
  reason: z.string().trim().min(1),
  document: z.string().trim().min(1).optional(),
  quote: z.string().trim().min(1).optional(),
  changeRequest: z.string().trim().min(1).optional(),
}).strict();

/** Fewer characters than this appear in any document and so prove nothing about one. */
const MIN_QUOTE_CHARS = 8;

export interface AcceptedChange {
  ticketId: ObjectId;
  affectedArtifacts: readonly string[];
  /** What the change says, for whoever has to read it. */
  contract: string;
}

export interface ContractBasisSources {
  /** The documents this Step's level may cite. */
  documents: readonly string[];
  /** What stood before this Ticket began; text this Ticket wrote is not yet an accepted contract. */
  baseRevision: string;
  readAtBase(document: string): Promise<string | undefined>;
  /** The contract changes this Phase accepted, with the artifacts each one names. */
  acceptedChanges(): Promise<readonly AcceptedChange[]>;
}

export type ContractBasisRefusalKind =
  | 'missing' | 'malformed' | 'document-not-citable' | 'quote-too-short' | 'quote-not-found'
  | 'change-request-not-accepted' | 'change-request-not-covering';

export type ContractBasisResolution =
  | { ok: true; reason: string; citation: TicketContractBasis['citation']; citedContract: string }
  | { ok: false; kind: ContractBasisRefusalKind; error: string };

/**
 * Whether what a Step cited is a contract it may rest a change to an inherited test on.
 *
 * Checks that the citation is real and at the right level, not that it truly supersedes the old
 * assertion: an unrelated clause quoted verbatim passes. The quote is read at the Ticket's base so a
 * Step cannot write the sentence it then cites; a live P2 added a design appendix and relaxed a test
 * in one Ticket, and the appendix was its only authority.
 */
export async function resolveContractBasis(
  raw: unknown,
  targets: readonly string[],
  sources: ContractBasisSources,
): Promise<ContractBasisResolution> {
  const text = tFor(getPromptLocale()).tools.contractBasis;
  const accepted = () => sources.documents.map((document) => `- ${document}`).join('\n');
  if (raw === undefined || raw === null) {
    return { ok: false, kind: 'missing', error: text.required(targets.join(', '), accepted()) };
  }
  const parsed = ContractBasisInputSchema.safeParse(raw);
  const basis = parsed.success ? parsed.data : undefined;
  const citesDocument = basis?.document !== undefined && basis.quote !== undefined;
  const citesChange = basis?.changeRequest !== undefined;
  if (!basis || citesDocument === citesChange || (citesChange && (basis.document ?? basis.quote) !== undefined)) {
    return { ok: false, kind: 'malformed', error: text.malformed(accepted()) };
  }
  if (citesChange) {
    const change = (await sources.acceptedChanges()).find((candidate) => candidate.ticketId === basis.changeRequest);
    if (!change) return { ok: false, kind: 'change-request-not-accepted', error: text.changeRequestNotAccepted(basis.changeRequest!) };
    // Accepted is not the same as about this test: a renamed help title says nothing of a warning assertion.
    const uncovered = targets.filter((target) => !change.affectedArtifacts.some((artifact) => isAllowedWrite(target, [artifact])));
    if (uncovered.length > 0) {
      return { ok: false, kind: 'change-request-not-covering', error: text.changeRequestNotCovering(uncovered.join(', '), accepted()) };
    }
    return { ok: true, reason: basis.reason, citation: { kind: 'change-request', ticketId: change.ticketId }, citedContract: change.contract };
  }
  const document = basis.document!.replace(/\\/gu, '/').replace(/^\.\/+/u, '');
  if (!sources.documents.includes(document)) {
    return { ok: false, kind: 'document-not-citable', error: text.documentNotCitable(document, accepted()) };
  }
  const quote = collapsed(basis.quote!);
  if (quote.replaceAll(' ', '').length < MIN_QUOTE_CHARS) {
    return { ok: false, kind: 'quote-too-short', error: text.quoteTooShort(MIN_QUOTE_CHARS) };
  }
  const content = await sources.readAtBase(document);
  if (content === undefined || !collapsed(content).includes(quote)) {
    return { ok: false, kind: 'quote-not-found', error: text.quoteNotFound(document) };
  }
  return { ok: true, reason: basis.reason, citedContract: quote,
    citation: { kind: 'document', document, quote, revision: sources.baseRevision } };
}

/** A document wraps lines where a quote does not, and neither changes the words. */
function collapsed(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
