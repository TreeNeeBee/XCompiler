import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildPlan } from '../../src/agents/planner.js';
import { runCompile } from '../../src/runtime/build.js';
import type { RuntimeIO, RuntimeInteraction } from '../../src/runtime/io.js';
import { DEFAULT_MODEL_POOLS } from '../../src/domain/workflow/role.js';
import type { BusinessRequestInput } from '../../src/application/execution/business_request_input.js';
import type { AuditEvent } from '../../src/audit/audit.js';
import type { ChatMessage } from '../../src/llm/types.js';
import type { PhasePlan } from '../../src/domain/planning/phase_plan_checkpoint.js';
import * as i18n from '../../src/i18n/index.js';
import { clarificationPromptLimit, phasePlanReserveTokens } from '../../src/application/planning/requirement_intake.js';
import { InteractionDismissedError } from '../../src/runtime/io.js';
import type { XCompilerPlugin } from '../../src/plugins/types.js';
import { XCOMPILER_PLUGIN_API_VERSION } from '../../src/version.js';
import { deliveryDocsForIteration, phaseDocForIteration, testPlanDocForIteration } from '../../src/domain/planning/document_contract.js';
import { REQUIRED_V_MODEL_PHASES, type Phase } from '../../src/domain/planning/execution_plan.js';

/**
 * Which role actually spoke, observed from the wire.
 *
 * `build` picks its clients from the router by role name, and nothing downstream carries that name:
 * `router.forPool(role)` returns a client identified by its *provider*, so a role swap is invisible to
 * every assertion made inside the process. Giving each role its own provider with its own model
 * string turns the choice into something the request itself reports — which is the only way a test
 * can tell a Planner-voiced clarification from a PM-voiced one.
 */
const MODEL_FOR_POOL = Object.fromEntries(
  DEFAULT_MODEL_POOLS.map((role) => [role, `model-${role.toLowerCase()}`]),
) as Record<(typeof DEFAULT_MODEL_POOLS)[number], string>;

interface Captured {
  model: string;
  prompt: string;
  messages: ChatMessage[];
}

/**
 * The shipped example config with only its providers swapped for the loopback server.
 *
 * Hand-writing a minimal config here would be a second, quietly diverging statement of what a valid
 * config is — the first thing to rot when a schema section is added, and it would rot into a test
 * failure that says nothing about the behaviour under test.
 */
async function writeConfig(
  root: string, baseUrl: string, sections: Record<string, unknown> = {}, configure?: (config: Record<string, unknown>) => void,
): Promise<string> {
  const example = YAML.parse(await fs.readFile(path.resolve('config.example.yaml'), 'utf8')) as {
    llm: { providers: Record<string, unknown>; pools: Record<string, string[]> };
  } & Record<string, unknown>;
  Object.assign(example, sections);
  example.llm.providers = Object.fromEntries(DEFAULT_MODEL_POOLS.map((role) => [`p_${role}`, {
    type: 'openai',
    api_key: '',
    base_url: baseUrl,
    model: MODEL_FOR_POOL[role],
    context_window: '128K',
    connect_timeout_ms: 5_000,
    request_timeout_ms: 15_000,
    stream_first_token_timeout_ms: 10_000,
    stream_idle_timeout_ms: 10_000,
  }]));
  example.llm.pools = Object.fromEntries(DEFAULT_MODEL_POOLS.map((role) => [role, [`p_${role}`]]));
  configure?.(example);
  const configPath = path.join(root, 'config.yaml');
  await fs.writeFile(configPath, YAML.stringify(example));
  return configPath;
}

const RESOLVED = { functionality: 'resolved', data: 'resolved', acceptance: 'resolved', boundary: 'resolved', quality: 'resolved', extensibility: 'resolved' };
const FEASIBLE = { verdict: 'feasible', blockers: [] };
/** A clarification turn reporting nothing left open. */
const ASSUMPTION = 'The report lists one row per input line, with a header row.';
const CLEAR_TURN = JSON.stringify({ status: 'clear', coverage: RESOLVED, feasibility: FEASIBLE, summary: 'The report tool is settled.', assumptions: [ASSUMPTION] });
/** A clarification turn judging the requirement undeliverable, offering `feasibleScope` when given. */
const INFEASIBLE_DETAIL = 'A native iOS app needs a mobile target.';
const infeasibleTurn = (feasibleScope?: string) => JSON.stringify({ status: 'infeasible', coverage: { ...RESOLVED, functionality: 'open' },
  feasibility: { verdict: 'infeasible', blockers: [{ kind: 'platform', detail: INFEASIBLE_DETAIL }] },
  summary: 'It is a native mobile app.', ...(feasibleScope ? { feasibleScope } : {}) });
/** A clarification turn asking `question`, with functionality still open. */
const askTurn = (question: string) => JSON.stringify({ status: 'ask', coverage: { ...RESOLVED, functionality: 'open' }, feasibility: FEASIBLE,
  question: { category: 'functionality', question, why: 'scope', options: [{ label: 'A', answer: 'read only' }, { label: 'B', answer: 'read and write' }] } });

const PHASE_PLAN_ANSWER = JSON.stringify({
  requirementDigest: 'Build a small Python command that prints one greeting.',
  globalPrompt: 'Keep the accepted greeting unchanged.',
  projectType: 'application',
  complexityAssessment: { level: 'simple', rationale: 'One small command.', splitRecommended: false, userForcedPhaseSplit: false },
  implementationPhases: [{ id: 'P1', title: 'Greeting command', objective: 'Print one greeting.', status: 'current',
    scope: ['Print the greeting.'], deliverables: ['src/main.py'], dependsOn: [],
    deliveryGate: { kind: 'phase-delivery', summary: 'Verify the greeting command.', checks: ['Run the command.'],
      testAssetPolicy: 'phase-aggregate', externalDataPolicy: 'live', freezeBeforeExecution: true, routeEachFinding: true,
      scenarios: [{ name: 'greeting', description: 'Run the greeting as a user.', operation: 'Run the Python command.',
        environment: 'live', expected: 'Print the accepted greeting.', execution: { command: 'python', args: ['src/main.py'] } }],
    },
  }],
});

/** P1's Step plan for PHASE_PLAN_ANSWER, complete enough to pass decomposition and plan checks, so a build reaches Gate 2. */
const STEP_PLAN_ANSWER = (() => {
  const paired: Partial<Record<Phase, Phase>> = {
    REQUIREMENT_ANALYSIS: 'FUNCTIONAL_TEST', HIGH_LEVEL_DESIGN: 'MODULE_TEST', DETAILED_DESIGN: 'INTEGRATION_TEST', CODE: 'UNIT_TEST',
  };
  const testPath = (phase: Phase) => `tests/test_${phase.toLowerCase()}_p1.py`;
  const steps = REQUIRED_V_MODEL_PHASES.map((phase, index) => {
    const outputs = phase === 'FUNCTIONAL_TEST' ? [...deliveryDocsForIteration('application', 'P1')]
      : phaseDocForIteration(phase, 'P1') ? [phaseDocForIteration(phase, 'P1')!] : [];
    const testPhase = paired[phase];
    if (testPhase) outputs.push(testPlanDocForIteration(testPhase, 'P1')!, testPath(testPhase));
    if (phase === 'CODE') outputs.push('src/main.py');
    return { id: `S${String(index + 1).padStart(3, '0')}`, iterationId: 'P1', phase, title: `${phase} greeting slice`,
      description: 'Deliver the greeting slice.', systemPrompt: 'Produce the declared greeting deliverables and paired test assets.',
      tools: phase === 'CODE' ? ['read_file'] : [],
      inputs: ['UNIT_TEST', 'INTEGRATION_TEST', 'MODULE_TEST', 'FUNCTIONAL_TEST'].includes(phase) ? [testPath(phase)] : [], outputs,
      dependsOn: index === 0 ? [] : [`S${String(index).padStart(3, '0')}`],
      acceptance: 'Declared deliverables and the greeting contract pass.', maxAttempts: 3 };
  });
  return JSON.stringify({ dependencies: ['pytest'], architectureModules: [{ id: 'M001', name: 'Greeter', responsibility: 'Print one greeting.',
    sourcePaths: ['src/main.py'], testPaths: [testPath('MODULE_TEST')], dependencies: [] }], steps });
})();

