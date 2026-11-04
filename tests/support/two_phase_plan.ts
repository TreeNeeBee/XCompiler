import { buildPlan } from '../../src/agents/planner.js';
import type { Phase, Plan } from '../../src/domain/planning/execution_plan.js';

/** One iteration's plan; each iteration names its baselines apart, as the dbc2excel P2 did. */
export function iterationPlan(iteration: 'P1' | 'P2'): Plan {
  const own = (file: string) => iteration === 'P1' ? file : file.replace(/\.py$/u, '_p2.py');
  const plan = twoPhasePlan();
  return {
    ...plan,
    phaseId: iteration,
    implementationPhases: [{ ...plan.implementationPhases[iteration === 'P1' ? 0 : 1]!, id: iteration, status: 'current', dependsOn: [] }],
    steps: plan.steps.map((step) => ({ ...step, iterationId: iteration,
      outputs: step.outputs.map((output) => output.startsWith('tests/') ? own(output) : output),
      inputs: step.inputs.map((input) => input.startsWith('tests/') ? own(input) : input) })),
  };
}

export function twoPhasePlan(): Plan {
  const stepOutputs: Array<{ phase: Phase; outputs: string[]; inputs?: string[] }> = [
    { phase: 'REQUIREMENT_ANALYSIS', outputs: ['docs/01-requirement-analysis.md', 'docs/tests/functional-test-plan.md', 'tests/test_functional_acceptance.py'] },
    { phase: 'HIGH_LEVEL_DESIGN', outputs: ['docs/02-high-level-design.md', 'docs/tests/module-test-plan.md', 'tests/modules/test_cli_contract.py'] },
    { phase: 'DETAILED_DESIGN', outputs: ['docs/03-detailed-design.md', 'docs/tests/integration-test-plan.md', 'tests/integration/test_pipeline_integration.py'] },
    { phase: 'CODE', outputs: ['src/main.py', 'docs/tests/unit-test-plan.md', 'tests/unit/test_cli.py'] },
    { phase: 'UNIT_TEST', outputs: ['docs/05-unit-test.md'], inputs: ['tests/unit/test_cli.py'] },
    { phase: 'INTEGRATION_TEST', outputs: ['docs/06-integration-test.md'], inputs: ['tests/integration/test_pipeline_integration.py'] },
    { phase: 'MODULE_TEST', outputs: ['docs/07-module-test.md'], inputs: ['tests/modules/test_cli_contract.py'] },
    { phase: 'FUNCTIONAL_TEST', outputs: ['README.md', 'docs/quickstart.md', 'docs/08-functional-test.md'], inputs: ['tests/test_functional_acceptance.py'] },
  ];
  const gate = { summary: 'Delivered.', checks: ['python -m pytest'], failurePolicy: 'Return findings to the owner.' };
  return buildPlan({ requirementDigest: 'Export DBC signals.', globalPrompt: 'Keep the export contract.', projectType: 'application',
    complexityAssessment: { level: 'moderate', rationale: 'Two iterations.', splitRecommended: true, userForcedPhaseSplit: false },
    implementationPhases: [
      { id: 'P1', title: 'Core', objective: 'Export signals.', status: 'current', scope: ['core'], deliverables: ['src/main.py'], dependsOn: [], verificationGate: gate },
      { id: 'P2', title: 'J1939', objective: 'Add J1939 columns.', status: 'planned', scope: ['j1939'], deliverables: ['src/main.py'], dependsOn: ['P1'], verificationGate: gate },
    ],
    dependencies: ['pytest'],
    steps: stepOutputs.map((step, index) => ({ ...step, id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1',
      title: `${step.phase} deliverables`, description: `Complete ${step.phase}.`, systemPrompt: 'Complete this Step.', tools: [],
      inputs: step.inputs ?? [], dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: 'Declared deliverables pass their checks.', maxAttempts: 3 })),
  }, { language: 'python', intent: 'feature' });
}
