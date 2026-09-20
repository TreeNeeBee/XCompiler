import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import { classifyFailure } from '../../src/application/execution/failure_classification.js';
import type { XCompilerConfig } from '../../src/config/config.js';
import { LLMRouter } from '../../src/llm/router.js';
import { ScoreStore } from '../../src/llm/scores.js';
import type { ChatMessage, LLMClient } from '../../src/llm/types.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-rejected-evidence-'));
  // Exercise the default policy independently of the developer's audit configuration.
  vi.stubEnv('XC_AUDIT_CONTENT_MODE', '');
  vi.stubEnv('XCOMPILER_AUDIT_CONTENT_MODE', '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function routerWithProviders(
  audit: AuditLogger,
  primary: LLMClient,
  secondary: LLMClient,
  scores?: ScoreStore,
): LLMRouter {
  const cfg = {
    llm: {
      providers: {
        primary: { type: 'openai', api_key: '', base_url: 'http://127.0.0.1:1/v1', model: 'primary' },
        secondary: { type: 'openai', api_key: '', base_url: 'http://127.0.0.1:1/v1', model: 'secondary' },
      },
      roles: { Coder: ['primary'] },
      fallbacks: ['secondary'],
      role_fallbacks: {},
      scores: {},
    },
  } as unknown as XCompilerConfig;
  const router = new LLMRouter(cfg, audit, scores, undefined, undefined, async () => ({
    ok: true,
    latencyMs: 0,
    detail: 'offline provider fixture',
  }));
  const clients = (router as unknown as { clients: Map<string, LLMClient> }).clients;
  clients.clear();
  clients.set('primary', primary);
  clients.set('secondary', secondary);
  return router;
}

async function rejectedEvents(): Promise<AuditEvent[]> {
  const jsonl = await fs.readFile(path.join(root, 'audit', 'audit.jsonl'), 'utf8');
  return jsonl.trim().split('\n')
    .map((line) => JSON.parse(line) as AuditEvent)
    .filter((event) => event.messageId === 'llm.provider_validation_failed');
}

function validateAccepted(output: string): void {
  if (output !== 'accepted') throw new Error('response does not satisfy the requested contract');
}

