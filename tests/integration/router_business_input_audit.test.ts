import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';
import { AuditPersistenceError } from '../../src/audit/errors.js';
import { classifyFailure } from '../../src/application/execution/failure_classification.js';
import type { BusinessInputAuditBinding } from '../../src/application/rules/rule_request_binding.js';
import type { XCompilerConfig } from '../../src/config/config.js';
import { LLMRouter } from '../../src/llm/router.js';
import { LLMRequestError } from '../../src/llm/errors.js';
import { ScoreStore } from '../../src/llm/scores.js';
import * as doctor from '../../src/application/diagnostics/doctor.js';
import type { LLMClient } from '../../src/llm/types.js';
import { PluginHost } from '../../src/plugins/host.js';
import { XCOMPILER_PLUGIN_API_VERSION, XCOMPILER_VERSION } from '../../src/version.js';

let root: string;
const servers: Server[] = [];
const logicalRequestId = '47bf7191-875d-427f-88f3-c822e87a28f4';
const messages = [{ role: 'user' as const, content: 'Evaluate the current scenario evidence.' }];
const digest = `sha256:${'a'.repeat(64)}`;
const binding: BusinessInputAuditBinding = {
  schemaVersion: 1, kind: 'business-input', logicalRequestId,
  snapshotDigest: digest, promptVersion: 'rule-business-request/1', requestDigest: digest,
  inputRecordId: '90362cc8-28aa-405c-87da-a1257a1dd221', inputRecordDigest: digest, inputDigest: digest,
};
const probe = async () => ({ ok: true, latencyMs: 0, detail: 'local fixture' });

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-input-router-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

