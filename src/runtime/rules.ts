import path from 'node:path';
import type { XCompilerRuleConfig } from '../config/config.js';
import { FileRuleRequestStateStore } from '../infrastructure/rules/file_rule_request_state_store.js';
import { FileRuleVectorIndexStore } from '../infrastructure/rules/file_rule_vector_index_store.js';
import {
  HttpRuleEmbeddingClient,
  type HttpRuleEmbeddingConfig,
} from '../infrastructure/rules/http_rule_embedding_client.js';
import { RuleRequestCoordinator } from '../application/rules/rule_request_coordinator.js';
import { RuleVectorRetriever } from '../application/rules/rule_vector_retriever.js';
import { RuleDecorator } from '../application/rules/rule_decorator.js';
import { RuleSelector } from '../application/rules/rule_selector.js';
import { createRuleSelectionDraft } from '../application/rules/rule_request_snapshot.js';
import { RuleRetrievalProfileSchema, type RuleContext } from '../domain/rules/selection.js';
import type { RuleCatalogue } from '../domain/rules/catalogue.js';
import type { LLMRouter } from '../llm/router.js';
import { LLMRuleSelectionReviewer } from '../llm/rule_selection_reviewer.js';
import { CONTAINER_STATE_DIR, ProjectContainer } from '../workspace/project_container.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import { RecordReplayRuleEmbeddingClient } from '../infrastructure/rules/record_replay_rule_embedding_client.js';
import { FileRuleReviewAuditReader } from '../infrastructure/rules/file_rule_review_audit_reader.js';
import { LLMRuleReviewEvidenceVerifier } from '../llm/rule_review_evidence.js';
import { installedCompilerRulesRoot } from '../config/installation_root.js';
import { loadCompilerRuleCatalogue } from '../infrastructure/rules/compiler_rule_catalogue.js';
import { LLMRuleBusinessRequest, type RuleBusinessChatOptions } from '../llm/rule_business_request.js';
import type { ChatMessage } from '../llm/types.js';

export class RuntimeRuleConfigurationError extends Error {
  readonly code = 'runtime_rule_configuration_failed';

  constructor(
    readonly reason: 'embedding_not_configured' | 'invalid_state_root' | 'review_role_missing' | 'business_role_missing',
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Runtime Rule configuration failed: ${reason}`, options);
    this.name = 'RuntimeRuleConfigurationError';
  }
}

/** Internal F1/R1 composition. Production callers still own persistent IDs and business inputs. */
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
  return new LLMRuleBusinessRequest(input.router.for(role), new RuleDecorator()).send({
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
  logicalRequestId: string;
  context: RuleContext;
  required: readonly { ruleId: string; version: string }[];
  taskSummary: string;
  errorSummary?: string;
  /** Internal composition only, not SDK configuration. Recovery never reloads current sources. */
  loadCatalogue?: () => Promise<RuleCatalogue>;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const infrastructure = createRuntimeRuleInfrastructure(input.config, input.container, input.recordReplay);
  const coordinator = new RuleRequestCoordinator(infrastructure.requestStateStore, {
    review: async (review) => {
      const role = review.draft.context.role;
      if (!role) throw new RuntimeRuleConfigurationError('review_role_missing', {
        logicalRequestId: review.draft.logicalRequestId,
      });
      return new LLMRuleSelectionReviewer(input.router.for(role), new RuleDecorator()).review(review);
    },
  }, new LLMRuleReviewEvidenceVerifier(
    new FileRuleReviewAuditReader(input.container.state.abs('audit'), input.container.root),
  ));
  return coordinator.prepare({
    logicalRequestId: input.logicalRequestId, requestKind: 'business', signal: input.signal,
    prepareSelection: async () => {
      const catalogue = input.loadCatalogue
        ? await input.loadCatalogue()
        : await loadCompilerRuleCatalogue(installedCompilerRulesRoot());
      const selector = new RuleSelector(catalogue);
      input.signal?.throwIfAborted();
      const request = { requestKind: 'business' as const, context: input.context, required: input.required };
      const prepared = selector.prepare(request);
      const profile = RuleRetrievalProfileSchema.parse(input.config.retrieval);
      // The required-only path has no vector operation and therefore requires no embedding config.
      const selection = prepared.optional.length
        ? await selector.retrieve({
          ...request, profile, taskSummary: input.taskSummary, errorSummary: input.errorSummary,
          retriever: infrastructure.createRetriever(), signal: input.signal,
        })
        : { prepared, ranked: selector.rank({ prepared, query: [], vectors: [], profile }) };
      if (selection.ranked.decision === 'review-required' && !prepared.context.role) {
        throw new RuntimeRuleConfigurationError('review_role_missing', { logicalRequestId: input.logicalRequestId });
      }
      return createRuleSelectionDraft({
        ...selection, logicalRequestId: input.logicalRequestId, requestKind: 'business',
        createdAt: new Date().toISOString(),
      });
    },
  });
}
