import path from 'node:path';
import type { XCompilerRuleConfig } from '../config/config.js';
import { FileRuleRequestStateStore } from '../infrastructure/rules/file_rule_request_state_store.js';
import { FileRuleVectorIndexStore } from '../infrastructure/rules/file_rule_vector_index_store.js';
import {
  HttpRuleEmbeddingClient,
  type HttpRuleEmbeddingConfig,
} from '../infrastructure/rules/http_rule_embedding_client.js';
import { RuleRequestCoordinator } from '../application/rules/rule_request_coordinator.js';
import { RuleVectorError, RuleVectorRetriever } from '../application/rules/rule_vector_retriever.js';
import { RuleDecorator } from '../application/rules/rule_decorator.js';
import { RuleSelectionError, RuleSelector } from '../application/rules/rule_selector.js';
import { createRuleSelectionDraft, type RuleSelectionFallback } from '../application/rules/rule_request_snapshot.js';
import { requiredRuleBindings, type RuleBindingRequest } from '../application/rules/rule_binding.js';
import { ruleSelectionStrategyFor } from '../domain/rules/partitions.js';
import { RuleRetrievalProfileSchema, type RuleContext, type RuleSelectionFallbackReason } from '../domain/rules/selection.js';
import type { RuleCatalogue } from '../domain/rules/catalogue.js';
import type { LLMRouter } from '../llm/router.js';
import { LLMRuleSelectionReviewer, RuleSelectionReviewError } from '../llm/rule_selection_reviewer.js';
import { LLMRequestError } from '../llm/errors.js';
import { CONTAINER_STATE_DIR, ProjectContainer } from '../workspace/project_container.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import { RecordReplayError } from '../application/record_replay/types.js';
import { RuleEmbeddingHttpError } from '../infrastructure/rules/http_rule_embedding_client.js';
import { RecordReplayRuleEmbeddingClient } from '../infrastructure/rules/record_replay_rule_embedding_client.js';
import { installedCompilerRulesRoot, installedRuleOverlayRoot } from '../config/installation_root.js';
import { loadEffectiveRuleCatalogue } from '../infrastructure/rules/effective_rule_catalogue.js';
import { LLMRuleBusinessRequest, type RuleBusinessChatOptions } from '../llm/rule_business_request.js';
import type { ChatMessage, ModelPoolBinding } from '../llm/types.js';
import { roleProfile } from '../domain/workflow/role.js';

export class RuntimeRuleConfigurationError extends Error {
  readonly code = 'runtime_rule_configuration_failed';

