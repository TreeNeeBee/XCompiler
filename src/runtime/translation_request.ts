import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import { TextTranslationOwnerSchema } from '../application/execution/business_request_input.js';
import { BusinessResponseError } from '../application/execution/business_request_response.js';
import type { RecordReplayController } from '../application/record_replay/controller.js';
import {
  buildTranslationMessages, PromptTranslator, TEXT_TRANSLATION_PROTOCOL, TEXT_TRANSLATION_TEMPLATE_VERSION,
  TranslationContractViolation, validateTranslationResponse, type TextTranslationPort,
} from '../application/translation/text_translation.js';
import { getLocale, isPromptTranslationActive, t } from '../i18n/index.js';
import { FileTranslationCache } from '../infrastructure/translation/file_translation_cache.js';
import { runtimeLog, type RuntimeIO } from './io.js';
import type { XCompilerConfig } from '../config/config.js';
import { roleProfile } from '../domain/workflow/role.js';
import { ResponseValidationRejection } from '../llm/errors.js';
import { assessJsonProtocolResponse } from '../llm/protocol_candidate.js';
import { proveJsonProtocolCorrection } from '../llm/protocol_json.js';
import type { RoutedResponseEvidence } from '../llm/response_evidence.js';
import type { LLMRouter } from '../llm/router.js';
import { snapshotRuleBusinessChatOptions } from '../llm/rule_business_request.js';
import { isCancellationError } from '../util/cancellation.js';
import type { ProjectContainer } from '../workspace/project_container.js';
import { sendRuntimeValidatedBusinessRequest } from './business_request_attempts.js';
import { createRuntimeBusinessRequestRecovery } from './business_request_recovery.js';
import { correctRuntimeProtocolResponse, protocolCorrectionReference, type RuntimeProtocolCorrection } from './protocol_correction.js';
import { prepareRuntimeRuleRequest } from './rules.js';

export class TranslationProtocolError extends Error {
  readonly code = 'translation_protocol_invalid';
  constructor(readonly assessment: ReturnType<typeof assessJsonProtocolResponse>) {
    super('Translation response did not satisfy its complete-output protocol.');
    this.name = 'TranslationProtocolError';
  }
}

/**
 * The pool translations run in: `llm.pools.translation` when configured (a cheaper model will
 * do), otherwise PM's own pool, since PM owns what passes between the user and the models.
 */
export function translationPool(cfg: Pick<XCompilerConfig, 'llm'>): string {
  return Object.hasOwn(cfg.llm.pools, 'translation') ? 'translation' : roleProfile('project-manager').defaultPool;
}

/**
 * Translation through the retained business request path: the request, its Rule snapshot and the
 * adopted reply are audited and replayable like any other model request. Each call is one logical
 * request; the caller caches translations, so the same text is not sent twice.
 */
