import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeProjectGraph, ProjectGraphPersistenceService } from '../../src/application/planning/project_graph_persistence_service.js';
import { reviseObjectEnvelope } from '../../src/domain/objects/object_envelope.js';
import { PhaseSchema, type Phase } from '../../src/domain/phases/phase.js';
import { DomainObjectRepository, domainObjectPath } from '../../src/infrastructure/repository/domain_object_repository.js';
import { Workspace } from '../../src/workspace/workspace.js';
import { twoPhasePlan } from '../support/two_phase_plan.js';

/**
 * dbc2excel-6 P1: delivery wrote the Phase from a copy read before the development report linked itself to
 * it. The registry refused the write, but the repository had already written that revision's file over the
 * registered one, so the stored Phase said "delivered" while the registry recorded "in_progress".
 */
describe('a write the registry refuses', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('leaves the registered revision, and what is read back, exactly as they were', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-repository-'));
    roots.push(root);
    const workspace = new Workspace(root);
    const repository = new DomainObjectRepository(workspace);
    await repository.load();
    const graph = materializeProjectGraph({ draft: twoPhasePlan(), topic: 'Export DBC signals.', projectName: 'signals' });
    await new ProjectGraphPersistenceService(repository).persistGraph(graph);
    const read = async (repo: DomainObjectRepository) => {
      const object = await repo.read(graph.phases[0]!.id);
      if (object.objectType !== 'phase') throw new Error('Expected a Phase');
      return object;
    };
    const stale: Phase = await read(repository);
    const landed = PhaseSchema.parse({ ...stale, ...reviseObjectEnvelope(stale), objective: 'Linked to its report.' });
    await repository.update(landed, landed.state);
    const registered = await workspace.readFile(domainObjectPath(landed));

    const refused = PhaseSchema.parse({ ...stale, ...reviseObjectEnvelope(stale), objective: 'Written from a stale copy.' });
    await expect(repository.update(refused, refused.state)).rejects.toThrow(/revision must advance/u);

    expect(await workspace.readFile(domainObjectPath(landed))).toBe(registered);
    expect((await read(repository)).objective).toBe('Linked to its report.');
    const reloaded = new DomainObjectRepository(workspace);
    await reloaded.load();
    expect((await read(reloaded)).objective).toBe('Linked to its report.');
  });
});