describe('build speaks to the user as PM', () => {
  let server: Server;
  let baseUrl = '';
  let root = '';
  let captured: Captured[] = [];
  let outputForCall: (call: number, model: string, prompt: string) => string;

  beforeEach(async () => {
    captured = [];
    outputForCall = () => CLEAR_TURN;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        // Anything without a chat body — a capability probe, a models listing — is not a role
        // speaking, and must not be recorded as one.
        const request = body.trim().startsWith('{')
          ? JSON.parse(body) as { model?: string; messages?: ChatMessage[] }
          : {};
        if (!request.model || !request.messages) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"data":[]}');
          return;
        }
        captured.push({
          model: request.model,
          prompt: request.messages.map((message) => message.content).join('\n'),
          messages: request.messages,
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ model: request.model, choices: [{ index: 0,
          delta: { content: outputForCall(captured.length, request.model, captured.at(-1)!.prompt) }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ model: request.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-build-role-'));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * Stops at Gate 1 with `cancel`: clarify is the subject, and everything after it would drag the
   * whole decompose pipeline into a test about who asks the questions.
   */
  const cancellingIO = (): RuntimeIO => {
    const interaction: RuntimeInteraction = {
      input: async () => 'A',
      confirm: async () => false,
      editor: async () => '',
      select: async <T extends string>(args: { choices: Array<{ value: T }> }) =>
        (args.choices.find((choice) => choice.value === ('cancel' as T))?.value ?? args.choices[0]!.value),
      readMultiline: async () => '',
    };
    return {
      terminalOutput: false,
      permissionPolicy: 'deny',
      emit: () => undefined,
      progress: () => ({ succeed: () => undefined, fail: () => undefined, stop: () => undefined }),
      interaction,
    };
  };

  const run = async () => {
    const configPath = await writeConfig(root, baseUrl);
    const inputFile = path.join(root, 'requirement.md');
    await fs.writeFile(inputFile, 'Build a small tool that summarizes a local text file into a report.\n');
    return runCompile({
      workspace: path.join(root, 'container'),
      name: 'role-wiring',
      configPath,
      inputFile,
      io: cancellingIO(),
    });
  };

  // The role that asks the user to clarify their own project is PM's, not the planner's. A planner
  // negotiating the scope it is about to plan is the executor deciding its own brief; the finding
  // and the follow-up both belong to PM, so the question must come from PM too.
  it('asks its clarification questions with the ProjectManager role', { timeout: 30_000 }, async () => {
    await run();

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.model).toBe(MODEL_FOR_POOL.management);
    // Not merely "some PM call happened somewhere": no executing role may speak before Gate 1.
    expect(captured.map((call) => call.model)).not.toContain(MODEL_FOR_POOL.planning);
  });

  it('injects the retained clarification port at the actual Build PM call before Gate 1', { timeout: 30_000 }, async () => {
    const configPath = await writeConfig(root, baseUrl);
    const inputFile = path.join(root, 'requirement.md');
    const originalRequirement = 'Build a small tool that summarizes a local text file into a report.\n';
    await fs.writeFile(inputFile, originalRequirement);
    const containerRoot = path.join(root, 'clarification-port-container');
    // Cancel the real Gate 1 after its question conversation. Planning and Domain publication
    // are unnecessary to prove that this specific Build call uses the retained PM boundary.
    await runCompile({ workspace: containerRoot, name: 'clarification-port', configPath, inputFile, io: cancellingIO() });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.model).toBe(MODEL_FOR_POOL.management);
    expect(captured[0]!.messages).toHaveLength(3);
    expect(captured[0]!.messages[0]!.content).toContain('这三条声明不授予任何文件系统或网络访问权限');
    expect(captured[0]!.messages[0]!.content).not.toContain('Author comments never enter prompts');
    const auditPath = path.join(containerRoot, '.xcompiler', 'audit', 'audit.jsonl');
    const events = (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent);
    const capturedInputs = events.filter((event) => event.messageId === 'llm.business_request_input'
      && (event.data!.input as BusinessRequestInput).auditContext?.kind === 'planning-clarification');
    expect(capturedInputs).toHaveLength(1);
    const original = capturedInputs[0]!.data!.input as BusinessRequestInput;
    expect(original.owner).toMatchObject({ kind: 'planning-operation', operation: 'clarification', operationId: expect.any(String) });
    expect(original.owner).not.toHaveProperty('projectId');
    expect(original.owner).not.toHaveProperty('phaseId');
    expect(original.templateVersion).toBe('planning-clarification/2');
    expect(original.outputProtocol).toMatchObject({ id: 'planning-clarification', version: '2', root: 'any' });
    expect(original.messages).toEqual(captured[0]!.messages.slice(1));
    expect(original.messages[1]!.content).toContain(originalRequirement.trim());
    expect(original.messages[1]!.content.trimStart().startsWith('{')).toBe(false);
    // The language was asked first (the select picked Python); the deliverable was read from the
    // requirement, so the model's turn is Q2 and sees the language answer in its transcript.
    expect(original.auditContext).toMatchObject({ kind: 'planning-clarification', parseContext: {
      language: 'python', rawRequirement: originalRequirement, intent: 'greenfield',
      hasBaseline: false, projectType: 'application', externalApiRequired: false,
      sandbox: { mode: 'subprocess', network: 'download-only' },
      questionId: 'Q2', budgetUsedPercent: expect.any(Number), finalAssessment: null, transcript: [{ id: 'Q1', category: 'boundary' }],
    } });
    const logicalRequestId = original.logicalRequestId;
    const retained = events.filter((event) => event.messageId === 'llm.business_response_retained');
    expect(retained).toHaveLength(1);
    expect(retained[0]!.data!.logicalRequestId).toBe(logicalRequestId);
    const judgement = events.filter((event) => event.messageId === 'llm.clarification_judgement');
    expect(judgement).toHaveLength(1);
    expect(judgement[0]!.data).toMatchObject({ logicalRequestId, owner: original.owner,
      responseRecordId: expect.any(String), protocolResultId: expect.any(String) });
    expect(events.filter((event) => event.messageId === 'llm.business_protocol_result')).toHaveLength(1);
    expect(events.find((event) => event.messageId === 'llm.business_request_attempt')!.data)
      .toMatchObject({ request: { logicalRequestId, role: 'project-manager' } });
    const snapshot = JSON.parse(await fs.readFile(path.join(containerRoot, '.xcompiler', 'rules', 'requests', 'snapshots', `${logicalRequestId}.json`), 'utf8'));
    expect(snapshot).toMatchObject({ context: { role: 'project-manager', work: 'plan.clarify', language: 'python', locale: 'zh' } });
    // Genesis (3), the base segment (7 level definitions, 1 output language) and the clarifying role's
    // identity, rendered in the build's locale.
    expect(snapshot.requiredRuleIds).toHaveLength(12);
    expect(captured[0]!.messages[0]!.content).toContain('你是一名经验丰富的软件项目经理');
    // config.locale chooses the output-language variant the request carries (revision 6.2).
    expect(captured[0]!.messages[0]!.content).toContain('都使用中文');
    expect(captured[0]!.messages[0]!.content).not.toContain('in English, unless');
    // The framework declaration and level meanings follow the same locale.
    expect(captured[0]!.messages[0]!.content).toContain('以下规则按 RuleList 分组');
    expect(captured[0]!.messages[0]!.content).toContain('[announce · 声明]');
    expect(snapshot.context).not.toHaveProperty('projectId');
    const metadata = JSON.parse(await fs.readFile(path.join(containerRoot, '.xcompiler', 'llm', 'business-inputs', 'requests', `${logicalRequestId}.json`), 'utf8'));
    expect(metadata).not.toHaveProperty('auditContext');
    expect(metadata).not.toHaveProperty('messages');
    await expect(fs.stat(path.join(containerRoot, '.xcompiler', 'llm', 'business-inputs', 'responses', `${logicalRequestId}.json`))).resolves.toBeDefined();
    await expect(fs.stat(path.join(containerRoot, 'phasePlan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The other half of the boundary: PM owns the conversation, not the planning. Routing the whole
  // build through PM would be the same mistake pointed the other way — the role that judges the
  // delivery would also be the role that wrote the plan being judged.
  it('still plans with the Planner role once there is nothing left to ask', { timeout: 30_000 }, async () => {
    const configPath = await writeConfig(root, baseUrl);
    const topicFile = path.join(root, 'topic.md');
    // A topic input is a clarification that already happened; re-asking would discard it.
    await fs.writeFile(topicFile, '# Topic\n\nA frozen, already-clarified topic.\n');

    // Decompose runs against a server that only knows how to answer clarify, so this ends in a
    // parse failure. What it got as far as asking, and in whose voice, is the subject here.
    await runCompile({
      workspace: path.join(root, 'container'),
      name: 'role-wiring-topic',
      configPath,
      topicFile,
      io: cancellingIO(),
    }).catch(() => undefined);

    // Non-empty is the guard that keeps this from passing when the config fails to load at all.
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.model).toBe(MODEL_FOR_POOL.planning);
    expect(captured.map((call) => call.model)).not.toContain(MODEL_FOR_POOL.management);
  });

  it('passes a readable incremental baseline through Runtime to the planning request', { timeout: 30_000 }, async () => {
    const configPath = await writeConfig(root, baseUrl);
    const topicFile = path.join(root, 'topic.md');
    await fs.writeFile(topicFile, '# Topic\n\nImprove the existing report output.\n');
    const baselinePlanFile = path.join(root, 'baseline-plan.json');
    const requirementDigest = 'The existing report preserves the source row order and includes an audit footer.';
    const baseline = buildPlan({
      requirementDigest,
      globalPrompt: 'Preserve the existing reporting behavior.',
      dependencies: [],
      steps: [{
        id: 'S001', iterationId: 'P1', phase: 'REQUIREMENT_ANALYSIS',
        title: 'Requirement', description: 'Record the reporting contract.',
        systemPrompt: 'Document the accepted reporting requirement.',
        tools: ['write_file'], inputs: [], outputs: ['docs/01-requirement-analysis.md'],
        dependsOn: [], acceptance: 'The reporting contract is recorded.', maxAttempts: 3,
      }],
    }, { language: 'typescript', intent: 'refactor' });
    // The current-schema baseline is readable even though this one-Step draft cannot execute.
    await fs.writeFile(baselinePlanFile, JSON.stringify(baseline));

    // The loopback server only supplies clarification replies, so planning must reject its reply.
    // Observe the outbound baseline before that boundary; no completed plan is claimed here.
    await expect(runCompile({
      workspace: path.join(root, 'container'),
      name: 'incremental-wiring', configPath, topicFile, baselinePlanFile,
      intent: 'refactor', io: cancellingIO(),
    })).rejects.toThrow();

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.model).toBe(MODEL_FOR_POOL.planning);
    expect(captured[0]!.prompt).toContain('## Existing plan summary');
    expect(captured[0]!.prompt).toContain(requirementDigest);
  });

  it('injects the retained PhasePlan port at the actual Build planning call', { timeout: 30_000 }, async () => {
    outputForCall = (call) => call === 1 ? PHASE_PLAN_ANSWER : '{}';
    const configPath = await writeConfig(root, baseUrl);
    const topicFile = path.join(root, 'topic.md');
    const originalTopic = '# Topic\n\nBuild a small Python command that prints one greeting.\n';
    await fs.writeFile(topicFile, originalTopic);
    const containerRoot = path.join(root, 'phase-plan-port-container');
    // Step decomposition intentionally fails after the PhasePlan checkpoint. No Step/Domain
    // transition is needed to prove that Build injected and used the retained request port.
    await expect(runCompile({ workspace: containerRoot, name: 'phase-plan-port', configPath, topicFile,
      io: cancellingIO(),
    })).rejects.toThrow();
    expect(captured.length).toBeGreaterThan(1);
    expect(captured[0]!.model).toBe(MODEL_FOR_POOL.planning);
    expect(captured[0]!.messages).toHaveLength(3);
    expect(captured[0]!.messages[0]!.content).toContain('这三条声明不授予任何文件系统或网络访问权限');
    expect(captured[0]!.messages[0]!.content).not.toContain('Author comments never enter prompts');
    const auditPath = path.join(containerRoot, '.xcompiler', 'audit', 'audit.jsonl');
    const events = (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent);
    const capturedInputs = events.filter((event) => event.messageId === 'llm.business_request_input'
      && (event.data!.input as BusinessRequestInput).auditContext?.kind === 'planning-phase-plan');
    expect(capturedInputs).toHaveLength(1);
    const original = capturedInputs[0]!.data!.input as BusinessRequestInput;
    expect(original.owner).toMatchObject({ kind: 'planning-operation', operation: 'phase-plan', operationId: expect.any(String) });
    expect(original.owner).not.toHaveProperty('projectId');
    expect(original.templateVersion).toBe('planning-phase-plan/1');
    expect(original.messages).toEqual(captured[0]!.messages.slice(1));
    expect(original.messages[1]!.content).toContain(originalTopic.trim());
    expect(original.messages[1]!.content.trimStart().startsWith('{')).toBe(false);
    expect(original.auditContext).toMatchObject({ parseContext: { language: 'python', rawRequirement: originalTopic } });
    const logicalRequestId = original.logicalRequestId;
    const retained = events.filter((event) => event.messageId === 'llm.business_response_retained');
    expect(retained).toHaveLength(1);
    expect(retained[0]!.data!.logicalRequestId).toBe(logicalRequestId);
    expect(events.filter((event) => event.messageId === 'llm.business_protocol_result')).toHaveLength(1);
    expect(events.find((event) => event.messageId === 'llm.business_request_attempt')!.data)
      .toMatchObject({ request: { logicalRequestId, role: 'planner' } });
    const snapshot = JSON.parse(await fs.readFile(path.join(containerRoot, '.xcompiler', 'rules', 'requests', 'snapshots', `${logicalRequestId}.json`), 'utf8'));
    expect(snapshot).toMatchObject({ context: { role: 'planner', work: 'plan.phase' } });
    // Genesis, the base segment and the planner identity: phase planning binds no language list.
    expect(snapshot.requiredRuleIds).toHaveLength(12);
    expect(captured[0]!.messages[0]!.content).toContain('你是一名经验丰富的软件规划师');
    expect(snapshot.context).not.toHaveProperty('projectId');
    const inputMetadata = JSON.parse(await fs.readFile(path.join(containerRoot, '.xcompiler', 'llm', 'business-inputs', 'requests', `${logicalRequestId}.json`), 'utf8'));
    expect(inputMetadata).not.toHaveProperty('auditContext');
    expect(inputMetadata).not.toHaveProperty('messages');
    await expect(fs.stat(path.join(containerRoot, '.xcompiler', 'llm', 'business-inputs', 'responses', `${logicalRequestId}.json`))).resolves.toBeDefined();
    const checkpoint = JSON.parse(await fs.readFile(path.join(containerRoot, 'phasePlan.json'), 'utf8'));
    expect(checkpoint.requirementDigest).toBe(JSON.parse(PHASE_PLAN_ANSWER).requirementDigest);
    // The actual initial decomposition is also retained. Removing Build's ninth Planner argument
    // must fail this assertion before any legacy/direct send can make it look like phase decomposition was wired.
    const decompositions = events.filter(event => event.messageId === 'llm.business_request_input')
      .map(event => event.data!.input as BusinessRequestInput)
      .filter(input => input.auditContext?.kind === 'planning-phase-decomposition');
    expect(decompositions).toHaveLength(2);
    expect(decompositions[0]!.owner).toMatchObject({ kind: 'planning-operation', operation: 'phase-decomposition' });
    expect(decompositions[0]!.owner).not.toHaveProperty('projectId');
    expect(decompositions[0]!.auditContext).toMatchObject({ phaseId: 'P1', parseContext: { language: 'python' },
      semanticAttempt: 1, availableSkillNames: expect.any(Array) });
    expect(decompositions[0]!.messages).toEqual(captured[1]!.messages.slice(1));
    const decompositionSnapshot = JSON.parse(await fs.readFile(path.join(containerRoot, '.xcompiler', 'rules',
      'requests', 'snapshots', `${decompositions[0]!.logicalRequestId}.json`), 'utf8'));
    expect(decompositionSnapshot.context).toMatchObject({ role: 'planner', work: 'plan.decompose', language: 'python' });
    expect(decompositionSnapshot.context).not.toHaveProperty('projectId');
  });

  it('rejects duplicate phase identities in a reusable checkpoint and requests a new PhasePlan before decomposition', { timeout: 30_000 }, async () => {
    const configPath = await writeConfig(root, baseUrl);
    const topicFile = path.join(root, 'topic.md');
    await fs.writeFile(topicFile, '# Topic\n\nBuild a small Python command that prints one greeting.\n');
    const containerRoot = path.join(root, 'duplicate-checkpoint-container');
    const compile = () => runCompile({ workspace: containerRoot, name: 'duplicate-checkpoint', configPath,
      topicFile, io: cancellingIO() });
    // Persist the accepted phase-plan checkpoint, then stop on deliberately invalid Step content.
    outputForCall = call => call === 1 ? PHASE_PLAN_ANSWER : '{}';
    await expect(compile()).rejects.toThrow();
    const checkpointPath = path.join(containerRoot, 'phasePlan.json');
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) as PhasePlan;
    const sourceDigest = checkpoint.sourceDigest;
    expect(sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    const core = { ...checkpoint.phases[0]!, verificationGate: {
      summary: 'Verify the greeting utility.', checks: ['python src/main.py'], failurePolicy: 'Repair the owning Step.',
    } };
    const next: PhasePlan['phases'][number] = { ...core, id: 'P2', status: 'planned', title: 'Presentation polish',
      objective: 'Polish the greeting presentation.', scope: ['Greeting presentation'],
      deliverables: ['Polished greeting'], dependsOn: ['P1'], planPath: 'plan.P2.json' };
    checkpoint.phases = [core, next, { ...next }];
    checkpoint.complexityAssessment = { level: 'moderate', rationale: 'Core and presentation are separate iterations.',
      splitRecommended: true, userForcedPhaseSplit: false };
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));
    const auditPath = path.join(containerRoot, '.xcompiler', 'audit', 'audit.jsonl');
    const beforeLines = (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean).length;
    const beforeCalls = captured.length;
    // The current topic/context digest is unchanged; validity is the only reason to reject reuse.
    outputForCall = call => call === beforeCalls + 1 ? PHASE_PLAN_ANSWER : '{}';
    await expect(compile()).rejects.toThrow();
    const records = (await fs.readFile(auditPath, 'utf8')).split('\n').filter(Boolean).slice(beforeLines)
      .map(line => JSON.parse(line) as AuditEvent);
    const rejection = records.filter(event => event.messageId === 'compile.phase_plan_checkpoint_rejected');
    expect(rejection).toHaveLength(1);
    expect(rejection[0]!.data).toMatchObject({ phasePlanPath: checkpointPath, reason: expect.stringContaining('duplicate implementation phase id P2') });
    expect(records.some(event => event.messageId === 'compile.phase_plan_checkpoint_reused')).toBe(false);
    const inputs = records.filter(event => event.messageId === 'llm.business_request_input')
      .map(event => event.data!.input as BusinessRequestInput);
    expect(inputs.filter(input => input.auditContext?.kind === 'planning-phase-plan')).toHaveLength(1);
    expect(inputs[0]!.auditContext?.kind).toBe('planning-phase-plan');
    const decompositions = inputs.filter(input => input.auditContext?.kind === 'planning-phase-decomposition');
    expect(decompositions).toHaveLength(2);
    expect(decompositions[0]!.auditContext).toMatchObject({ phasePlan: { implementationPhases: [
      expect.objectContaining({ id: 'P1', status: 'current' }),
    ] } });
    expect(captured[beforeCalls]!.model).toBe(MODEL_FOR_POOL.planning);
    expect(inputs[0]!.messages).toEqual(captured[beforeCalls]!.messages.slice(1));
    const repaired = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) as PhasePlan;
    expect(repaired.sourceDigest).toBe(sourceDigest);
    expect(repaired.phases.map(phase => phase.id)).toEqual(['P1']);
    expect(records.filter(event => event.messageId === 'llm.business_response_retained')).toHaveLength(1);
  });

  describe('intake: fixed choices first, then one model question per turn', () => {
    interface Script {
      language?: string; deliverable?: string; gate1?: 'confirm' | 'cancel' | 'edit'; answers?: string[];
      /** Feasibility or final-assessment choices, in order. */
      feasibility?: string | string[]; revised?: string;
      /** Answers to confirm prompts in order (resume, then addenda); false once they run out. */
      confirms?: boolean[];
      /** The answer number at which the user's session dies, as a crash or Ctrl-C would end it. */
      interruptAtAnswer?: number;
      /** What the user turns the topic into at Gate 1 when choosing edit. */
      editTopic?: (topic: string) => string;
      /** The select the user closes without answering, as an ACP client rejecting it would. */
      dismiss?: 'gate1' | 'language' | 'feasibility';
    }
    const readEvents = async (containerRoot: string) => (await fs.readFile(
      path.join(containerRoot, '.xcompiler', 'audit', 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent);
    const clarifyInputs = (events: AuditEvent[]) => events
      .filter((event) => event.messageId === 'llm.business_request_input')
      .map((event) => event.data!.input as BusinessRequestInput)
      .filter((input) => input.auditContext?.kind === 'planning-clarification');
    const zh = i18n.tFor('zh').compile;

    /** Runs a build whose selects and answers follow `script`, recording which selects were shown. */
    const intake = async (input: {
      requirement?: string; topic?: string; script?: Script; sections?: Record<string, unknown>;
      configure?: (config: Record<string, unknown>) => void; plugins?: XCompilerPlugin[];
    }) => {
      const script = input.script ?? {};
      const answers = [...(script.answers ?? [])];
      const feasibility = typeof script.feasibility === 'string' ? [script.feasibility] : [...(script.feasibility ?? [])];
      const confirms = [...(script.confirms ?? [])];
      let answered = 0;
      const seen = { selects: [] as string[], logs: [] as string[], offered: [] as string[][], messages: [] as string[], confirms: [] as string[],
        inputs: [] as string[] };
      const interaction: RuntimeInteraction = {
        input: async (args) => {
          seen.inputs.push(args.message);
          answered += 1;
          if (answered === script.interruptAtAnswer) throw new Error('session interrupted');
          return answers.shift() ?? 'A';
        },
        confirm: async (args) => {
          seen.confirms.push(args.message);
          return confirms.shift() ?? false;
        },
        // Without a scripted revision the editor is saved unchanged, as an ACP client can only do.
        editor: async (args) => script.editTopic && args.default?.startsWith('---\n') ? script.editTopic(args.default)
          : script.revised ?? args.default ?? '',
        select: async <T extends string>(args: { message: string; choices: Array<{ value: T }> }) => {
          const values = args.choices.map((choice) => choice.value as string);
          const kind = values.includes('proceed') ? 'feasibility' : values.includes('cancel') ? 'gate1'
            : values.includes('python') ? 'language' : values.includes('library') ? 'deliverable' : values.join(',');
          seen.selects.push(kind);
          seen.offered.push(values);
          seen.messages.push(args.message);
          if (kind === script.dismiss) throw new InteractionDismissedError('select');
          const value = kind === 'gate1' ? script.gate1 ?? 'cancel' : kind === 'language' ? script.language
            : kind === 'feasibility' ? feasibility.shift() : script.deliverable;
          if (!value) throw new Error(`the ${kind} select was not expected`);
          return value as T;
        },
        readMultiline: async () => '',
      };
      const io: RuntimeIO = {
        terminalOutput: false, permissionPolicy: 'deny', interaction,
        emit: (event) => { if (event.type === 'log') seen.logs.push(event.message); },
        progress: () => ({ succeed: () => undefined, fail: () => undefined, stop: () => undefined }),
      };
      const configPath = await writeConfig(root, baseUrl, input.sections, input.configure);
      const containerRoot = path.join(root, 'intake-container');
      const earlier = (await readEvents(containerRoot).catch(() => [])).length;
      const source = input.topic === undefined
        ? { inputFile: path.join(root, 'requirement.md') } : { topicFile: path.join(root, 'topic.md') };
      await fs.writeFile(source.inputFile ?? source.topicFile!, input.topic ?? input.requirement ?? 'Build a small tool that summarizes a local text file into a report.\n');
      const outcome = await runCompile({ workspace: containerRoot, name: 'intake', configPath, ...source, io, plugins: input.plugins })
        .then(() => undefined, (error: unknown) => error);
      // Only this run's records: a resumed build appends to the same audit.
      const events = (await readEvents(containerRoot).catch(() => [])).slice(earlier);
      // The topic draft is shown before Gate 1; its front matter is how it is recognised here.
      const draft = seen.logs.find((message) => message.startsWith('---\nxcompiler-topic: 1'));
      return { seen, events, draft, outcome, containerRoot,
        ended: [...events].reverse().find((event) => event.messageId === 'compile.clarification_ended')?.data,
        infeasible: events.filter((event) => event.messageId === 'compile.clarification_infeasible').map((event) => event.data),
        finals: events.filter((event) => event.messageId === 'compile.clarification_final').map((event) => event.data) };
    };

    it('asks the language as a choice, skips the deliverable the requirement settles, and asks until the model reports clear', { timeout: 30_000 }, async () => {
      outputForCall = (call) => call === 1 ? askTurn('Which operations must the tool support end to end?') : CLEAR_TURN;
      const run = await intake({ script: { language: 'typescript', answers: ['B'] } });
      expect(run.seen.selects).toEqual(['language', 'gate1']);
      expect(captured.map((call) => call.model)).toEqual([MODEL_FOR_POOL.management, MODEL_FOR_POOL.management]);
      const inputs = clarifyInputs(run.events);
      expect(inputs).toHaveLength(2);
      // The second turn is built on both earlier answers: the typed language choice and the model's own question.
      expect(inputs[1]!.auditContext).toMatchObject({ parseContext: { language: 'typescript', projectType: 'application',
        questionId: 'Q3', transcript: [
          { id: 'Q1', category: 'boundary', answer: `B. ${zh.intakeLanguage.options.typescript}` },
          { id: 'Q2', category: 'functionality', question: 'Which operations must the tool support end to end?', answer: 'B. read and write' },
        ] } });
      expect(run.ended).toMatchObject({ ended: 'clear', asked: 2, openPoints: [] });
      expect(run.draft).toMatch(/^---\nxcompiler-topic: 1\nlanguage: typescript\nprojectType: application\n---\n/u);
      expect(run.draft).not.toContain(zh.topicSecOpen);
      // The topic keeps each answer, not the reasons or the options left unchosen.
      expect(run.draft).toContain('- **Q2 · functionality** Which operations must the tool support end to end?\n  - **A** B. read and write');
      expect(run.draft).not.toContain('**Options**');
      expect(run.draft).not.toContain('**Why**');
    });

    type Providers = { llm: { providers: Record<string, { context_window: string }> } };
    const parseContexts = (events: AuditEvent[]) => clarifyInputs(events).map((input) => (input.auditContext as {
      parseContext: { budgetUsedPercent: number; finalAssessment: string | null; questionId: string; rawRequirement: string;
        transcript: { id: string }[] } }).parseContext);
    const OPEN_POINT = { category: 'functionality', detail: 'Which report sections are required.' };
    /** A model that asks a long new question each turn and, at a final assessment, reports what is still open. */
    const longAsker = (call: number, _model: string, prompt: string) => prompt.includes('"status":"unresolved"')
      ? JSON.stringify({ status: 'unresolved', coverage: { ...RESOLVED, functionality: 'open' }, feasibility: FEASIBLE,
        summary: 'Inputs are settled; the report sections are not.', openPoints: [OPEN_POINT] })
      : askTurn(`Which report section ${call} must the tool produce? ${'Describe the section in detail. '.repeat(160)}`);

    it('shows each turn how many dimensions are settled, the verdict and the budget used', { timeout: 30_000 }, async () => {
      outputForCall = (call) => call === 1 ? askTurn('Which operations must the tool support end to end?') : CLEAR_TURN;
      const run = await intake({ script: { language: 'python' } });
      const first = parseContexts(run.events)[0]!;
      expect(first.budgetUsedPercent).toBeGreaterThan(0);
      expect(run.seen.logs).toContain(zh.clarifyProgress(5, 6, 'feasible', first.budgetUsedPercent));
    });

    it('turns to a final assessment once the prompt reaches its share of the clarifying model\'s window', { timeout: 60_000 }, async () => {
      outputForCall = longAsker;
      const run = await intake({ script: { language: 'python', feasibility: 'proceed' },
        configure: (config) => { (config as Providers).llm.providers.p_management!.context_window = '12K'; } });
      const contexts = parseContexts(run.events);
      const final = contexts.at(-1)!;
      expect(contexts.length).toBeGreaterThan(2);
      expect(contexts.slice(0, -1).every((context) => context.finalAssessment === null && context.budgetUsedPercent < 100)).toBe(true);
      expect(final).toMatchObject({ finalAssessment: 'budget', budgetUsedPercent: 100 });
      expect(run.seen.offered.at(-2)).toEqual(['revise', 'proceed', 'cancel']);
      expect(run.seen.messages.at(-2)).toContain(zh.final.header('budget', 4));
      expect(run.seen.messages.at(-2)).toContain(OPEN_POINT.detail);
      expect(run.finals).toEqual([expect.objectContaining({ finalAssessment: 'budget', status: 'unresolved', choice: 'proceed' })]);
      expect(run.ended).toMatchObject({ ended: 'proceed', finalAssessment: 'budget', openPoints: [OPEN_POINT] });
      expect(run.draft).toContain(`${zh.topicSecOpen}\n\n${zh.topicOpenNote}\n- functionality: ${OPEN_POINT.detail}`);
    });

    it('counts the planning model\'s window too, since planning reads everything clarified', { timeout: 60_000 }, async () => {
      outputForCall = longAsker;
      const run = await intake({ script: { language: 'python', feasibility: 'proceed' },
        sections: { planning: { clarification: { context_ratio: 0.5 } } },
        configure: (config) => { (config as Providers).llm.providers.p_planning!.context_window = '16K'; } });
      const contexts = parseContexts(run.events);
      // The topic had to grow into the limit: the first turns still asked.
      expect(contexts.length).toBeGreaterThan(1);
      expect(contexts.slice(0, -1).every((context) => context.finalAssessment === null)).toBe(true);
      expect(contexts.at(-1)).toMatchObject({ finalAssessment: 'budget' });
      expect(run.ended).toMatchObject({ windows: [131072, 16384],
        limits: { clarification: clarificationPromptLimit(131072, 0.5), planning: clarificationPromptLimit(16384, 0.5) } });
      // The planning side is what ran out: the topic planning reads, beside planning's own prompt and the PhasePlan.
      const { budget, limits } = run.ended as { limits: { clarification: number; planning: number }; budget: {
        clarificationTokens: number; topicTokens: number; planningOverheadTokens: number; phasePlanReserveTokens: number; planningTokens: number;
      } };
      expect(budget.clarificationTokens).toBeLessThan(limits.clarification);
      expect(budget.planningTokens).toBeGreaterThanOrEqual(limits.planning);
      expect(budget.planningOverheadTokens).toBeGreaterThan(1000);
      expect(budget.phasePlanReserveTokens).toBe(phasePlanReserveTokens(16384));
      expect(budget.topicTokens).toBeGreaterThan(budget.planningTokens - limits.planning);
      expect(budget.planningTokens).toBe(budget.topicTokens + budget.planningOverheadTokens + budget.phasePlanReserveTokens);
    });

    it('restarts from a requirement with the confirmed answers folded in when the user revises at the budget limit', { timeout: 60_000 }, async () => {
      outputForCall = longAsker;
      const run = await intake({ script: { language: 'python', feasibility: ['revise', 'proceed'] },
        configure: (config) => { (config as Providers).llm.providers.p_management!.context_window = '12K'; } });
      const contexts = parseContexts(run.events);
      const revisedAt = contexts.findIndex((context) => context.finalAssessment === 'budget');
      const after = contexts[revisedAt + 1]!;
      // Only the fixed language answer survives; the model's answers now live in the requirement text.
      expect(after.transcript.map((entry) => entry.id)).toEqual(['Q1']);
      expect(after.rawRequirement).toContain(zh.final.condensedConfirmed);
      expect(after.rawRequirement).toContain('Which report section 1 must the tool produce?');
      // Question ids keep counting past every answer folded away, so the audit never reuses one.
      const folded = contexts[revisedAt]!.transcript.map((entry) => Number(entry.id.slice(1)));
      expect(Number(after.questionId.slice(1))).toBeGreaterThan(Math.max(...folded));
    });

    it('counts a dimension the model keeps moving around as stalling, since nothing new is settled', { timeout: 60_000 }, async () => {
      outputForCall = (call, _model, prompt) => {
        if (prompt.includes('"status":"unresolved"')) {
          return JSON.stringify({ status: 'unresolved', coverage: { ...RESOLVED, functionality: 'open' }, feasibility: FEASIBLE,
            summary: 'One dimension keeps moving.', openPoints: [OPEN_POINT] });
        }
        const category = call % 2 === 1 ? 'functionality' : 'data';
        return JSON.stringify({ status: 'ask', coverage: { ...RESOLVED, [category]: 'open' }, feasibility: FEASIBLE,
          question: { category, question: `Which report section ${call} must the tool produce?`, why: 'scope',
            options: [{ label: 'A', answer: 'read only' }, { label: 'B', answer: 'read and write' }] } });
      };
      const run = await intake({ script: { language: 'python', feasibility: 'proceed' },
        sections: { planning: { clarification: { stall_turns: 2 } } } });
      expect(parseContexts(run.events).map((context) => context.finalAssessment)).toEqual([null, null, null, 'stalled']);
      expect(run.ended).toMatchObject({ ended: 'proceed', finalAssessment: 'stalled' });
    });

    it('resumes how far the clarification had got, so a resumed intake stalls when it would have', { timeout: 60_000 }, async () => {
      const asker = (call: number, _model: string, prompt: string) => prompt.includes('"status":"unresolved"')
        ? JSON.stringify({ status: 'unresolved', coverage: { ...RESOLVED, functionality: 'open' }, feasibility: FEASIBLE,
          summary: 'The report sections are not settled.', openPoints: [OPEN_POINT] })
        : askTurn(`Which report section ${call} must the tool produce?`);
      outputForCall = asker;
      const stall = { planning: { clarification: { stall_turns: 2 } } };
      await intake({ script: { language: 'python', interruptAtAnswer: 2 }, sections: stall });
      outputForCall = asker;
      const resumed = await intake({ script: { confirms: [true], feasibility: 'proceed' }, sections: stall });
      expect(resumed.seen.confirms[0]).toBe(zh.resumeIntake(2));
      // Saved after the first answer had settled five dimensions: the next two settle nothing new.
      expect(parseContexts(resumed.events).map((context) => context.finalAssessment)).toEqual([null, null, 'stalled']);
    });

    it('turns to a final assessment when answers stop changing the coverage, and lets the user keep clarifying', { timeout: 60_000 }, async () => {
      outputForCall = (call, _model, prompt) => prompt.includes('"status":"unresolved"')
        ? JSON.stringify({ status: 'unresolved', coverage: { ...RESOLVED, functionality: 'open' }, feasibility: FEASIBLE,
          summary: 'The report sections keep shifting.', openPoints: [OPEN_POINT] })
        : askTurn(`Which report section ${call} must the tool produce?`);
      const run = await intake({ script: { language: 'python', feasibility: ['continue', 'proceed'] },
        sections: { planning: { clarification: { stall_turns: 2 } } } });
      expect(parseContexts(run.events).map((context) => context.finalAssessment))
        .toEqual([null, null, null, 'stalled', null, null, 'stalled']);
      expect(run.seen.offered.filter((values) => values.includes('proceed')))
        .toEqual([['continue', 'revise', 'proceed', 'cancel'], ['continue', 'revise', 'proceed', 'cancel']]);
      expect(run.seen.messages.find((message) => message.includes(zh.final.header('stalled', 2)))).toBeDefined();
      expect(run.ended).toMatchObject({ ended: 'proceed', finalAssessment: 'stalled', openPoints: [OPEN_POINT] });
    });

    it('offers back an unfinished clarification of the same requirement, and starts over when declined', { timeout: 60_000 }, async () => {
      outputForCall = (call) => askTurn(`Which report section ${call} must the tool produce?`);
      const first = await intake({ script: { language: 'python', answers: ['B'], interruptAtAnswer: 2 } });
      expect(first.outcome).toBeInstanceOf(Error);
      const draftPath = path.join(first.containerRoot, '.xcompiler', 'drafts', 'build', 'intake.json');
      expect(JSON.parse(await fs.readFile(draftPath, 'utf8'))).toMatchObject({ questionSeq: 2, records: [{ fixed: true }, { fixed: false, answer: 'B. read and write' }] });

      outputForCall = () => CLEAR_TURN;
      const resumed = await intake({ script: { confirms: [true] } });
      expect(resumed.seen.confirms[0]).toBe(zh.resumeIntake(2));
      expect(resumed.seen.selects).toEqual(['gate1']);
      expect(parseContexts(resumed.events)[0]).toMatchObject({ questionId: 'Q3', transcript: [{ id: 'Q1' }, { id: 'Q2' }] });
      expect(resumed.events.find((event) => event.messageId === 'compile.intake_resumed')?.data).toMatchObject({ answers: 2 });
      // Cancelling at Gate 1 drops the drafts, the intake draft included.
      await expect(fs.stat(draftPath)).rejects.toMatchObject({ code: 'ENOENT' });

      outputForCall = (call) => askTurn(`Which report section ${call} must the tool produce?`);
      await intake({ script: { language: 'python', answers: ['B'], interruptAtAnswer: 2 } });
      outputForCall = () => CLEAR_TURN;
      const declined = await intake({ script: { language: 'python', confirms: [false] } });
      expect(declined.seen.selects).toEqual(['language', 'gate1']);
      expect(parseContexts(declined.events)[0]).toMatchObject({ questionId: 'Q2', transcript: [{ id: 'Q1' }] });
    });

    it('does not resume a clarification written for models in another language', { timeout: 60_000 }, async () => {
      outputForCall = (call, _model, prompt) => prompt.includes('You translate text exchanged between a user and the models')
        ? JSON.stringify({ translations: (JSON.parse(captured.find((entry) => entry.prompt === prompt)!.messages.at(-1)!.content) as { texts: string[] }).texts })
        : askTurn(`Which report section ${call} must the tool produce?`);
      try {
        await intake({ sections: { prompt_translate: 'on' }, script: { language: 'python', answers: ['B'], interruptAtAnswer: 2 } });
      } finally {
        i18n.setPromptTranslation(false);
      }
      outputForCall = () => CLEAR_TURN;
      const later = await intake({ script: { language: 'python', confirms: [true] } });
      expect(later.seen.confirms).not.toContain(zh.resumeIntake(2));
      expect(later.events.some((event) => event.messageId === 'compile.intake_resumed')).toBe(false);
    });

    it('discards an unreadable intake draft with a warning and a record, then starts over', { timeout: 30_000 }, async () => {
      const draftPath = path.join(root, 'intake-container', '.xcompiler', 'drafts', 'build', 'intake.json');
      await fs.mkdir(path.dirname(draftPath), { recursive: true });
      await fs.writeFile(draftPath, '{"version":1');
      const run = await intake({ script: { language: 'python' } });
      expect(run.seen.logs).toContain(zh.intakeDraftInvalid);
      expect(run.events.find((event) => event.messageId === 'compile.intake_draft_invalid')?.data).toMatchObject({ code: 'intake_draft_invalid' });
      // No resume offer: the only confirm is the addenda question that follows clarification.
      expect(run.seen.confirms).toEqual([zh.addendaConfirm]);
      expect(run.seen.selects).toEqual(['language', 'gate1']);
    });

    describe('with prompt translation on', () => {
      afterEach(() => { i18n.setPromptTranslation(false); });
      const TRANSLATOR = 'You translate text exchanged between a user and the models';
      const isTranslation = (prompt: string) => prompt.includes(TRANSLATOR);
      /** A translation model that tags each text with its target language, so every crossing shows. */
      const translate = (prompt: string) => {
        const call = captured.find((entry) => entry.prompt === prompt)!;
        const { texts } = JSON.parse(call.messages.at(-1)!.content) as { texts: string[] };
        const tag = prompt.includes('to English.') ? '⟦en⟧' : '⟦zh⟧';
        return JSON.stringify({ translations: texts.map((text) => `${tag}${text}`) });
      };
      const sections = { prompt_translate: 'on' };
      const translationCalls = () => captured.filter((call) => isTranslation(call.prompt));

      it('asks the model in English and shows the user their own language, translating only free text', { timeout: 60_000 }, async () => {
        let turns = 0;
        outputForCall = (_call, _model, prompt) => {
          if (isTranslation(prompt)) return translate(prompt);
          turns += 1;
          return turns === 1 ? askTurn('How often should the report be exported?')
            : turns === 2 ? askTurn('Which columns must the report keep?') : CLEAR_TURN;
        };
        const run = await intake({ requirement: '构建一个把本地文本文件汇总成报表的小工具。\n', sections,
          script: { language: 'python', answers: ['每周导出 CSV', 'B'] } });
        const clarifying = captured.filter((call) => !isTranslation(call.prompt));
        // The clarification itself is English: its template, its Rules, and the requirement it carries.
        expect(clarifying[0]!.messages.at(-1)!.content).toContain('Original requirement:\n"""\n⟦en⟧构建一个把本地文本文件汇总成报表的小工具。');
        expect(clarifying[0]!.prompt).toContain('deliverables (documents, reports and commit messages) in Simplified Chinese');
        expect(clarifyInputs(run.events)[0]).toMatchObject({ auditContext: { locale: 'en', outputLocale: 'zh' } });
        // The user reads the model's question, its reason and its options in their language.
        expect(run.seen.inputs[0]).toContain('⟦zh⟧How often should the report be exported?');
        expect(run.seen.inputs[0]).toContain('A. ⟦zh⟧read only');
        const contexts = parseContexts(run.events) as unknown as { transcript: { id: string; answer: string }[] }[];
        // A typed answer is translated for the model; a chosen option is the model's own text.
        expect(contexts[2]!.transcript.slice(1).map((entry) => entry.answer)).toEqual(['⟦en⟧每周导出 CSV', 'B. read and write']);
        // The topic the user confirms keeps what they saw and typed, and the defaults in their language.
        expect(run.draft).toContain('⟦zh⟧How often should the report be exported?\n  - **A** 每周导出 CSV');
        expect(run.draft).toContain(`${zh.topicAssumptionsNote}\n- ⟦zh⟧${ASSUMPTION}`);
        expect(translationCalls().length).toBeGreaterThan(0);
        // What the user reads is written in their language, so that translation's Rule names it.
        expect(translationCalls().find((call) => !call.prompt.includes('to English.'))!.prompt)
          .toContain('deliverables (documents, reports and commit messages) in Simplified Chinese');
        expect(await fs.readdir(path.join(run.containerRoot, '.xcompiler', 'translations'))).not.toHaveLength(0);
      });

      it('hands planning the topic in English, front matter untouched', { timeout: 60_000 }, async () => {
        outputForCall = (_call, model, prompt) => isTranslation(prompt) ? translate(prompt)
          : model === MODEL_FOR_POOL.planning ? '{}' : CLEAR_TURN;
        const run = await intake({ sections, script: { language: 'python', gate1: 'confirm' } });
        expect(run.outcome).toBeDefined();
        const planning = captured.find((call) => call.model === MODEL_FOR_POOL.planning)!;
        expect(planning.prompt).toContain('deliverables (documents, reports and commit messages) in Simplified Chinese');
        // A translation request writes in its target language, so its own Rule names that language.
        expect(translationCalls().find((call) => call.prompt.includes('to English.'))!.prompt)
          .toContain('deliverables (documents, reports and commit messages) in English');
        const topic = planning.messages.at(-1)!.content;
        expect(topic).toMatch(/Original requirement:\n"""\n---\nxcompiler-topic: 1\nlanguage: python\nprojectType: application\n---\n\n# Project Topic\n/u);
        // Headings are presets, so planning reads the English ones; only the text under them is translated.
        expect(topic).toContain(`${i18n.tFor('en').compile.topicSecRequirement}\n\n⟦en⟧`);
        expect(topic).not.toContain(zh.topicSecRequirement);
        // The defaults read as the model wrote them, under the English heading.
        const en = i18n.tFor('en').compile;
        expect(topic).toContain(`${en.topicSecAssumptions}\n\n${en.topicAssumptionsNote}\n- ${ASSUMPTION}`);
        // What intake already translated is reused: the record reads as the models' own English, not translated back.
        expect(topic).toMatch(/- \*\*Q1 · boundary\*\* [A-Za-z]/u);
        expect(topic).not.toContain('⟦en⟧- **Q1');
      });

      it('hands planning the open points as the model wrote them, not translated back', { timeout: 60_000 }, async () => {
        const detail = 'Which report sections are required.';
        outputForCall = (call, model, prompt) => isTranslation(prompt) ? translate(prompt)
          : model === MODEL_FOR_POOL.planning ? '{}'
          : prompt.includes('"status":"unresolved"') ? JSON.stringify({ status: 'unresolved', coverage: { ...RESOLVED, functionality: 'open' },
            feasibility: FEASIBLE, summary: 'The report sections are not settled.', openPoints: [{ category: 'functionality', detail }] })
          : askTurn(`Which report section ${call} must the tool produce?`);
        const run = await intake({ sections: { ...sections, planning: { clarification: { stall_turns: 2 } } },
          script: { language: 'python', feasibility: 'proceed', gate1: 'confirm' } });
        expect(run.draft).toContain(`- functionality: ⟦zh⟧${detail}`);
        const topic = captured.find((call) => call.model === MODEL_FOR_POOL.planning)!.messages.at(-1)!.content;
        expect(topic).toContain(`- functionality: ${detail}`);
      });

      it('translates a record a plugin rewrote instead of reusing what intake translated before', { timeout: 60_000 }, async () => {
        const rewriter: XCompilerPlugin = {
          manifest: { id: 'test.rewriter', version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: '0.1.3' },
          setup: (api) => { api.on('compile.afterClarify', (context) => { context.clarifications[0]!.answer = '插件改写的回答'; }); },
        };
        outputForCall = (_call, model, prompt) => isTranslation(prompt) ? translate(prompt)
          : model === MODEL_FOR_POOL.planning ? '{}' : CLEAR_TURN;
        await intake({ sections, plugins: [rewriter], script: { language: 'python', gate1: 'confirm' } });
        const topic = captured.find((call) => call.model === MODEL_FOR_POOL.planning)!.messages.at(-1)!.content;
        expect(topic).toContain('⟦en⟧- **Q1');
        expect(topic).toContain('插件改写的回答');
      });

      it('translates only the section the user edits at Gate 1', { timeout: 60_000 }, async () => {
        outputForCall = (_call, model, prompt) => isTranslation(prompt) ? translate(prompt)
          : model === MODEL_FOR_POOL.planning ? '{}' : CLEAR_TURN;
        const edited = '构建一个把本地文本文件汇总成 PDF 报表的小工具。';
        const run = await intake({ requirement: '构建一个把本地文本文件汇总成报表的小工具。\n', sections, script: { language: 'python',
          gate1: 'edit', editTopic: (topic) => topic.replace('构建一个把本地文本文件汇总成报表的小工具。', edited) } });
        expect(run.outcome).toBeDefined();
        const topic = captured.find((call) => call.model === MODEL_FOR_POOL.planning)!.messages.at(-1)!.content;
        expect(topic).toContain(`⟦en⟧${edited}`);
        expect(topic).not.toContain('⟦en⟧- **Q1');
        const sentAfterGate1 = translationCalls().map((call) => (JSON.parse(call.messages.at(-1)!.content) as { texts: string[] }).texts)
          .filter((texts) => texts.includes(edited));
        expect(sentAfterGate1).toEqual([[edited]]);
      });

      it('translates only the default the user corrects at Gate 1, keeping its heading a preset', { timeout: 60_000 }, async () => {
        outputForCall = (_call, model, prompt) => isTranslation(prompt) ? translate(prompt)
          : model === MODEL_FOR_POOL.planning ? '{}' : CLEAR_TURN;
        const corrected = '每份报表另存一份 CSV。';
        await intake({ sections, script: { language: 'python', gate1: 'edit',
          editTopic: (topic) => topic.replace(`- ⟦zh⟧${ASSUMPTION}`, `- ${corrected}`) } });
        const topic = captured.find((call) => call.model === MODEL_FOR_POOL.planning)!.messages.at(-1)!.content;
        const en = i18n.tFor('en').compile;
        expect(topic).toContain(`${en.topicSecAssumptions}\n\n${en.topicAssumptionsNote}\n⟦en⟧- ${corrected}`);
        const sent = translationCalls().map((call) => (JSON.parse(call.messages.at(-1)!.content) as { texts: string[] }).texts)
          .filter((texts) => texts.some((text) => text.includes(corrected)));
        expect(sent).toEqual([[`- ${corrected}`]]);
      });

      it('shows the plan at Gate 2 in the user\'s language, leaving the plan as the models wrote it', { timeout: 60_000 }, async () => {
        outputForCall = (_call, model, prompt) => isTranslation(prompt) ? translate(prompt)
          : model !== MODEL_FOR_POOL.planning ? CLEAR_TURN
          : prompt.includes('First generate only the high-level PhasePlan') ? PHASE_PLAN_ANSWER : STEP_PLAN_ANSWER;
        const run = await intake({ requirement: 'Build a small Python command that prints one greeting.\n', sections,
          script: { language: 'python', deliverable: 'application', gate1: 'confirm' } });
        expect(run.seen.confirms).toContain(zh.gate2Confirm);
        expect(run.seen.logs.some((message) => message.startsWith('⟦zh⟧# Plan (language: python)'))).toBe(true);
        const toUser = translationCalls().filter((call) => !call.prompt.includes('to English.'))
          .map((call) => (JSON.parse(call.messages.at(-1)!.content) as { texts: string[] }).texts[0]!);
        expect(toUser.some((text) => text.startsWith('# Plan (language: python)'))).toBe(true);
      });

      it('keeps the text as written and says so when translation fails', { timeout: 60_000 }, async () => {
        outputForCall = (_call, _model, prompt) => isTranslation(prompt) ? 'not json' : CLEAR_TURN;
        const run = await intake({ requirement: '构建一个把本地文本文件汇总成报表的小工具。\n', sections, script: { language: 'python' } });
        expect(run.seen.logs).toContain(i18n.tFor('zh').translation.fallback(1));
        expect(run.events.find((event) => event.messageId === 'translation.fallback')?.data).toMatchObject({ from: 'zh', to: 'en', texts: 1 });
        expect(clarifyInputs(run.events)[0]!.auditContext).toMatchObject({ parseContext: { rawRequirement: '构建一个把本地文本文件汇总成报表的小工具。\n' } });
      });

      it('translates nothing for a user who reads English', { timeout: 30_000 }, async () => {
        outputForCall = (_call, _model, prompt) => isTranslation(prompt) ? translate(prompt) : CLEAR_TURN;
        await intake({ sections: { ...sections, locale: 'en' }, script: { language: 'python' } });
        expect(translationCalls()).toHaveLength(0);
      });
    });

    it('writes the defaults a clear clarification leaves to planning into the topic, where the user and planning read them', { timeout: 60_000 }, async () => {
      outputForCall = (_call, model) => model === MODEL_FOR_POOL.planning ? '{}' : CLEAR_TURN;
      const run = await intake({ script: { language: 'python', gate1: 'confirm' } });
      const section = `${zh.topicSecAssumptions}\n\n${zh.topicAssumptionsNote}\n- ${ASSUMPTION}`;
      expect(run.draft).toContain(section);
      expect(captured.find((call) => call.model === MODEL_FOR_POOL.planning)!.prompt).toContain(section);
      expect(run.ended).toMatchObject({ ended: 'clear', assumptions: [ASSUMPTION] });
    });

    it('hands planning the addenda once, inside the topic, so an edit at Gate 1 cannot be overruled', { timeout: 60_000 }, async () => {
      outputForCall = (_call, model) => model === MODEL_FOR_POOL.planning ? '{}' : CLEAR_TURN;
      const addenda = 'Store every report in a SQLite database.';
      const run = await intake({ script: { language: 'python', gate1: 'confirm', confirms: [true], revised: addenda } });
      expect(run.outcome).toBeDefined();
      const planning = captured.find((call) => call.model === MODEL_FOR_POOL.planning)!.prompt;
      expect(planning.split(addenda)).toHaveLength(2);
      expect(planning).toContain(`${zh.topicSecAddenda}\n\n${addenda}`);
    });

    it('records the addenda the topic holds after Gate 1, so the plan\'s checks judge what planning read', { timeout: 60_000 }, async () => {
      let planningCalls = 0;
      outputForCall = (_call, model) => model !== MODEL_FOR_POOL.planning ? CLEAR_TURN : (planningCalls += 1) === 1 ? PHASE_PLAN_ANSWER : '{}';
      const run = await intake({ requirement: 'Build a small Python command that prints one greeting.\n',
        script: { language: 'python', deliverable: 'application', gate1: 'edit', confirms: [true], revised: 'Print the greeting in green.',
          editTopic: (topic) => topic.replace('Print the greeting in green.', 'Print the greeting in blue.') } });
      expect(run.outcome).toBeDefined();
      const checkpoint = JSON.parse(await fs.readFile(path.join(run.containerRoot, 'phasePlan.json'), 'utf8')) as PhasePlan;
      expect(checkpoint.userAddenda).toBe('Print the greeting in blue.');
    });

    it('plans from the topic alone, so an answer edited at Gate 1 is the only one planning sees', { timeout: 60_000 }, async () => {
      outputForCall = (call, model) => model === MODEL_FOR_POOL.planning ? (call === 3 ? PHASE_PLAN_ANSWER : '{}')
        : call === 1 ? askTurn('How often should the report be exported?') : CLEAR_TURN;
      const run = await intake({ script: { language: 'python', answers: ['Weekly CSV export'], gate1: 'edit',
        editTopic: (topic) => topic.replace('Weekly CSV export', 'Monthly CSV export') } });
      expect(run.outcome).toBeDefined();
      const planning = captured.filter((call) => call.model === MODEL_FOR_POOL.planning);
      expect(planning.length).toBeGreaterThan(0);
      const phasePlanPrompt = planning[0]!.prompt;
      expect(phasePlanPrompt).toContain('Monthly CSV export');
      expect(phasePlanPrompt).not.toContain('Weekly CSV export');
      expect(phasePlanPrompt.split('How often should the report be exported?')).toHaveLength(2);
      // With no separate list, planning is not told there was no clarification.
      expect(phasePlanPrompt).not.toContain('澄清问答：');
      // Once the topic is persisted it holds the intake; no draft is left to offer a stale resume.
      await expect(fs.stat(path.join(run.containerRoot, '.xcompiler', 'drafts', 'build', 'intake.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('takes a blank answer as the recommended option and masks a credential pasted into an answer', { timeout: 60_000 }, async () => {
      outputForCall = (call) => askTurn(`Which report section ${call} must the tool produce?`);
      const run = await intake({ script: { language: 'python', answers: ['', 'Use api_key=abc123secret for it'], interruptAtAnswer: 3 } });
      const contexts = parseContexts(run.events) as unknown as { transcript: { answer: string }[] }[];
      expect(contexts.at(-1)!.transcript.map((entry) => entry.answer).slice(1)).toEqual(['A. read only', 'Use api_key=[REDACTED] for it']);
      expect(run.seen.logs).toContain(zh.answerRedacted);
      const draft = await fs.readFile(path.join(run.containerRoot, '.xcompiler', 'drafts', 'build', 'intake.json'), 'utf8');
      expect(draft).not.toContain('abc123secret');
      expect(JSON.stringify(run.events)).not.toContain('abc123secret');
    });

    it('ends the build as cancelled when the user closes a prompt, keeping the unfinished intake', { timeout: 30_000 }, async () => {
      outputForCall = () => CLEAR_TURN;
      const run = await intake({ script: { language: 'python', dismiss: 'gate1' } });
      expect(run.outcome).toBeUndefined();
      expect(run.events.find((event) => event.messageId === 'audit.session_end')!.data)
        .toMatchObject({ status: 'cancelled', reason: 'interaction_dismissed', prompt: 'select' });
      expect(run.seen.logs).toContain(zh.interactionDismissed);
      expect(captured.map((call) => call.model)).not.toContain(MODEL_FOR_POOL.planning);
      await expect(fs.stat(path.join(run.containerRoot, '.xcompiler', 'drafts', 'build', 'intake.json'))).resolves.toBeDefined();
    });

    it('refuses a Gate 1 answer that is none of its choices instead of reading it as a confirmation', { timeout: 30_000 }, async () => {
      outputForCall = () => CLEAR_TURN;
      const run = await intake({ script: { language: 'python', gate1: 'false' as 'confirm' } });
      expect(run.outcome).toMatchObject({ code: 'intake_choice_invalid', subject: 'gate1' });
      expect(run.events.some((event) => event.messageId === 'compile.topic_persisted')).toBe(false);
      expect(captured.map((call) => call.model)).not.toContain(MODEL_FOR_POOL.planning);
    });

    it('builds the final assessment itself when the model keeps asking, so the intake is not stranded', { timeout: 60_000 }, async () => {
      outputForCall = (call) => askTurn(`Which report section ${call} must the tool produce?`);
      const run = await intake({ script: { language: 'python', feasibility: 'proceed' },
        sections: { planning: { clarification: { stall_turns: 2 } } } });
      expect(run.outcome).toBeUndefined();
      expect(run.events.find((event) => event.messageId === 'compile.clarification_final_unavailable')!.data)
        .toMatchObject({ finalAssessment: 'stalled', cause: 'all_providers_failed' });
      expect(run.finals).toEqual([expect.objectContaining({ source: 'code', status: 'unresolved', choice: 'proceed',
        openPoints: [{ category: 'functionality' }] })]);
      expect(run.seen.offered.at(-2)).toEqual(['continue', 'revise', 'proceed', 'cancel']);
      expect(run.seen.logs).toContain(zh.final.codeBuilt);
      expect(run.ended).toMatchObject({ ended: 'proceed', finalAssessment: 'stalled', openPoints: [{ category: 'functionality' }] });
    });

    it('builds the final assessment itself when no provider can hold it', { timeout: 60_000 }, async () => {
      outputForCall = () => CLEAR_TURN;
      const run = await intake({ script: { language: 'python', feasibility: 'proceed' },
        sections: { planning: { clarification: { context_ratio: 0.2 } } },
        configure: (config) => { (config as Providers).llm.providers.p_management!.context_window = '3K'; } });
      expect(captured).toHaveLength(0);
      expect(run.events.find((event) => event.messageId === 'compile.clarification_final_unavailable')!.data)
        .toMatchObject({ finalAssessment: 'budget', cause: 'provider_capacity_exhausted' });
      expect(run.ended).toMatchObject({ ended: 'proceed', finalAssessment: 'budget', openPoints: [] });
    });

    it('records that a final assessment happened even when it finds the requirement clear', { timeout: 60_000 }, async () => {
      outputForCall = (call, _model, prompt) => prompt.includes('"status":"unresolved"') ? CLEAR_TURN
        : askTurn(`Which report section ${call} must the tool produce?`);
      const run = await intake({ script: { language: 'python' }, sections: { planning: { clarification: { stall_turns: 2 } } } });
      expect(run.ended).toMatchObject({ ended: 'clear', finalAssessment: 'stalled' });
    });

    it('starts counting stalled answers afresh after the requirement is narrowed', { timeout: 60_000 }, async () => {
      outputForCall = (call, _model, prompt) => prompt.includes('"status":"unresolved"')
        ? JSON.stringify({ status: 'unresolved', coverage: { ...RESOLVED, functionality: 'open' }, feasibility: FEASIBLE,
          summary: 'Sections still shifting.', openPoints: [OPEN_POINT] })
        : call === 3 ? infeasibleTurn('A web service.') : askTurn(`Which report section ${call} must the tool produce?`);
      const run = await intake({ script: { language: 'python', feasibility: ['narrow', 'proceed'] },
        sections: { planning: { clarification: { stall_turns: 2 } } } });
      // Without the reset the two asks before narrowing would count, and the final would come at the fifth call.
      expect(parseContexts(run.events).map((context) => context.finalAssessment))
        .toEqual([null, null, null, null, null, null, 'stalled']);
    });

    it('settles the language and deliverable again from a revised requirement, asking when it no longer says', { timeout: 60_000 }, async () => {
      outputForCall = (call) => call === 1 ? infeasibleTurn() : CLEAR_TURN;
      const typed = await intake({ requirement: 'Build a Python library that parses CSV files.\n',
        script: { feasibility: 'revise', revised: 'Build a TypeScript command-line tool that converts CSV files.' } });
      expect(typed.seen.selects).toEqual(['feasibility', 'gate1']);
      expect(parseContexts(typed.events)[1]).toMatchObject({ language: 'typescript', projectType: 'application' });
      expect(typed.draft).toMatch(/^---\nxcompiler-topic: 1\nlanguage: typescript\nprojectType: application\n---\n/u);

      await fs.rm(path.join(root, 'intake-container'), { recursive: true, force: true });
      const before = captured.length;
      outputForCall = (call) => call === before + 1 ? infeasibleTurn() : CLEAR_TURN;
      const vague = await intake({ requirement: 'Build a Python library that parses CSV files.\n',
        script: { feasibility: 'revise', revised: 'Build a tool that converts CSV files.', language: 'typescript', deliverable: 'application' } });
      expect(vague.seen.selects).toEqual(['feasibility', 'language', 'gate1']);
      expect(parseContexts(vague.events)[1]).toMatchObject({ language: 'typescript', projectType: 'application' });
    });

    it('asks the deliverable when the requirement leaves its form open, and skips a language it names', { timeout: 30_000 }, async () => {
      const run = await intake({ requirement: 'Build a Python SDK and a CLI for the weather API.\n', script: { deliverable: 'library' } });
      expect(run.seen.selects).toEqual(['deliverable', 'gate1']);
      expect(clarifyInputs(run.events)[0]!.auditContext).toMatchObject({ parseContext: { language: 'python', projectType: 'library',
        questionId: 'Q2', transcript: [{ id: 'Q1', category: 'boundary', answer: `B. ${zh.intakeDeliverable.options.library}` }] } });
      expect(run.draft).toMatch(/^---\nxcompiler-topic: 1\nlanguage: python\nprojectType: library\n---\n/u);
    });

    it('takes the language from the topic front matter over words in its body', { timeout: 30_000 }, async () => {
      outputForCall = () => '{}';
      const run = await intake({ topic: '---\nxcompiler-topic: 1\nlanguage: typescript\n---\n# Topic\n\nReplace the old Python script with a command that prints one greeting.\n' });
      expect(run.outcome).toBeDefined();
      expect(run.seen.selects).toEqual([]);
      expect(run.events.find((event) => event.messageId === 'compile.language_resolved')!.data)
        .toMatchObject({ language: 'typescript', source: 'topic' });
      const planning = run.events.filter((event) => event.messageId === 'llm.business_request_input')
        .map((event) => event.data!.input as BusinessRequestInput)
        .find((input) => input.auditContext?.kind === 'planning-phase-plan');
      expect(planning!.auditContext).toMatchObject({ parseContext: { language: 'typescript' } });
    });

    it('pins the planned deliverable form to the one the topic decided', { timeout: 30_000 }, async () => {
      outputForCall = (call) => call === 1 ? PHASE_PLAN_ANSWER : '{}';
      const run = await intake({ topic: '---\nxcompiler-topic: 1\nprojectType: library\n---\n# Topic\n\nBuild a small Python command that prints one greeting.\n' });
      expect(run.outcome).toBeDefined();
      expect(run.events.find((event) => event.messageId === 'compile.project_type_pinned')!.data)
        .toMatchObject({ decided: 'library', planned: 'application' });
      const checkpoint = JSON.parse(await fs.readFile(path.join(run.containerRoot, 'phasePlan.json'), 'utf8')) as PhasePlan;
      expect(checkpoint.projectType).toBe('library');
    });

    it('judges feasibility against the sandbox the configuration gives the decided language', { timeout: 30_000 }, async () => {
      type Sandboxes = { agent: { sandboxes: { typescript: { local: { limits: { network: string } } } } } };
      const run = await intake({ script: { language: 'typescript' },
        configure: (config) => { (config as Sandboxes).agent.sandboxes.typescript.local.limits.network = 'full'; } });
      expect(clarifyInputs(run.events)[0]!.auditContext).toMatchObject({ parseContext: { language: 'typescript',
        sandbox: { mode: 'subprocess', network: 'full' } } });
    });

    it('shows an undeliverable verdict and, when the user narrows, records the scope as an answer the next turn builds on', { timeout: 30_000 }, async () => {
      const scope = 'A Python service exposing the API the app would call.';
      outputForCall = (call) => call === 1 ? infeasibleTurn(scope) : CLEAR_TURN;
      const run = await intake({ script: { language: 'python', feasibility: 'narrow' } });
      expect(run.seen.selects).toEqual(['language', 'feasibility', 'gate1']);
      expect(run.seen.offered[1]).toEqual(['narrow', 'revise', 'proceed', 'cancel']);
      expect(run.seen.messages[1]).toContain(INFEASIBLE_DETAIL);
      expect(run.seen.messages[1]).toContain(scope);
      expect(run.infeasible).toEqual([expect.objectContaining({ questionId: 'Q2', choice: 'narrow', feasibleScope: scope,
        blockers: [{ kind: 'platform', detail: INFEASIBLE_DETAIL }] })]);
      const inputs = clarifyInputs(run.events);
      expect(inputs).toHaveLength(2);
      expect(inputs[1]!.auditContext).toMatchObject({ parseContext: { questionId: 'Q3', transcript: [
        { id: 'Q1' }, { id: 'Q2', category: 'boundary', answer: zh.infeasible.narrowAnswer(scope) },
      ] } });
      expect(run.ended).toMatchObject({ ended: 'clear', feasibility: 'feasible', feasibilityDecisions: [{ choice: 'narrow', scope }] });
      expect(run.draft).toContain(`${zh.topicSecFeasibility}\n\n${zh.topicFeasibility.verdict('feasible')}\n- ${zh.topicFeasibility.narrowed(scope)}`);
    });

    it('offers no narrowing without a scope, and asks again about an edited requirement', { timeout: 30_000 }, async () => {
      const revised = 'Build a Python command that prints a weekly sales report.';
      outputForCall = (call) => call === 1 ? infeasibleTurn() : CLEAR_TURN;
      const run = await intake({ script: { language: 'python', feasibility: 'revise', revised } });
      expect(run.seen.offered[1]).toEqual(['revise', 'proceed', 'cancel']);
      const inputs = clarifyInputs(run.events);
      expect(inputs).toHaveLength(2);
      // The same question id is asked again: revising is not an answer and spends none of the budget.
      expect(inputs[1]!.auditContext).toMatchObject({ parseContext: { rawRequirement: revised, questionId: 'Q2', finalAssessment: null } });
      expect(run.draft).toContain(revised);
      expect(run.draft).not.toContain(zh.topicSecFeasibility);
    });

    it('continues with the requirement as it is when the user overrides, recording the judgement in the topic', { timeout: 30_000 }, async () => {
      outputForCall = () => infeasibleTurn('A web service.');
      const run = await intake({ script: { language: 'python', feasibility: 'proceed' } });
      expect(captured).toHaveLength(1);
      expect(run.seen.selects).toEqual(['language', 'feasibility', 'gate1']);
      expect(run.ended).toMatchObject({ ended: 'proceed', finalAssessment: null, feasibility: 'infeasible', openPoints: [{ category: 'functionality' }] });
      expect(run.draft).toContain(`${zh.topicSecFeasibility}\n\n${zh.topicFeasibility.verdict('infeasible')}\n- [${zh.infeasible.blockerKinds.platform}] ${INFEASIBLE_DETAIL}\n- ${zh.topicFeasibility.proceeded}`);
    });

    it('cancels the build at clarification when the user chooses to', { timeout: 30_000 }, async () => {
      outputForCall = () => infeasibleTurn();
      const run = await intake({ script: { language: 'python', feasibility: 'cancel' } });
      expect(run.outcome).toBeUndefined();
      expect(run.seen.selects).toEqual(['language', 'feasibility']);
      expect(run.draft).toBeUndefined();
      expect(run.events.find((event) => event.messageId === 'audit.session_end')!.data).toMatchObject({ status: 'cancelled', stage: 'clarification' });
      expect(run.events.some((event) => event.messageId === 'compile.clarification_ended')).toBe(false);
      await expect(fs.stat(path.join(run.containerRoot, '.xcompiler', 'drafts', 'build', 'intake.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a topic whose XCompiler front matter holds an unknown value, before any model call', { timeout: 30_000 }, async () => {
      const run = await intake({ topic: '---\nxcompiler-topic: 1\nlanguage: rust\n---\n# Topic\n\nBuild a greeting command.\n' });
      expect(run.outcome).toMatchObject({ code: 'topic_front_matter_invalid' });
      expect(captured).toHaveLength(0);
    });
  });
});