export function createRuntimeTranslationPort(input: {
  config: XCompilerConfig; container: ProjectContainer; recordReplay: RecordReplayController;
  router: LLMRouter; audit: AuditLogger;
}): TextTranslationPort {
  const { config, container, recordReplay, router, audit } = input;
  const profile = roleProfile('project-manager');
  const modelPool = router.resolvePool(translationPool(config));
  return Object.freeze({
    name: router.forPool(modelPool, { label: 'translation' }).name,
    async translate(request: Parameters<TextTranslationPort['translate']>[0]) {
      const { from, to, signal } = request;
      const texts = [...request.texts];
      signal?.throwIfAborted();
      const owner = Object.freeze(TextTranslationOwnerSchema.parse({
        kind: 'text-translation', operationId: randomUUID(),
        role: profile.id, roleVersion: profile.version, work: 'text.translate', ...modelPool,
      }));
      const logicalRequestId = randomUUID();
      await prepareRuntimeRuleRequest({ config: config.rules, container, recordReplay, router, modelPool, logicalRequestId,
        // A translation's own output is in the target language, which is what the output-language Rule names.
        context: { role: 'project-manager', work: 'text.translate', locale: 'en', outputLanguage: to },
        bind: { role: 'project-manager', work: 'text.translate' }, taskSummary: texts.join('\n').slice(0, 2000), signal,
      });
      signal?.throwIfAborted();
      const corrections = new Map<string, RuntimeProtocolCorrection>();
      // Streamed like every other business request, so the first-token and idle guards apply to it too.
      const options = snapshotRuleBusinessChatOptions({ responseFormat: 'json', temperature: 0, onToken: () => undefined }, logicalRequestId);
      const sent = await sendRuntimeValidatedBusinessRequest({ container, audit, router, options, request: {
        logicalRequestId, owner, templateVersion: TEXT_TRANSLATION_TEMPLATE_VERSION,
        outputProtocol: TEXT_TRANSLATION_PROTOCOL, messages: buildTranslationMessages({ from, to, texts }), signal,
      }, validateResponse: async (response) => {
        let text: string;
        try { text = translationProtocolText(response); }
        catch (cause) {
          if (!(cause instanceof TranslationProtocolError)) throw cause;
          const corrected = await correctRuntimeProtocolResponse({ container, router, audit, response,
            protocol: TEXT_TRANSLATION_PROTOCOL, signal });
          if (!corrected) throw new ResponseValidationRejection('protocol', cause);
          corrections.set(response.providerAttemptId.toLowerCase(), corrected);
          text = corrected.text;
        }
        signal?.throwIfAborted();
        try { validateTranslationResponse(text, texts); }
        catch (cause) {
          if (isCancellationError(cause, signal) || !(cause instanceof TranslationContractViolation)) throw cause;
          throw new ResponseValidationRejection('business', cause);
        }
      } });
      signal?.throwIfAborted();
      const processed = await createRuntimeBusinessRequestRecovery(container, audit).process(sent.source, signal);
      signal?.throwIfAborted();
      const correction = corrections.get(sent.source.response.providerAttemptId.toLowerCase());
      const translations = validateTranslationResponse(correction?.text ?? translationProtocolText(sent.source.response), texts);
      await audit.event('llm.response', `Translated ${texts.length} text(s) from ${from} to ${to}`, {
        messageId: 'llm.translation_adopted', logicalRequestId, owner, from, to, texts: texts.length,
        responseRecordId: processed.record.responseRecordId, responseRecordDigest: processed.record.digest,
        protocolResultId: processed.result.resultRecordId, protocolResultDigest: processed.result.digest,
        ...(correction ? { protocolCorrection: protocolCorrectionReference(correction) } : {}),
      }, { persistence: 'required', location: { containerRoot: container.root, auditRoot: container.state.abs('audit') } });
      return translations;
    },
  });
}

function translationProtocolText(response: RoutedResponseEvidence): string {
  const assessment = assessJsonProtocolResponse(response, TEXT_TRANSLATION_PROTOCOL);
  if (assessment.status !== 'assessed' || assessment.result.status === 'unresolved') {
    throw new TranslationProtocolError(assessment);
  }
  if (assessment.result.status === 'repairable') {
    const proof = proveJsonProtocolCorrection(response.output, assessment.result.normalized, TEXT_TRANSLATION_PROTOCOL);
    if (proof.status !== 'preserved') throw new BusinessResponseError('invalid', {
      logicalRequestId: response.logicalRequestId, field: 'normalization_proof', proof,
    });
  }
  return assessment.result.normalized;
}

/**
 * The translator Build and Run use. It translates only with `prompt_translate: on` and a locale
 * other than English; otherwise every text passes through unchanged and no model is asked.
 */
export function createRuntimePromptTranslator(input: {
  config: XCompilerConfig; container: ProjectContainer; recordReplay: RecordReplayController;
  router: LLMRouter; audit: AuditLogger; io: RuntimeIO; signal?: AbortSignal;
}): PromptTranslator {
  const { config, container, audit, io, signal } = input;
  return new PromptTranslator({
    userLocale: getLocale(), enabled: config.prompt_translate === 'on',
    port: isPromptTranslationActive() ? createRuntimeTranslationPort(input) : undefined,
    cache: new FileTranslationCache(container.state),
    signal,
    onFallback: async (event) => {
      await runtimeLog(io, 'warning', t().translation.fallback(event.texts));
      await audit.event('note', `translation unavailable for ${event.texts} text(s); kept as written`, {
        messageId: 'translation.fallback', ...event,
      });
    },
  });
}
