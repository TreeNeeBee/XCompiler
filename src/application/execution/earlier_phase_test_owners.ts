import type { ObjectId } from '../../domain/identity/object_id.js';
import type { DomainObjectRepositoryPort } from '../../domain/ports/repository.js';
import type { TestAssetOwnerStep } from '../../domain/quality/test_assets.js';

/**
 * The Steps of every Phase before `phaseId` in its Project, as test owners: which iteration each
 * belonged to, its level, and what it declared. A Phase is read from the repository rather than
 * from its plan file, because the current plan names only the current Phase's Steps.
 */
export async function earlierPhaseTestOwners(
  repository: Pick<DomainObjectRepositoryPort, 'read'>,
  phaseId: ObjectId,
): Promise<TestAssetOwnerStep[]> {
  const phase = await repository.read(phaseId);
  if (phase.objectType !== 'phase') throw new Error(`Object ${phaseId} is not a Phase`);
  const project = await repository.read(phase.projectId);
  if (project.objectType !== 'project') throw new Error(`Object ${phase.projectId} is not a Project`);
  const index = project.phaseIds.indexOf(phase.id);
  if (index < 0) throw new Error(`Phase ${phase.name} is not part of Project ${project.name}`);
  const owners: TestAssetOwnerStep[] = [];
  for (const id of project.phaseIds.slice(0, index)) {
    const earlier = await repository.read(id);
    if (earlier.objectType !== 'phase') throw new Error(`Object ${id} is not a Phase`);
    for (const stepId of earlier.stepIds) {
      const step = await repository.read(stepId);
      if (step.objectType !== 'step') throw new Error(`Object ${stepId} is not a Step`);
      owners.push({ iteration: earlier.name, phase: step.type, outputs: step.outputs });
    }
  }
  return owners;
}
