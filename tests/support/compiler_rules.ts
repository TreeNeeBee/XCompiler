import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRuleBindings, type RuleBindingRequest } from '../../src/application/rules/rule_binding.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import type { RuleLocale } from '../../src/domain/rules/catalogue.js';
import type { RuleContext } from '../../src/domain/rules/selection.js';
import { loadCompilerRuleCatalogue } from '../../src/infrastructure/rules/compiler_rule_catalogue.js';

/** The repository's own installed compiler Rules, verified against the release manifest. */
export const INSTALLED_RULES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'rules');

export function installedCompilerRules() {
  return loadCompilerRuleCatalogue(INSTALLED_RULES_ROOT);
}

/** A TypeScript code Step in a greenfield project: what applicability reads from a typical Step request. */
export const TYPESCRIPT_CODE_FACTS: Readonly<Required<Pick<RuleContext, 'intent' | 'projectType' | 'tools' | 'writablePaths'>>> = Object.freeze({
  intent: 'greenfield', projectType: 'application', tools: ['read_file', 'write_file', 'add_dependency', 'run_tests'],
  writablePaths: ['src/service.ts', 'tests/service.test.ts', 'tests/fixtures/'],
});

/**
 * The Rule block the installed Rules put in front of one request, decorated exactly as it is sent
 * with the `bound-only` strategy. `facts` are the request facts applicability reads (revision 11.4).
 */
export async function boundRuleBlock(
  bind: RuleBindingRequest, locale: RuleLocale = 'en',
  facts: Pick<RuleContext, 'intent' | 'projectType' | 'tools' | 'writablePaths' | 'failureCategory' | 'outputLanguage'> = {},
) {
  const catalogue = await installedCompilerRules();
  const selector = new RuleSelector(catalogue);
  const context: RuleContext = {
    role: bind.role, work: bind.work, ...(bind.language ? { language: bind.language } : {}), locale,
    ...facts, ...(facts.tools ? { tools: [...facts.tools] } : {}), ...(facts.writablePaths ? { writablePaths: [...facts.writablePaths] } : {}),
  };
  const prepared = selector.prepare({
    requestKind: 'business', context, required: requiredRuleBindings(catalogue, bind, context), searchOpenSegments: false,
  });
  const finished = selector.finish({ prepared, ranked: selector.boundOnly({ prepared }) });
  return {
    rules: finished.promptRules,
    content: new RuleDecorator().decorate({ requestKind: 'business', rules: finished.promptRules, locale }),
  };
}
