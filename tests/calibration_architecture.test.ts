import { describe, expect, it } from 'vitest';
import { calibrateArchitectureStepMappings } from '../src/agents/calibration.js';
import { validateArchitectureContract, type ArchitectureDemand } from '../src/core/architecture.js';
import type { ArchitectureModule, Step } from '../src/core/plan.js';

function step(overrides: Partial<Step> & Pick<Step, 'id' | 'phase'>): Step {
  return {
    id: overrides.id,
    phase: overrides.phase,
    title: overrides.title ?? 'Step ' + overrides.id,
    description: overrides.description ?? 'Execute one bounded task.',
    systemPrompt: overrides.systemPrompt ?? 'Only produce the declared outputs and keep changes scoped.',
    role: overrides.role ?? 'Coder',
    tools: overrides.tools ?? ['write_file'],
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? [],
    dependsOn: overrides.dependsOn ?? [],
    acceptance: overrides.acceptance ?? 'Declared outputs exist.',
    status: 'PENDING',
    retries: 0,
    maxRetries: 3,
  };
}

describe('calibrateArchitectureStepMappings', () => {
  it('splits CODE and TEST steps that cover multiple architecture modules', () => {
    const modules: ArchitectureModule[] = [
      {
        id: 'M001',
        name: 'Holiday',
        responsibility: 'Fetch and calculate holiday data.',
        sourcePaths: ['src/holiday_service.py'],
        testPaths: ['tests/test_holiday_service.py'],
        dependencies: [],
      },
      {
        id: 'M002',
        name: 'Models',
        responsibility: 'Define shared data models.',
        sourcePaths: ['src/models.py'],
        testPaths: ['tests/test_models.py'],
        dependencies: [],
      },
      {
        id: 'M003',
        name: 'CLI',
        responsibility: 'Compose services and print output.',
        sourcePaths: ['src/main.py'],
        testPaths: ['tests/test_cli.py'],
        dependencies: ['M001', 'M002'],
      },
    ];
    const rawSteps = [
      step({ id: 'S001', phase: 'REQUIREMENT', role: 'Planner', outputs: ['docs/01-requirement.md'] }),
      step({ id: 'S002', phase: 'ARCH', role: 'Architect', outputs: ['docs/02-architecture.md'], dependsOn: ['S001'] }),
      step({ id: 'S003', phase: 'TASK', role: 'Planner', outputs: ['docs/03-tasks.md'], dependsOn: ['S002'] }),
      step({
        id: 'S004',
        phase: 'CODE',
        outputs: ['src/holiday_service.py', 'src/models.py'],
        dependsOn: ['S003'],
      }),
      step({ id: 'S005', phase: 'CODE', outputs: ['src/main.py'], dependsOn: ['S004'] }),
      step({
        id: 'S006',
        phase: 'TEST',
        role: 'Tester',
        outputs: ['tests/test_holiday_service.py', 'tests/test_models.py'],
        dependsOn: ['S004'],
      }),
      step({ id: 'S007', phase: 'TEST', role: 'Tester', outputs: ['tests/test_cli.py'], dependsOn: ['S005'] }),
    ];
    const calibrated = calibrateArchitectureStepMappings(rawSteps, modules);
    const codeSteps = calibrated.filter((item) => item.phase === 'CODE');
    expect(codeSteps.map((item) => item.outputs)).toEqual([
      ['src/holiday_service.py'],
      ['src/models.py'],
      ['src/main.py'],
    ]);

    const cliStep = codeSteps.find((item) => item.outputs.includes('src/main.py'));
    expect(cliStep?.dependsOn).toEqual(expect.arrayContaining(['S004', 'S005']));

    const testSteps = calibrated.filter((item) => item.phase === 'TEST');
    expect(testSteps.map((item) => item.outputs)).toEqual([
      ['tests/test_holiday_service.py'],
      ['tests/test_models.py'],
      ['tests/test_cli.py'],
    ]);

    const modelsTest = testSteps.find((item) => item.outputs.includes('tests/test_models.py'));
    expect(modelsTest?.dependsOn).toEqual(expect.arrayContaining(['S005']));

    const cliTest = testSteps.find((item) => item.outputs.includes('tests/test_cli.py'));
    expect(cliTest?.dependsOn).toEqual(expect.arrayContaining(['S006']));

    const demand: ArchitectureDemand = {
      nonTrivial: true,
      surfaces: ['cli', 'integration'],
      baselineModules: 0,
      minModules: 3,
      minCodeSteps: 3,
      reasonLabel: 'test',
    };
    expect(validateArchitectureContract(modules, calibrated, 'python', demand)).toEqual([]);
  });
});