function location() { return { containerRoot: root, auditRoot: path.join(root, 'audit') }; }
function config(baseUrl: string): XCompilerConfig {
  return { llm: {
    providers: { primary: { type: 'openai', base_url: baseUrl, api_key: '', model: 'requested-alias' } },
    roles: { ProjectManager: ['primary'] }, fallbacks: [], role_fallbacks: {}, scores: {},
  } } as unknown as XCompilerConfig;
}
async function events(): Promise<AuditEvent[]> {
  return (await fs.readFile(path.join(root, 'audit/audit.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as AuditEvent);
}
async function endpoint(beforeReply?: () => Promise<void>, status = 200) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      void (async () => {
        await beforeReply?.();
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(status >= 400 ? { error: { message: 'Fixture transport rejection' } } : { model: 'reported-revision', choices: [{
          index: 0, message: { content: 'accepted' }, finish_reason: 'stop',
        }] }));
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

describe('Router binds migrated business responses to the owning audit ledger', () => {
  it('preserves the original location when a Plugin mutates and replaces its options', async () => {
    const server = await endpoint();
    const scope = location();
    const wrongRoot = path.join(root, 'wrong');
    const audit = new AuditLogger({ root, command: 'scoped-business' });
    const plugins = new PluginHost({ audit, strict: true, plugins: [{
      manifest: { id: 'replace-audit-location', version: '1.0.0',
        apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
      setup(api) { api.on('llm.before', (event) => {
        scope.auditRoot = wrongRoot;
        event.options = { requiredAuditLocation: { containerRoot: root, auditRoot: wrongRoot } };
      }); },
    }] });
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, plugins, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: scope, beforeProviderRequest: () => binding,
    })).resolves.toBe('accepted');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).not.toHaveProperty('requiredAuditLocation');
    expect(JSON.stringify(server.requests)).not.toContain(root);
    const response = (await events()).find((event) => event.messageId === 'llm.provider_response');
    expect(response?.data?.requestBinding).toEqual(binding);
    expect(response?.data?.logicalRequestId).toBe(logicalRequestId);
    await expect(fs.stat(wrongRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('rejects a scoped Plugin host without an audit logger, initialized=%s', async initialized => {
    const server = await endpoint();
    const audit = new AuditLogger({ root, command: 'missing-plugin-ledger' });
    const hook = vi.fn();
    let setups = 0;
    const plugins = new PluginHost({ plugins: [{
      manifest: { id: 'missing-plugin-ledger', version: '1.0.0',
        apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
      setup(api) { setups++; api.on('llm.before', hook); },
    }] });
    if (initialized) await plugins.initialize();
    const previousSetups = setups;
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, plugins, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: {
      operation: 'initialize', logicalRequestId, messageId: 'plugins.audit_unavailable',
    } });
    expect(setups).toBe(previousSetups);
    expect(hook).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
    await expect(fs.stat(location().auditRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an explicitly configured Plugin logger from a different ledger', async () => {
    const server = await endpoint();
    const audit = new AuditLogger({ root, command: 'owning-ledger' });
    const wrongRoot = path.join(root, 'wrong');
    const wrongAudit = new AuditLogger({ root: wrongRoot, command: 'wrong-plugin-ledger' });
    const hook = vi.fn();
    const plugins = new PluginHost({ audit: wrongAudit, plugins: [{
      manifest: { id: 'wrong-plugin-ledger', version: '1.0.0',
        apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
      setup(api) { api.on('llm.before', hook); },
    }] });
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, plugins, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: {
      operation: 'initialize', logicalRequestId, messageId: 'plugins.loaded',
    } });
    expect(hook).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
    await expect(fs.stat(wrongRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(location().auditRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not pass the ledger option to the provider adapter', async () => {
    const audit = new AuditLogger({ root, command: 'adapter-options' });
    const router = new LLMRouter(config('http://127.0.0.1:1/v1'), audit, undefined, undefined, undefined, probe);
    const chat = vi.fn<LLMClient['chat']>(async (_messages, options) => {
      expect(options).not.toHaveProperty('requiredAuditLocation');
      return 'accepted';
    });
    (router as unknown as { clients: Map<string, LLMClient> }).clients.set('primary', { name: 'fixture', chat });
    await router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    });
    expect(chat).toHaveBeenCalledOnce();
  });

  it('rejects a logger from a different ledger before any audit write or provider request', async () => {
    const server = await endpoint();
    const wrongRoot = path.join(root, 'wrong');
    const audit = new AuditLogger({ root: wrongRoot, command: 'wrong-ledger' });
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, undefined, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: {
      operation: 'initialize', logicalRequestId, messageId: 'llm.required_audit_location',
    } });
    expect(server.requests).toHaveLength(0);
    await expect(fs.stat(wrongRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not invoke the provider adapter when cancelled during the final ledger preflight', async () => {
    const audit = new AuditLogger({ root, command: 'cancel-before-send' });
    const router = new LLMRouter(config('http://127.0.0.1:1/v1'), audit, undefined, undefined, undefined, probe);
    const chat = vi.fn<LLMClient['chat']>(async () => 'must not be requested');
    (router as unknown as { clients: Map<string, LLMClient> }).clients.set('primary', { name: 'fixture', chat });
    const cancellation = new Error('Owning operation cancelled');
    const controller = new AbortController();
    const preflight = audit.assertWriteLocation.bind(audit);
    let checks = 0;
    vi.spyOn(audit, 'assertWriteLocation').mockImplementation(async (...args) => {
      await preflight(...args);
      if (++checks === 2) controller.abort(cancellation);
    });
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
      signal: controller.signal,
    })).rejects.toBe(cancellation);
    expect(chat).not.toHaveBeenCalled();
  });

  it('performs a read-only ledger preflight before its first required event', async () => {
    const audit = new AuditLogger({ root, command: 'preflight' });
    await audit.assertWriteLocation(location(), logicalRequestId);
    await expect(fs.stat(location().auditRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing-scope', 'identity-mismatch', 'missing-logger'] as const)(
    'rejects %s before sending a provider request', async (reason) => {
      const server = await endpoint();
      const audit = reason === 'missing-logger' ? undefined : new AuditLogger({ root, command: reason });
      const router = new LLMRouter(config(server.url), audit, undefined, undefined, undefined, probe);
      await expect(router.for('ProjectManager').chat(messages, {
        logicalRequestId, requiredAuditLocation: reason === 'missing-scope' ? undefined : location(),
        beforeProviderRequest: () => reason === 'identity-mismatch'
          ? { ...binding, logicalRequestId: binding.inputRecordId } : binding,
      })).rejects.toMatchObject({ code: 'rule_request_binding_failed',
        reason: reason === 'missing-logger' ? 'audit_unavailable' : 'invalid' });
      expect(server.requests).toHaveLength(0);
    },
  );

  it('rechecks the actual ledger after the final request guard before transport', async () => {
    const server = await endpoint();
    const outside = path.join(root, 'outside.jsonl');
    await fs.writeFile(outside, 'outside sentinel\n');
    const audit = new AuditLogger({ root, command: 'changed-ledger' });
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, undefined, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: async () => {
        await fs.unlink(path.join(root, 'audit/audit.jsonl'));
        await fs.symlink(outside, path.join(root, 'audit/audit.jsonl'));
        return binding;
      },
    })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: {
      logicalRequestId, providerAttemptId: expect.any(String),
    } });
    expect(server.requests).toHaveLength(0);
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });

  it.each(['accepted', 'validation-failed'] as const)(
    'enforces scoped persistence on the actual %s response event without retry', async (outcome) => {
      const outside = path.join(root, 'outside.jsonl');
      await fs.writeFile(outside, 'outside sentinel\n');
      const server = await endpoint(async () => {
        await fs.unlink(path.join(root, 'audit/audit.jsonl'));
        await fs.symlink(outside, path.join(root, 'audit/audit.jsonl'));
      });
      const audit = new AuditLogger({ root, command: 'response-location' });
      const router = new LLMRouter(config(server.url), audit, undefined, undefined, undefined, probe);
      const delivered = vi.fn();
      await expect(router.for('ProjectManager').chat(messages, {
        logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
        validate: outcome === 'validation-failed' ? () => { throw new Error('Rejected current evidence'); } : undefined,
        onResponse: delivered,
      })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: {
        logicalRequestId, messageId: outcome === 'accepted' ? 'llm.provider_response' : 'llm.provider_validation_failed',
      } });
      expect(server.requests).toHaveLength(1);
      expect(delivered).not.toHaveBeenCalled();
      expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
    },
  );
});

async function replaceLedger() {
  const outside = path.join(root, 'outside.jsonl');
  await fs.writeFile(outside, 'outside sentinel\n');
  await fs.unlink(path.join(root, 'audit/audit.jsonl'));
  await fs.symlink(outside, path.join(root, 'audit/audit.jsonl'));
  return outside;
}

describe('scoped request failure and diagnostic audit boundaries', () => {
  it.each([429, 400])('stops an HTTP %s failure before retry or scoring when its failure audit is unsafe', async status => {
    let outside = '';
    const server = await endpoint(async () => { outside = await replaceLedger(); }, status);
    const audit = new AuditLogger({ root, command: 'scoped-transport-failure' });
    const scores = new ScoreStore(path.join(root, 'config.yaml'));
    const decay = vi.spyOn(scores, 'decay');
    const cfg = config(server.url);
    cfg.llm.providers.primary!.retry = { max_retries: 1, max_delay: 0, jitter: 'none' };
    const router = new LLMRouter(cfg, audit, scores, undefined, undefined, probe);
    const delivered = vi.fn();
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding, onResponse: delivered,
    })).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { logicalRequestId, providerAttemptId: expect.any(String),
        messageId: status === 429 ? 'llm.provider_retry_rate_limited' : 'llm.provider_call_failed' },
      cause: { errors: [expect.objectContaining({ failure: expect.objectContaining({ statusCode: status }) }),
        expect.any(AuditPersistenceError)] },
    });
    expect(server.requests).toHaveLength(1);
    expect(delivered).not.toHaveBeenCalled();
    expect(decay).not.toHaveBeenCalled();
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });

  it('protects the wrapper request write after a successful read-only preflight', async () => {
    const server = await endpoint();
    const audit = new AuditLogger({ root, command: 'wrapper-request' });
    await audit.start();
    const append = audit.llmRequest.bind(audit);
    let outside = '';
    vi.spyOn(audit, 'llmRequest').mockImplementation(async (...args) => {
      outside = await replaceLedger();
      return append(...args);
    });
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, undefined, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: { messageId: 'audit.llm_request', logicalRequestId } });
    expect(server.requests).toHaveLength(0);
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });

  it('protects the complete response audit before delivery or success scoring', async () => {
    const server = await endpoint();
    const audit = new AuditLogger({ root, command: 'wrapper-response' });
    const append = audit.llmResponse.bind(audit);
    let outside = '';
    vi.spyOn(audit, 'llmResponse').mockImplementation(async (...args) => {
      outside = await replaceLedger();
      return append(...args);
    });
    const scores = new ScoreStore(path.join(root, 'config.yaml'));
    const boost = vi.spyOn(scores, 'boost');
    const delivered = vi.fn();
    const router = new LLMRouter(config(server.url), audit, scores, undefined, undefined, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding, onResponse: delivered,
    })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: { messageId: 'audit.llm_response', logicalRequestId } });
    expect(server.requests).toHaveLength(1);
    expect(boost).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });

  it('retains the original failure when the wrapper error audit itself cannot be persisted', async () => {
    const server = await endpoint();
    const audit = new AuditLogger({ root, command: 'wrapper-error' });
    const append = audit.llmError.bind(audit);
    let outside = '';
    vi.spyOn(audit, 'llmError').mockImplementation(async (...args) => {
      outside = await replaceLedger();
      return append(...args);
    });
    const original = new Error('Original final-boundary failure');
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, undefined, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => { throw original; },
    })).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { messageId: 'audit.llm_error', logicalRequestId },
      cause: { errors: [original, expect.any(AuditPersistenceError)] },
    });
    expect(server.requests).toHaveLength(0);
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });

  it.each(['probe', 'window'] as const)('confines the %s diagnostic before transport', async diagnostic => {
    const server = await endpoint();
    const audit = new AuditLogger({ root, command: `scoped-${diagnostic}` });
    let outside = '';
    const changingProbe = async () => {
      outside = await replaceLedger();
      return { ok: diagnostic !== 'probe', latencyMs: 0, detail: 'fixture diagnostic' };
    };
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, undefined, changingProbe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    })).rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: { logicalRequestId,
      messageId: diagnostic === 'probe' ? 'llm.provider_probe_unreachable' : 'llm.operation_window_updated' } });
    expect(server.requests).toHaveLength(0);
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });

  it('passes the fixed scope into the default stall diagnostic and leaves its async policy to transport', async () => {
    vi.spyOn(doctor, 'runDoctor').mockResolvedValue({ sections: [], fails: 0, warns: 0 });
    const audit = new AuditLogger({ root, command: 'scoped-stall' });
    const router = new LLMRouter(config('http://127.0.0.1:1/v1'), audit, undefined, undefined, undefined, probe);
    let outside = '';
    const chat = vi.fn<LLMClient['chat']>(async (_messages, options) => {
      outside = await replaceLedger();
      await expect(options?.onStall?.({ silentForMs: 1, provider: 'primary', model: 'requested-alias' }))
        .rejects.toMatchObject({ code: 'evidence_persistence_failed', failure: {
          logicalRequestId, providerAttemptId: expect.any(String), messageId: 'llm.stall_diagnosis',
        } });
      // The adapter's existing fire-and-forget policy determines whether to observe this rejection.
      throw new Error('Fixture provider failure after diagnostic');
    });
    (router as unknown as { clients: Map<string, LLMClient> }).clients.set('primary', { name: 'fixture', chat });
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    })).rejects.toBeInstanceOf(AuditPersistenceError);
    expect(chat).toHaveBeenCalledOnce();
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });

  it('confines Plugin hook-failure notes and retains the original hook error', async () => {
    const server = await endpoint();
    const audit = new AuditLogger({ root, command: 'scoped-plugin-error' });
    const original = new Error('Fixture hook failure');
    let outside = '';
    const plugins = new PluginHost({ audit, plugins: [{
      manifest: { id: 'failing-scoped-hook', version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION,
        minXCompilerVersion: XCOMPILER_VERSION },
      setup(api) { api.on('llm.before', async () => { outside = await replaceLedger(); throw original; }); },
    }] });
    const router = new LLMRouter(config(server.url), audit, undefined, undefined, plugins, probe);
    await expect(router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    })).rejects.toMatchObject({
      code: 'evidence_persistence_failed', failure: { logicalRequestId, messageId: 'plugins.hook_failed' },
      cause: { errors: [original, expect.any(AuditPersistenceError)] },
    });
    expect(server.requests).toHaveLength(0);
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });

  it.each(['provider-error', 'cancelled'] as const)(
    'preserves the required audit or cancellation boundary after a %s notification fails', async outcome => {
      const server = await endpoint();
      const audit = new AuditLogger({ root, command: 'scoped-notification-error' });
      const controller = new AbortController();
      const original = outcome === 'cancelled' ? new Error('Owning operation cancelled') : new LLMRequestError(
        'Fixture producer failure', { code: 'provider_server_error', mode: 'router', retryable: true, switchProvider: true },
      );
      const hookFailure = new Error('Fixture error notification failed');
      let outside = '';
      const plugins = new PluginHost({ audit, plugins: [{
        manifest: { id: 'scoped-notification-fixture', version: '1.0.0', apiVersion: XCOMPILER_PLUGIN_API_VERSION,
          minXCompilerVersion: XCOMPILER_VERSION },
        setup(api) { api.on('llm.error', async () => { outside = await replaceLedger(); throw hookFailure; }); },
      }] });
      const router = new LLMRouter(config(server.url), audit, undefined, undefined, plugins, probe);
      const pending = router.for('ProjectManager').chat(messages, {
        logicalRequestId, requiredAuditLocation: location(), signal: controller.signal,
        beforeProviderRequest: () => {
          if (outcome === 'cancelled') controller.abort(original);
          throw original;
        },
      });
      if (outcome === 'cancelled') {
        await expect(pending).rejects.toBe(original);
        expect(original).toHaveProperty('notificationError', expect.any(AuditPersistenceError));
      } else {
        await expect(pending).rejects.toMatchObject({ code: 'evidence_persistence_failed',
          failure: { logicalRequestId, messageId: 'plugins.hook_failed' },
          cause: { errors: [original, expect.any(AuditPersistenceError)] },
        });
      }
      expect(server.requests).toHaveLength(0);
      expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
    },
  );

  it('retains a recorded provider failure and its score decay when a later notification audit fails', async () => {
    const server = await endpoint(undefined, 400);
    const audit = new AuditLogger({ root, command: 'recorded-failure-notification' });
    const scores = new ScoreStore(path.join(root, 'config.yaml'));
    const decay = vi.spyOn(scores, 'decay');
    const boost = vi.spyOn(scores, 'boost');
    const hookFailure = new Error('Fixture error notification failed after provider evidence');
    const retainedLedger = path.join(root, 'recorded-provider-failure.jsonl');
    const outside = path.join(root, 'outside.jsonl');
    await fs.writeFile(outside, 'outside sentinel\n');
    let providerFailure: unknown;
    const plugins = new PluginHost({ audit, plugins: [{
      manifest: { id: 'recorded-failure-notification', version: '1.0.0',
        apiVersion: XCOMPILER_PLUGIN_API_VERSION, minXCompilerVersion: XCOMPILER_VERSION },
      setup(api) { api.on('llm.error', async event => {
        providerFailure = event.error;
        await fs.rename(path.join(root, 'audit/audit.jsonl'), retainedLedger);
        await fs.symlink(outside, path.join(root, 'audit/audit.jsonl'));
        throw hookFailure;
      }); },
    }] });
    const router = new LLMRouter(config(server.url), audit, scores, undefined, plugins, probe);
    const failure: unknown = await router.for('ProjectManager').chat(messages, {
      logicalRequestId, requiredAuditLocation: location(), beforeProviderRequest: () => binding,
    }).then(() => undefined, (error: unknown) => error);
    await scores.flush();
    expect(failure).toBeInstanceOf(AuditPersistenceError);
    if (!(failure instanceof AuditPersistenceError)) throw new Error('Expected required notification audit failure');
    expect(failure.failure).toMatchObject({ logicalRequestId, messageId: 'plugins.hook_failed' });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([providerFailure, expect.any(AuditPersistenceError)]);
    expect(providerFailure).toBeInstanceOf(LLMRequestError);
    expect(providerFailure).toMatchObject({ failure: { code: 'all_providers_failed' },
      cause: { failure: { statusCode: 400 } } });
    expect(classifyFailure(failure)).toMatchObject({ code: 'evidence_persistence_failed',
      retryable: false, switchProvider: false });
    const retainedEvents = (await fs.readFile(retainedLedger, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as AuditEvent);
    expect(retainedEvents.filter(event => event.messageId === 'llm.provider_call_failed')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ logicalRequestId, providerAttemptId: expect.any(String),
        provider: 'primary', error: expect.any(String) }) }),
    ]);
    expect(server.requests).toHaveLength(1);
    expect(decay).toHaveBeenCalledExactlyOnceWith('primary', expect.any(String));
    expect(scores.get('primary')).toBe(ScoreStore.DEFAULT - ScoreStore.DECAY);
    expect(boost).not.toHaveBeenCalled();
    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel\n');
  });
});
