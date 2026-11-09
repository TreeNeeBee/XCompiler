import { describe, expect, it } from 'vitest';
import { collectDeliveryListing, renderDeliveryListing } from '../src/application/reporting/delivery_listing.js';
import { tFor } from '../src/i18n/index.js';

const P1 = 'a'.repeat(40);
const P2 = 'b'.repeat(40);
const objects = new Map<string, Record<string, unknown>>([
  ['project', { objectType: 'project', id: 'project', phaseIds: ['phase-1', 'phase-2'] }],
  ['phase-1', { objectType: 'phase', id: 'phase-1', projectId: 'project', name: 'P1', deliveredRevision: P1 }],
  ['phase-2', { objectType: 'phase', id: 'phase-2', projectId: 'project', name: 'P2', deliveredRevision: P2 }],
]);
const files: Record<string, string[]> = {
  [P1]: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md', 'src/main.py'],
  [P2]: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md', 'docs/iterations/P2/08-functional-test.md',
    'docs/project-development-report.P1.md', 'docs/project-development-report.md', 'src/main.py', 'src/parser.py'],
};

async function listing(projectDelivered: boolean) {
  return collectDeliveryListing({
    repository: { read: async (id: string) => objects.get(id) } as never,
    phaseId: 'phase-2' as never,
    projectType: 'application',
    projectDelivered,
    gate: [{ name: 'tests', ok: true, summary: 'tests passed' }],
    releaseTags: async () => [{ name: 'v1.0.0', revision: P1 }, { name: 'v2.0.0', revision: P2 }],
    filesAt: async (revision) => files[revision] ?? [],
  });
}

describe('the delivery listing', () => {
  it('reads what the delivered revision holds, and the tag that releases it', async () => {
    const delivered = await listing(false);

    expect(delivered.phase).toEqual({
      phaseName: 'P2',
      revision: P2,
      tag: 'v2.0.0',
      // Only documents the release contains; P1's report is a file, not this Phase's document.
      documents: [
        { kind: 'readme', path: 'README.md' },
        { kind: 'quickstart', path: 'docs/quickstart.md' },
        { kind: 'delivery', path: 'docs/iterations/P2/08-functional-test.md' },
      ],
    });
    expect(delivered.files).toEqual(files[P2]);
    expect(delivered.project).toBeUndefined();
  });

  it('adds every Phase of the project once the project is delivered', async () => {
    const delivered = await listing(true);

    expect(delivered.phase.documents).toContainEqual({ kind: 'report', path: 'docs/project-development-report.md' });
    expect(delivered.project?.phases.map((phase) => [phase.phaseName, phase.tag])).toEqual([['P1', 'v1.0.0'], ['P2', 'v2.0.0']]);
    expect(delivered.project?.phases[0]!.documents.map((document) => document.path))
      .toEqual(['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md']);
  });

  it('prints the release, the gate, and the files grouped by directory', async () => {
    const lines = renderDeliveryListing(await listing(true), tFor('en').deliveryListing);

    expect(lines[0]).toBe('P2 delivery');
    expect(lines).toContain(`Release: v2.0.0 (commit ${P2.slice(0, 12)})`);
    expect(lines).toContain('  ✔ tests — tests passed');
    expect(lines).toContain('  src/ (2)');
    expect(lines).toContain('    parser.py');
    expect(lines).toContain('  (root) (1)');
    expect(lines).toContain('Project delivery');
  });
});