describe('rejected provider evidence in the raw audit', () => {
  it.each([
    { target: 'audit.jsonl', operation: 'append-jsonl' },
    { target: 'process_log.md', operation: 'append-markdown' },
    { target: 'audit-directory', operation: 'initialize' },
  ])('stops before retry, fallback or scoring when required $target storage fails', async ({ target, operation }) => {
    const audit = new AuditLogger({ root, command: 'router-evidence-failure-test' });
    await audit.start();
    const scores = new ScoreStore(path.join(root, 'config.yaml'));
    const boost = vi.spyOn(scores, 'boost').mockImplementation(() => undefined);
    const decay = vi.spyOn(scores, 'decay').mockImplementation(() => undefined);
    const followupAudit = vi.spyOn(audit, 'llmError');
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const router = routerWithProviders(audit, {
      name: 'fixture-primary-model',
      chat: async () => {
        primaryCalls++;
        if (primaryCalls > 1) return 'accepted';
        // A real filesystem failure after provider execution, preserving all earlier records.
        if (target === 'audit-directory') {
          await fs.rename(path.join(root, 'audit'), path.join(root, 'audit-before-failure'));
          await fs.writeFile(path.join(root, 'audit'), 'blocking file', 'utf8');
        } else {
          const file = path.join(root, 'audit', target);
          await fs.rename(file, `${file}.before-failure`);
          await fs.mkdir(file);
        }
        return 'rejected body api_key=synthetic-unsaved-secret';
      },
    }, {
      name: 'fixture-secondary-model',
      chat: async () => { secondaryCalls++; return 'accepted'; },
    }, scores);

    const error: unknown = await router.for('Coder').chat(
      [{ role: 'user', content: 'Inspect the full rejected response.' }],
      { validate: validateAccepted },
    ).then(() => undefined, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(AuditPersistenceError);
    if (!(error instanceof AuditPersistenceError)) throw new Error('Expected a typed storage interruption');
    expect(error.failure).toMatchObject({
      operation,
      messageId: 'llm.provider_validation_failed',
      logicalRequestId: expect.any(String),
      providerAttemptId: expect.any(String),
      systemCode: expect.any(String),
    });
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.record).toMatchObject({
      data: {
        output: 'rejected body api_key=[REDACTED]',
        provider: 'primary',
        model: 'fixture-primary-model',
      },
    });
    expect(classifyFailure(error)).toMatchObject({
      kind: 'infrastructure',
      category: 'internal',
      code: 'evidence_persistence_failed',
      retryable: false,
      switchProvider: false,
      details: { operation },
    });
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(0);
    expect(boost).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(followupAudit).not.toHaveBeenCalled();
    if (operation === 'append-markdown') {
      expect(await rejectedEvents()).toHaveLength(1);
    }
  });

  it('persists the complete response before feedback retry while retaining default secret redaction', async () => {
    const audit = new AuditLogger({ root, command: 'router-evidence-test' });
    await audit.start();
    const rejected = [
      'REJECTED_HEAD api_key=synthetic-output-credential',
      'a'.repeat(20_000),
      'MIDDLE_EVIDENCE_AFTER_FEEDBACK_LIMIT',
      'b'.repeat(20_000),
      'REJECTED_TAIL',
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Preserve diagnostic detail.' },
      { role: 'user', content: 'Inspect this candidate. api_key=synthetic-request-credential' },
    ];
    let primaryCalls = 0;
    let secondaryCalls = 0;
    let persistedBeforeRetry: AuditEvent[] = [];
    let retryMessages: ChatMessage[] = [];
    const router = routerWithProviders(audit, {
      name: 'fixture-primary-model',
      chat: async (actualMessages) => {
        primaryCalls++;
        if (primaryCalls === 1) return rejected;
        persistedBeforeRetry = await rejectedEvents();
        retryMessages = actualMessages.map((message) => ({ ...message }));
        return 'accepted';
      },
    }, {
      name: 'fixture-secondary-model',
      chat: async () => {
        secondaryCalls++;
        return 'accepted';
      },
    });

    await expect(router.for('Coder').chat(messages, { validate: validateAccepted }))
      .resolves.toBe('accepted');

    expect(primaryCalls).toBe(2);
    expect(secondaryCalls).toBe(0);
    expect(persistedBeforeRetry).toHaveLength(1);
    const redactedOutput = rejected.replace('synthetic-output-credential', '[REDACTED]');
    expect(persistedBeforeRetry[0]?.data).toMatchObject({
      role: 'Coder',
      provider: 'primary',
      model: 'fixture-primary-model',
      output: redactedOutput,
      output_chars: rejected.length,
      requestMessages: [
        messages[0],
        { role: 'user', content: 'Inspect this candidate. api_key=[REDACTED]' },
      ],
    });
    expect(retryMessages.slice(0, messages.length)).toEqual(messages);
    expect(retryMessages).toHaveLength(messages.length + 1);
    const feedback = retryMessages.at(-1)?.content;
    expect(feedback).toContain('REJECTED_HEAD');
    expect(feedback).not.toContain('MIDDLE_EVIDENCE_AFTER_FEEDBACK_LIMIT');
    expect(feedback).not.toContain('REJECTED_TAIL');

    const rawLog = await fs.readFile(path.join(root, 'audit', 'audit.jsonl'), 'utf8');
    const processLog = await fs.readFile(path.join(root, 'audit', 'process_log.md'), 'utf8');
    for (const log of [rawLog, processLog]) {
      expect(log).toContain('MIDDLE_EVIDENCE_AFTER_FEEDBACK_LIMIT');
      expect(log).toContain('REJECTED_TAIL');
      expect(log).not.toContain('synthetic-output-credential');
      expect(log).not.toContain('synthetic-request-credential');
    }
  });

  it('associates each retry and fallback rejection with its actual request and a distinct attempt', async () => {
    const audit = new AuditLogger({ root, command: 'router-evidence-test' });
    await audit.start();
    const attempts: {
      provider: string;
      model: string;
      messages: ChatMessage[];
      output: string;
      priorRejections: AuditEvent[];
    }[] = [];
    const primaryOutputs = ['primary first rejection', 'primary retry rejection', 'new request rejection', 'accepted'];
    const secondaryOutputs = ['secondary rejection', 'accepted'];
    function provider(name: string, outputs: string[]): LLMClient {
      return {
        name: `fixture-${name}-model`,
        chat: async (messages) => {
          const output = outputs.shift();
          if (output === undefined) throw new Error('unexpected fixture provider invocation');
          attempts.push({
            provider: name,
            model: `fixture-${name}-model`,
            messages: messages.map((message) => ({ ...message })),
            output,
            priorRejections: await rejectedEvents(),
          });
          return output;
        },
      };
    }
    const router = routerWithProviders(
      audit,
      provider('primary', primaryOutputs),
      provider('secondary', secondaryOutputs),
    );
    const client = router.for('Coder');
    const initialMessages: ChatMessage[] = [{ role: 'user', content: 'First logical request.' }];
    await expect(client.chat(initialMessages, { validate: validateAccepted })).resolves.toBe('accepted');
    const firstRequestFailures = await rejectedEvents();

    expect(attempts.map((attempt) => attempt.provider)).toEqual([
      'primary', 'primary', 'secondary', 'secondary',
    ]);
    expect(attempts.map((attempt) => attempt.priorRejections.length)).toEqual([0, 1, 2, 3]);
    expect(attempts[1]?.messages).toHaveLength(initialMessages.length + 1);
    expect(attempts[2]?.messages).toEqual(initialMessages);
    expect(attempts[3]?.messages).toHaveLength(initialMessages.length + 1);
    expect(firstRequestFailures).toHaveLength(3);
    for (const [index, event] of firstRequestFailures.entries()) {
      const attempt = attempts[index]!;
      expect(event.kind).toBe('llm.error');
      expect(event.data).toMatchObject({
        role: 'Coder',
        provider: attempt.provider,
        model: attempt.model,
        requestMessages: attempt.messages,
        output: attempt.output,
      });
      expect(event.data?.logicalRequestId).toEqual(expect.any(String));
      expect(event.data?.providerAttemptId).toEqual(expect.any(String));
      expect(event.data?.logicalRequestId).not.toBe('');
      expect(event.data?.providerAttemptId).not.toBe('');
    }
    const firstLogicalId = firstRequestFailures[0]?.data?.logicalRequestId;
    expect(new Set(firstRequestFailures.map((event) => event.data?.logicalRequestId)).size).toBe(1);
    expect(new Set(firstRequestFailures.map((event) => event.data?.providerAttemptId)).size).toBe(3);

    const nextMessages: ChatMessage[] = [{ role: 'user', content: 'Second logical request.' }];
    await expect(client.chat(nextMessages, { validate: validateAccepted })).resolves.toBe('accepted');
    const allFailures = await rejectedEvents();
    expect(allFailures).toHaveLength(4);
    expect(allFailures.slice(0, 3)).toEqual(firstRequestFailures);
    expect(allFailures[3]?.data).toMatchObject({
      role: 'Coder',
      provider: 'primary',
      model: 'fixture-primary-model',
      requestMessages: nextMessages,
      output: 'new request rejection',
    });
    expect(allFailures[3]?.data?.logicalRequestId).toEqual(expect.any(String));
    expect(allFailures[3]?.data?.logicalRequestId).not.toBe(firstLogicalId);
    expect(new Set(allFailures.map((event) => event.data?.providerAttemptId)).size).toBe(4);
    expect(attempts.map((attempt) => attempt.priorRejections.length)).toEqual([0, 1, 2, 3, 3, 4]);
  });
});
