/**
 * A delivered Phase is a release, and projects tag each version they release.
 *
 * The n-th Phase of a Project is version n: its first delivery is `v<n>.0.0`, and a delivery after it
 * was reopened is the next patch. The tag is the rollback point for the code the Phase delivered;
 * XCompiler's own Project state is not in Git and is not restored by it.
 */
export interface ReleaseTag {
  readonly name: string;
  /** The commit the tag releases: for an annotated tag, the commit it points at, not the tag object. */
  readonly revision: string;
}

export function phaseReleaseTag(phaseNumber: number, revision: string, existing: readonly ReleaseTag[]): { name: string; exists: boolean } {
  const pattern = new RegExp(`^v${phaseNumber}\\.0\\.(\\d+)$`, 'u');
  const deliveries = existing.flatMap((tag) => {
    const patch = pattern.exec(tag.name)?.[1];
    return patch === undefined ? [] : [{ ...tag, patch: Number(patch) }];
  });
  const already = deliveries.find((tag) => tag.revision === revision);
  if (already) return { name: already.name, exists: true };
  const next = deliveries.length === 0 ? 0 : Math.max(...deliveries.map((tag) => tag.patch)) + 1;
  return { name: `v${phaseNumber}.0.${next}`, exists: false };
}

export interface ReleaseTagRepository {
  releaseTags(): Promise<ReleaseTag[]>;
  createAnnotatedTag(name: string, revision: string, message: string): Promise<void>;
}

export interface PhaseRelease {
  projectName: string;
  phaseName: string;
  /** The Phase's position in its Project, from 1: its version number. */
  phaseNumber: number;
  /** The revision the Phase delivered. */
  revision: string;
}

/** Tags a delivered Phase, unless that very delivery already carries its tag. The message is a record, in English. */
export async function tagPhaseRelease(repository: ReleaseTagRepository, release: PhaseRelease): Promise<{ name: string; created: boolean }> {
  const tag = phaseReleaseTag(release.phaseNumber, release.revision, await repository.releaseTags());
  if (tag.exists) return { name: tag.name, created: false };
  await repository.createAnnotatedTag(tag.name, release.revision,
    `${release.projectName} ${release.phaseName} delivered\n\nXCompiler delivered Phase ${release.phaseName} at ${release.revision}.`);
  return { name: tag.name, created: true };
}
