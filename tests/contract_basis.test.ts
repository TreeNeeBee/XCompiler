import { describe, expect, it } from 'vitest';
import { resolveContractBasis, type ContractBasisSources } from '../src/application/execution/contract_basis.js';
import type { Phase } from '../src/domain/planning/execution_plan.js';
import { contractBasisDocuments } from '../src/domain/quality/test_assets.js';

/**
 * A completed Phase is a milestone: a later Phase may change what it delivered only where a contract
 * it accepted superseded it. The clause below is the real P2 requirement of the dbc2excel run.
 */
const REQUIREMENT = 'docs/iterations/P2/01-requirement-analysis.md';
const DESIGN = 'docs/iterations/P2/02-high-level-design.md';
const DETAIL = 'docs/iterations/P2/03-detailed-design.md';
const CLAUSE = '表头为 19 列且前 16 列与 P1 一致';
const CHANGE_REQUEST = '01a19c35-229e-7de0-befb-5576043f09fa';

function sources(overrides: Partial<ContractBasisSources> = {}): ContractBasisSources {
  return {
    documents: [REQUIREMENT, DESIGN],
    baseRevision: 'a'.repeat(40),
    readAtBase: async (document) => document === REQUIREMENT ? `# P2\n\n- ${CLAUSE}\n- wrapped clause spanning\n  two lines of the document\n` : undefined,
    acceptedChanges: async () => [{ ticketId: CHANGE_REQUEST as never, affectedArtifacts: ['tests/'], contract: 'Nineteen columns.' }],
    ...overrides,
  };
}
const resolve = (basis: unknown, overrides?: Partial<ContractBasisSources>) =>
  resolveContractBasis(basis, ['tests/test_functional_acceptance.py'], sources(overrides));

describe('the documents a test may rest a change on', () => {
  it.each([
    ['REQUIREMENT_ANALYSIS', [REQUIREMENT]],
    ['FUNCTIONAL_TEST', [REQUIREMENT]],
    ['HIGH_LEVEL_DESIGN', [REQUIREMENT, DESIGN]],
    ['MODULE_TEST', [REQUIREMENT, DESIGN]],
    ['DETAILED_DESIGN', [REQUIREMENT, DESIGN, DETAIL]],
    ['INTEGRATION_TEST', [REQUIREMENT, DESIGN, DETAIL]],
    ['CODE', [REQUIREMENT, DESIGN, DETAIL]],
    ['UNIT_TEST', [REQUIREMENT, DESIGN, DETAIL]],
  ] as ReadonlyArray<readonly [Phase, readonly string[]]>)('stops %s at its own level', (phase, documents) => {
    expect(contractBasisDocuments(phase, 'P2')).toEqual(documents);
  });
});

describe('resolving a contract basis', () => {
  it('accepts a verbatim clause and records where it was found', async () => {
    expect(await resolve({ reason: 'The header assertion expects sixteen columns.', document: REQUIREMENT, quote: CLAUSE })).toEqual({
      ok: true, reason: 'The header assertion expects sixteen columns.', citedContract: CLAUSE,
      citation: { kind: 'document', document: REQUIREMENT, quote: CLAUSE, revision: 'a'.repeat(40) },
    });
  });

  it('matches a clause the document wraps across lines', async () => {
    expect(await resolve({ reason: 'Stale.', document: REQUIREMENT, quote: 'wrapped clause spanning two lines of the document' }))
      .toMatchObject({ ok: true });
  });

  it('accepts a contract change this Phase accepted', async () => {
    expect(await resolve({ reason: 'Stale.', changeRequest: CHANGE_REQUEST }))
      .toMatchObject({ ok: true, citedContract: 'Nineteen columns.', citation: { kind: 'change-request', ticketId: CHANGE_REQUEST } });
  });

  it.each([
    ['no basis at all', undefined, 'missing'],
    ['an empty reason', { reason: ' ', document: REQUIREMENT, quote: CLAUSE }, 'malformed'],
    ['a field the contract does not have', { reason: 'x', document: REQUIREMENT, quote: CLAUSE, owner: 'CODE' }, 'malformed'],
    ['a document without a quote', { reason: 'x', document: REQUIREMENT }, 'malformed'],
    ['neither a document nor a change', { reason: 'x' }, 'malformed'],
    ['both a clause and a change', { reason: 'x', document: REQUIREMENT, quote: CLAUSE, changeRequest: CHANGE_REQUEST }, 'malformed'],
    ['a document above this level\'s reach', { reason: 'x', document: DETAIL, quote: CLAUSE }, 'document-not-citable'],
    ['a quote too short to identify a clause', { reason: 'x', document: REQUIREMENT, quote: '19 列' }, 'quote-too-short'],
    ['text the document does not contain', { reason: 'x', document: REQUIREMENT, quote: '失败文件的警告是否保留属于实现自由度' }, 'quote-not-found'],
    ['a change that was never accepted', { reason: 'x', changeRequest: '01a19c37-1ab6-7a79-901f-f3b107e7418c' }, 'change-request-not-accepted'],
  ])('refuses %s', async (_name, basis, kind) => {
    expect(await resolve(basis)).toMatchObject({ ok: false, kind, error: expect.any(String) });
  });

  // Codex audit: an accepted change renaming a help title was accepted as the basis for relaxing a
  // warning assertion. A Change Request authorises what it names.
  it('refuses an accepted Change Request that does not name the test', async () => {
    expect(await resolve({ reason: 'x', changeRequest: CHANGE_REQUEST }, {
      acceptedChanges: async () => [{ ticketId: CHANGE_REQUEST as never, affectedArtifacts: ['src/cli.py', 'docs/quickstart.md'], contract: 'Rename the help title.' }],
    })).toMatchObject({ ok: false, kind: 'change-request-not-covering' });
  });

  it('refuses a document that did not exist before this Ticket began', async () => {
    expect(await resolve({ reason: 'x', document: DESIGN, quote: CLAUSE })).toMatchObject({ ok: false, kind: 'quote-not-found' });
  });

  it('tells the Step what it may cite when it gave no basis', async () => {
    const refused = await resolve(undefined);
    expect(!refused.ok && refused.error).toContain(REQUIREMENT);
    expect(!refused.ok && refused.error).toContain('tests/test_functional_acceptance.py');
  });
});