  constructor(
    readonly reason: 'embedding_not_configured' | 'invalid_state_root' | 'review_role_missing' | 'business_role_missing'
      | 'binding_context_mismatch',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Runtime Rule configuration failed: ${reason}`, options);
    this.name = 'RuntimeRuleConfigurationError';
  }
}

/** Internal composition of Rule selection and its evidence. Production callers still own persistent IDs and business inputs. */
export async function sendRuntimeRuleRequest(input: Parameters<typeof prepareRuntimeRuleRequest>[0] & {
  messages: readonly ChatMessage[];
  options?: RuleBusinessChatOptions;
}) {
  const snapshot = await prepareRuntimeRuleRequest(input);
  input.signal?.throwIfAborted();
  const role = snapshot.context.role;
  if (!role) throw new RuntimeRuleConfigurationError('business_role_missing', {
    logicalRequestId: snapshot.logicalRequestId,
  });
  return new LLMRuleBusinessRequest(input.router.forPool(input.modelPool ?? roleProfile(role).defaultPool, { label: role }), new RuleDecorator()).send({
    snapshot, messages: input.messages, options: input.options, signal: input.signal,
  });
}

/** Runtime alone chooses the state paths; embedding is needed only for a fresh optional selection. */
export function createRuntimeRuleInfrastructure(
  config: XCompilerRuleConfig,
  container: ProjectContainer,
  recordReplay: RecordReplayController,
) {
  if (!(container instanceof ProjectContainer) || !path.isAbsolute(container.root)
    || container.root === path.parse(container.root).root
    || container.state.root !== path.join(container.root, CONTAINER_STATE_DIR)) {
    throw new RuntimeRuleConfigurationError('invalid_state_root');
  }
  const indexRoot = container.state.abs('rules', 'indexes');
  const requestStateRoot = container.state.abs('rules', 'requests');
  const vectorIndexStore = new FileRuleVectorIndexStore(indexRoot, container.root);
  const requestStateStore = new FileRuleRequestStateStore(requestStateRoot, container.root);
  return Object.freeze({
    vectorIndexStore, requestStateStore,
    createRetriever: () => {
      const embedding = config.embedding;
      if (!embedding) throw new RuntimeRuleConfigurationError('embedding_not_configured');
      const clientConfig: HttpRuleEmbeddingConfig = {
        provider: embedding.provider, apiKey: embedding.api_key, baseUrl: embedding.base_url,
        model: embedding.model, spaceVersion: embedding.space_version, dimensions: embedding.dimensions,
        requestTimeoutMs: embedding.request_timeout_ms,
      };
      return new RuleVectorRetriever(new RecordReplayRuleEmbeddingClient(
        new HttpRuleEmbeddingClient(clientConfig), recordReplay, clientConfig.baseUrl,
      ), vectorIndexStore);
    },
  });
}

/** Internal composition for caller migration; build/run still own logical-request IDs. */
export async function prepareRuntimeRuleRequest(input: {
  config: XCompilerRuleConfig;
  container: ProjectContainer;
  recordReplay: RecordReplayController;
  router: LLMRouter;
  /** The original pool policy and candidates; low-score review uses the same binding as business. */
  modelPool?: ModelPoolBinding;
  logicalRequestId: string;
  /** The snapshot this selection identity already pinned in the caller's live execution (D-6). */
  pinnedDigest?: string;
  context: RuleContext;
  /** Runtime's binding computation (D-14): language, role and work Rules this request must carry. */
  bind?: RuleBindingRequest;
  /** Further explicit bindings; production callers use `bind`. */
  required?: readonly { ruleId: string; version: string }[];
  taskSummary: string;
  errorSummary?: string;
  /** Internal composition only, not SDK configuration. Recovery never reloads current sources. */
  loadCatalogue?: () => Promise<RuleCatalogue>;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const bind = input.bind;
  if (bind && (bind.role !== input.context.role || bind.work !== input.context.work
    || bind.language !== input.context.language)) {
    throw new RuntimeRuleConfigurationError('binding_context_mismatch', { logicalRequestId: input.logicalRequestId });
  }
  const infrastructure = createRuntimeRuleInfrastructure(input.config, input.container, input.recordReplay);
  const coordinator = new RuleRequestCoordinator(infrastructure.requestStateStore, {
    review: async (review) => {
      const role = review.draft.context.role;
      if (!role) throw new RuntimeRuleConfigurationError('review_role_missing', {
        logicalRequestId: review.draft.logicalRequestId,
      });
      const client = input.router.forPool(input.modelPool ?? roleProfile(role).defaultPool, { label: role });
      return new LLMRuleSelectionReviewer(client, new RuleDecorator()).review(review);
    },
    failureOf: reviewFailure,
  });
  return coordinator.prepare({
    logicalRequestId: input.logicalRequestId, requestKind: 'business', pinnedDigest: input.pinnedDigest, signal: input.signal,
    prepareSelection: async () => {
      const catalogue = input.loadCatalogue
        ? await input.loadCatalogue()
        : (await loadEffectiveRuleCatalogue({ baseRoot: installedCompilerRulesRoot(), overlayRoot: installedRuleOverlayRoot() })).catalogue;
      const selector = new RuleSelector(catalogue);
      input.signal?.throwIfAborted();
      const required = [...(input.required ?? []), ...(bind ? requiredRuleBindings(catalogue, bind, input.context) : [])];
      const request = {
        requestKind: 'business' as const, context: input.context, required,
        profile: RuleRetrievalProfileSchema.parse(input.config.retrieval),
        taskSummary: input.taskSummary, errorSummary: input.errorSummary, signal: input.signal,
      };
      // Configuration chooses the default strategy and code narrows it per work (revision 11.2).
      const strategy = ruleSelectionStrategyFor(input.context.work, input.config.selection.strategy);
      let selection: Awaited<ReturnType<RuleSelector['retrieve']>>;
      let fallback: RuleSelectionFallback | undefined;
      try {
        selection = await selector.retrieve({
          ...request, strategy, ...(strategy === 'embedding' ? { retriever: infrastructure.createRetriever() } : {}),
        });
      } catch (cause) {
        // A failed or oversized selection leaves this request its required Rules (revision 11.3).
        const reason = input.signal?.aborted ? undefined : selectionFallbackReason(cause);
        if (!reason) throw cause;
        const typed = cause as { code: string; reason?: unknown };
        fallback = { reason, cause: { code: typed.code, ...(typeof typed.reason === 'string' ? { reason: typed.reason } : {}) } };
        selection = await selector.retrieve({ ...request, strategy: 'bound-only' });
      }
      if (selection.ranked.decision === 'review-required' && !selection.prepared.context.role) {
        throw new RuntimeRuleConfigurationError('review_role_missing', { logicalRequestId: input.logicalRequestId });
      }
      return createRuleSelectionDraft({
        ...selection, logicalRequestId: input.logicalRequestId, requestKind: 'business', createdAt: new Date().toISOString(),
        ...(fallback ? { fallback } : {}),
      });
    },
  });
}

/**
 * Selection failures a request falls back from (revision 11.3): the embedding service failed or
 * returned unusable vectors, or there were more candidates than one review may read. A replay miss,
 * local index or state problems and configuration errors are not the service failing; they surface.
 */
function selectionFallbackReason(cause: unknown): Exclude<RuleSelectionFallbackReason, 'review_failed'> | undefined {
  if (cause instanceof RuleSelectionError && cause.reason === 'too_many_candidates') return 'too_many_candidates';
  if (cause instanceof RuleEmbeddingHttpError) return 'retrieval_failed';
  if (cause instanceof RuleVectorError && cause.reason === 'embedding_invalid') return 'retrieval_failed';
  if (cause instanceof RuleVectorError && cause.reason === 'embedding_failed' && !(cause.cause instanceof RecordReplayError)) {
    return 'retrieval_failed';
  }
  return undefined;
}

/** Review failures a request falls back from: the reviewer's answer was unusable, or its provider call failed. */
function reviewFailure(cause: unknown): RuleSelectionFallback['cause'] {
  if (cause instanceof RuleSelectionReviewError && (cause.reason === 'invalid_output' || cause.reason === 'response_evidence_invalid')) {
    return { code: cause.code, reason: cause.reason };
  }
  if (cause instanceof LLMRequestError) return { code: 'llm_request_failed', reason: cause.failure.code };
  return undefined;
}
