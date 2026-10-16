import type { ExecutorOptions } from '../../src/agents/executor.js';
import { projectExecutionProviderMessages } from '../../src/agents/execution/provider_projection.js';
import { ExecutionTurnProtocolError, parseTurn } from '../../src/agents/execution/turn_parser.js';
import type { AttemptRunnerOptions } from '../../src/application/execution/attempt_runner.js';
import { ExecutionTurnRoundRefusal, type ExecutionTurnRequestPort } from '../../src/application/execution/execution_turn_request.js';
import type { ChatOptions, LLMClient } from '../../src/llm/types.js';

/** Explicit fake transport for existing deterministic business tests; it supplies no retention evidence. */
export function fixtureExecutionRequest(llm: LLMClient): ExecutionTurnRequestPort {
  return {
    name: llm.name,
    async send(request) {
      request.signal?.throwIfAborted();
      const original = request.messages.map(message => ({ ...message }));
      const messages = original.map(message => ({ ...message }));
      let provider = llm.name;
      const candidateValidation = request.payload.validation.completionQuality || request.payload.validation.debuggerRecovery;
      const options: ChatOptions = {
        ...request.options, signal: request.signal, scoreSuccess: false,
        validate: candidateValidation ? text => { request.validate(text); } : undefined,
        onProvider: name => { provider = name; request.options?.onProvider?.(name); },
        onProviderStart: (name, model, window) => {
          provider = name;
          const projected = projectExecutionProviderMessages(request.payload, original, original, window.contextWindowTokens);
          messages.splice(0, messages.length, ...projected.messages.map(message => ({ ...message })));
          options.maxTokens = projected.maxTokens;
          request.onWindow?.(projected.window);
          request.options?.onProviderStart?.(name, model, window);
        },
      };
      const text = await llm.chat(messages, options);
      request.signal?.throwIfAborted();
      // These older business fixtures explicitly decide whether their fake transport invokes candidate
      // validation. Real Runtime integration separately proves that production cannot skip it.
      try { parseTurn(text); }
      catch (cause) {
        if (!candidateValidation && cause instanceof ExecutionTurnProtocolError) {
          throw new ExecutionTurnRoundRefusal('protocol', text, { diagnostic: cause.diagnostic,
            feedback: cause.diagnostic }, { cause });
        }
        throw cause;
      }
      request.signal?.throwIfAborted();
      return { text, provider };
    },
  };
}

export function withFixtureExecutionRequest<T extends ExecutorOptions & { llm: LLMClient }>(options: T): T & { request: ExecutionTurnRequestPort } {
  return { ...options, request: fixtureExecutionRequest(options.llm) };
}

export function withFixtureExecutionRequests<T extends AttemptRunnerOptions>(options: T): T {
  return { ...options, executionRequests: scope => fixtureExecutionRequest(
    options.router.forPool(scope.modelPool, { label: scope.role }),
  ) };
}
