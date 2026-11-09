import type { ObjectId } from '../../domain/identity/object_id.js';
import type { ProjectType } from '../../domain/planning/execution_plan.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { Phase } from '../../domain/phases/phase.js';
import { DOC_NAMES, deliveryDocForIteration } from '../../domain/planning/document_contract.js';
import type { ReleaseTag } from '../project_management/phase_release_tag.js';
import type { Messages } from '../../i18n/types.js';
import { developmentReportPath } from './project_report.js';

export type DeliveredDocumentKind = 'readme' | 'quickstart' | 'apiGuide' | 'delivery' | 'report';

export interface DeliveredPhaseListing {
  phaseName: string;
  /** The revision the Phase delivered; absent for a Phase delivered before deliveries were recorded. */
  revision?: string;
  tag?: string;
  /** The user-facing documents the release holds, each only when the release actually contains it. */
  documents: Array<{ kind: DeliveredDocumentKind; path: string }>;
}

export interface DeliveryGateCheckSummary {
  name: string;
  ok: boolean;
  summary: string;
}

export interface DeliveryListing {
  phase: DeliveredPhaseListing;
  gate: DeliveryGateCheckSummary[];
  /** The files the delivered revision holds. */
  files: string[];
  /** Every Phase the project delivered, and the files of its final release — only once the project is delivered. */
  project?: { phases: DeliveredPhaseListing[]; files: string[] };
}

/**
 * What a delivery released, read back from the records and the repository rather than from what the run believes
 * it wrote: the revision recorded on the Phase, the tag that points at it, and the files that revision holds.
 */
export async function collectDeliveryListing(input: {
  repository: DomainObjectRepositoryPort;
  phaseId: ObjectId;
  projectType: ProjectType;
  projectDelivered: boolean;
  gate: readonly DeliveryGateCheckSummary[];
  releaseTags: () => Promise<ReleaseTag[]>;
  filesAt: (revision: string) => Promise<string[]>;
}): Promise<DeliveryListing> {
  const phase = await input.repository.read(input.phaseId);
  if (phase.objectType !== 'phase') throw new Error(`Object ${input.phaseId} is not a Phase`);
  const tags = await input.releaseTags();
  const filesAt = async (revision: string | undefined) => (revision ? input.filesAt(revision) : []);
  const describe = async (delivered: Phase, final: boolean): Promise<DeliveredPhaseListing> => {
    const files = new Set(await filesAt(delivered.deliveredRevision));
    const candidates: Array<{ kind: DeliveredDocumentKind; path: string }> = [
      { kind: 'readme', path: DOC_NAMES.readme },
      { kind: 'quickstart', path: DOC_NAMES.quickstart },
      ...(input.projectType === 'library' || input.projectType === 'mixed'
        ? [{ kind: 'apiGuide' as const, path: DOC_NAMES.apiGuide }]
        : []),
      { kind: 'delivery', path: deliveryDocForIteration(delivered.name) },
      { kind: 'report', path: developmentReportPath(delivered.name, final) },
    ];
    return {
      phaseName: delivered.name,
      revision: delivered.deliveredRevision,
      tag: tags.find((tag) => tag.revision === delivered.deliveredRevision)?.name,
      documents: candidates.filter((document) => files.has(document.path)),
    };
  };
  const listing: DeliveryListing = {
    phase: await describe(phase, input.projectDelivered),
    gate: [...input.gate],
    files: await filesAt(phase.deliveredRevision),
  };
  if (!input.projectDelivered) return listing;
  const project = await input.repository.read(phase.projectId);
  if (project.objectType !== 'project') return listing;
  const phases = (await Promise.all(project.phaseIds.map((id) => input.repository.read(id))))
    .filter((object): object is Phase => object.objectType === 'phase');
  return {
    ...listing,
    project: {
      phases: await Promise.all(phases.map((delivered) => describe(delivered, delivered.id === phase.id))),
      files: listing.files,
    },
  };
}

/** Renders the listing as terminal lines; files are grouped under their top-level directory. */
export function renderDeliveryListing(listing: DeliveryListing, text: Messages['deliveryListing']): string[] {
  const lines = [text.phaseHeading(listing.phase.phaseName), ...renderPhase(listing.phase, text)];
  if (listing.gate.length > 0) {
    lines.push(text.gate);
    for (const check of listing.gate) lines.push(`  ${check.ok ? '✔' : '✘'} ${check.name} — ${check.summary}`);
  }
  lines.push(...renderFiles(listing.files, text));
  if (listing.project) {
    lines.push('', text.projectHeading);
    for (const phase of listing.project.phases) {
      lines.push(`  ${phase.phaseName}`, ...renderPhase(phase, text).map((line) => `  ${line}`));
    }
    lines.push(...renderFiles(listing.project.files, text));
  }
  return lines;
}

function renderPhase(phase: DeliveredPhaseListing, text: Messages['deliveryListing']): string[] {
  const lines = [phase.revision ? text.release(phase.tag, phase.revision.slice(0, 12)) : text.noRevision];
  if (phase.documents.length > 0) {
    lines.push(text.documents);
    for (const document of phase.documents) lines.push(`  ${text.documentKind[document.kind]}: ${document.path}`);
  }
  return lines;
}

function renderFiles(files: readonly string[], text: Messages['deliveryListing']): string[] {
  if (files.length === 0) return [];
  const groups = new Map<string, string[]>();
  for (const file of [...files].sort((left, right) => left.localeCompare(right))) {
    const slash = file.indexOf('/');
    const group = slash < 0 ? '' : file.slice(0, slash + 1);
    groups.set(group, [...(groups.get(group) ?? []), slash < 0 ? file : file.slice(slash + 1)]);
  }
  const lines = [text.files(files.length)];
  for (const [group, members] of groups) {
    lines.push(`  ${group || text.rootGroup} (${members.length})`);
    for (const member of members) lines.push(`    ${member}`);
  }
  return lines;
}
