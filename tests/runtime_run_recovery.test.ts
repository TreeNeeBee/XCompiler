import { describe, expect, it } from 'vitest';
import type { Plan, Step } from '../src/core/plan.js';
import { resetInterruptedRunningSteps } from '../src/runtime/run.js';

function step(id: string, status: Step['status']): Step {
  return {
    id,
    iterationId: 'P1',
    phase: 'CODE',
    title: id,
    description: id,
    systemPrompt: id,
    role: 'Coder',
    tools: [],
    inputs: [],
    outputs: [`src/${id}.ts`],
    subTasks: [],
    dependsOn: [],
    acceptance: id,
    status,
    retries: 4,
    maxRetries: 3,
  };
}

describe('runtime interrupted-step recovery', () => {
  it('revalidates stale RUNNING steps even when their output paths are declared', () => {
    const running = step('S004', 'RUNNING');
    const done = step('S003', 'DONE');
    const recovered = resetInterruptedRunningSteps({ steps: [done, running] } as Pick<Plan, 'steps'>);

    expect(running.status).toBe('PENDING');
    expect(running.retries).toBe(0);
    expect(done.status).toBe('DONE');
    expect(recovered).toEqual([{
      stepId: 'S004',
      status: 'PENDING',
      reason: 'interrupted before acceptance gates completed; revalidation required',
    }]);
  });
});
