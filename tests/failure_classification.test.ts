import { describe, expect, it } from 'vitest';
import { AuditPersistenceError } from '../src/audit/errors.js';
import { ExecutionTurnRequestFailure } from '../src/application/execution/execution_turn_request.js';
import { BusinessRequestInputError } from '../src/application/execution/business_request_input.js';
import { classifyFailure, isEvidencePersistenceFailure } from '../src/application/execution/failure_classification.js';
import { LLMRequestError } from '../src/llm/errors.js';

describe('retained execution request failure classification', () => {
  it('parks only the typed request-boundary failure without retry, provider switch or product blame', () => {
    const cause = new BusinessRequestInputError('identity_conflict', { logicalRequestId: 'original-request', field: 'input' });
    const failure = new ExecutionTurnRequestFailure({ stepId: 'canonical-step', role: 'Debugger', round: 3 }, { cause });
    failure.message = 'Independent presentation text.';
    expect(failure.cause).toBe(cause);
    const result = classifyFailure(failure);
    expect(result).toMatchObject({ kind: 'infrastructure', category: 'internal', code: 'execution_turn_request_failed',
      message: 'Independent presentation text.', retryable: false, switchProvider: false,
      details: { stepId: 'canonical-step', role: 'Debugger', round: 3,
        cause: { name: 'BusinessRequestInputError', reason: 'identity_conflict',
          code: 'business_request_input_failed', details: { logicalRequestId: 'original-request', field: 'input' } } } });
    expect(isEvidencePersistenceFailure(result)).toBe(false);
    expect(classifyFailure(new Error(failure.message))).toMatchObject({ kind: 'execution',
      code: 'unclassified_execution_failure' });
    expect(classifyFailure(failure.message).kind).toBe('execution');
    expect(classifyFailure({ code: failure.code, message: failure.message }).kind).toBe('execution');
  });

  it('preserves serializable original operation, target, diagnostics and nested cause evidence', () => {
    const disk = Object.assign(new Error('Original disk failure.'), { code: 'EACCES', path: '/state/request.json' });
    const source = new BusinessRequestInputError('write_failed', {
      logicalRequestId: 'original-request', target: '/state/request.json',
    }, { cause: new AggregateError([disk, new Error('Cleanup also failed.')], 'Publication failed.') });
    const error = new ExecutionTurnRequestFailure({ stepId: 'canonical-step', role: 'Coder', round: 1 }, { cause: source });
    expect(error.cause).toBe(source);
    const retained = JSON.parse(JSON.stringify(classifyFailure(error)));
    expect(retained.details.cause).toMatchObject({ name: 'BusinessRequestInputError', reason: 'write_failed',
      details: { logicalRequestId: 'original-request', target: '/state/request.json' },
      cause: { name: 'AggregateError', message: 'Publication failed.', errors: [
        { name: 'Error', message: 'Original disk failure.', code: 'EACCES', path: '/state/request.json' },
        { name: 'Error', message: 'Cleanup also failed.' },
      ] } });
    expect(retained.details.cause.stack).toContain('BusinessRequestInputError');
    expect(retained.details.cause.cause.errors[0].stack).toContain('Original disk failure.');
  });

  it('retains ordinary callback causes without interpreting their content as provider or product policy', () => {
    const cause = new Error('all LLM providers failed: generated text inside a callback exception');
    const error = new ExecutionTurnRequestFailure({ stepId: 'canonical-step', role: 'Tester', round: 2 }, { cause });
    expect(classifyFailure(error, { trustProviderText: true })).toMatchObject({ kind: 'infrastructure',
      category: 'internal', code: 'execution_turn_request_failed', retryable: false, switchProvider: false,
      details: { cause: { message: cause.message } } });
    expect(classifyFailure(cause).kind).toBe('execution');
  });

  it('preserves typed provider retry and switch flags through the existing channel', () => {
    const provider = new LLMRequestError('Provider outage.', { code: 'provider_server_error',
      retryable: true, switchProvider: true, statusCode: 503, details: { provider: 'actual-provider' } });
    expect(classifyFailure(provider)).toMatchObject({ kind: 'infrastructure', category: 'llm-provider',
      code: 'provider_server_error', retryable: true, switchProvider: true, statusCode: 503,
      details: { provider: 'actual-provider' } });
  });

  it('preserves required-audit interruption authority and excludes same-worded ordinary errors', () => {
    const cause = new Error('Disk is unavailable.');
    const audit = new AuditPersistenceError({ operation: 'append-jsonl', target: '/state/audit.jsonl',
      eventKind: 'llm.response', logicalRequestId: 'original-request' }, { cause });
    const classified = classifyFailure(audit);
    expect(classified).toMatchObject({ kind: 'infrastructure', category: 'internal', code: 'evidence_persistence_failed',
      retryable: false, switchProvider: false, details: { operation: 'append-jsonl', target: '/state/audit.jsonl' } });
    expect(isEvidencePersistenceFailure(classified)).toBe(true);
    expect(isEvidencePersistenceFailure(classifyFailure(new Error(audit.message)))).toBe(false);
  });
});
