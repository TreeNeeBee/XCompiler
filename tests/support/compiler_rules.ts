import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRuleBindings, type RuleBindingRequest } from '../../src/application/rules/rule_binding.js';
import { RuleDecorator } from '../../src/application/rules/rule_decorator.js';
import { RuleSelector } from '../../src/application/rules/rule_selector.js';
import type { RuleLocale } from '../../src/domain/rules/catalogue.js';
import { loadCompilerRuleCatalogue } from '../../src/infrastructure/rules/compiler_rule_catalogue.js';

/** The repository's own installed compiler Rules, verified against the release manifest. */
export const INSTALLED_RULES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'rules');

export function installedCompilerRules() {
  return loadCompilerRuleCatalogue(INSTALLED_RULES_ROOT);
}

/** The Rule block the installed Rules put in front of one request, decorated exactly as it is sent. */
export async function boundRuleBlock(bind: RuleBindingRequest, locale: RuleLocale = 'en') {
  const catalogue = await installedCompilerRules();
  const selector = new RuleSelector(catalogue);
  const context = { role: bind.role, work: bind.work, ...(bind.language ? { language: bind.language } : {}), locale };
  const prepared = selector.prepare({ requestKind: 'business', context, required: requiredRuleBindings(catalogue, bind) });
  const finished = selector.finish({ prepared, ranked: selector.rank({ prepared, query: [], vectors: [] }) });
  return {
    rules: finished.promptRules,
    content: new RuleDecorator().decorate({ requestKind: 'business', rules: finished.promptRules }),
  };
}
