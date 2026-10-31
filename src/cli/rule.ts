import { promises as fs } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { parse } from 'yaml';
import { t } from '../i18n/index.js';
import {
  addRuleToList, checkRules, createLocalRuleList, DEBUG_FAILURE_CATEGORIES, discardRuleOverlay, exportRuleOverlays,
  LANGUAGES, listRuleLists, PLAN_INTENTS, PROJECT_TYPES, promoteRuleOverlays, renderRules, RoleIdSchema, RULE_APPLICABILITY_DIMENSIONS, RULE_LEVELS,
  RULE_LOCALES, showRule, STEP_WORK_IDS, updateRuleInList, WorkIdSchema,
  type DebugFailureCategory, type Language, type PlanIntent, type ProjectType, type RoleId, type RuleApplicability, type RuleFields,
  type RuleLocale, type RuleLocalizedText, type StepWorkId, type WorkId,
} from '../runtime.js';

type Level = (typeof RULE_LEVELS)[number];
const capitalized = (locale: string) => locale[0]!.toUpperCase() + locale.slice(1);

function parseLevel(value: string): Level {
  if (!(RULE_LEVELS as readonly string[]).includes(value)) throw new InvalidArgumentError(t().ruleCli.optLevel);
  return value as Level;
}
function parseChoice<T extends string>(values: readonly T[], label: string) {
  return (value: string): T => {
    if (!(values as readonly string[]).includes(value)) throw new InvalidArgumentError(label);
    return value as T;
  };
}
const parseRole = (value: string): RoleId => {
  const parsed = RoleIdSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError(t().ruleCli.optRole);
  return parsed.data;
};
const parseWork = (value: string): WorkId => {
  const parsed = WorkIdSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError(t().ruleCli.optWork);
  return parsed.data;
};

/** Repeatable option values, in the order given. */
const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

/** Adds `--<field>-<locale>` for every supported locale, so a new locale needs no new flags here. */
function localizedOptions(command: Command, field: string): Command {
  for (const locale of RULE_LOCALES) command.option(`--${field}-${locale} <text>`, t().ruleCli.optText(field, locale));
  return command;
}
function localizedValue(opts: Record<string, unknown>, field: string): Partial<RuleLocalizedText> | undefined {
  const entries = RULE_LOCALES.flatMap((locale) => {
    const value = opts[`${field}${capitalized(locale)}`];
    return typeof value === 'string' ? [[locale, value] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * `--scope <dimension>=<value>`, repeatable: values of one dimension accumulate. Dimension names come
 * from the applicability registry (revision 11.4), so a new dimension needs no new option here.
 */
function parseScope(value: string, previous: Record<string, string[]> | undefined): Record<string, string[]> {
  const separator = value.indexOf('=');
  const dimension = separator > 0 ? value.slice(0, separator) : '';
  if (!Object.hasOwn(RULE_APPLICABILITY_DIMENSIONS, dimension) || separator === value.length - 1) {
    throw new InvalidArgumentError(t().ruleCli.optScope(Object.keys(RULE_APPLICABILITY_DIMENSIONS).join(', ')));
  }
  return { ...previous, [dimension]: [...(previous?.[dimension] ?? []), value.slice(separator + 1)] };
}

async function fieldsFrom(opts: Record<string, unknown>): Promise<RuleFields> {
  const fromFile = typeof opts.file === 'string' ? parse(await fs.readFile(opts.file, 'utf8')) as RuleFields : {};
  // The schema validates values when the edit is stamped; an invalid one is a typed error.
  const scope = opts.clearScope === true ? { applicability: null }
    : opts.scope ? { applicability: opts.scope as RuleApplicability } : {};
  return {
    ...fromFile,
    ...(typeof opts.name === 'string' ? { name: opts.name } : {}),
    ...(typeof opts.level === 'string' ? { level: opts.level as Level } : {}),
    description: { ...fromFile.description, ...localizedValue(opts, 'description') },
    instruction: { ...fromFile.instruction, ...localizedValue(opts, 'instruction') },
    ...scope,
  };
}
function required(fields: RuleFields): Required<Pick<RuleFields, 'name' | 'level'>> & RuleFields {
  if (!fields.name) throw new InvalidArgumentError(t().ruleCli.optName);
  if (!fields.level) throw new InvalidArgumentError(t().ruleCli.optLevel);
  return { ...fields, name: fields.name, level: fields.level };
}

/** Typed failures print their code, reason and details: the user needs the action, not just the fault. */
async function run(action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    const typed = error as { code?: unknown; reason?: unknown; details?: unknown; message?: unknown };
    if (typeof typed.code === 'string' && typeof typed.reason === 'string') {
      console.error(`${typed.code}: ${typed.reason}${typed.details ? ` ${JSON.stringify(typed.details)}` : ''}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function emit(text: string, output?: string): Promise<void> {
  if (output) await fs.writeFile(output, text, 'utf8');
  else process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function registerRuleCommand(program: Command, currentLocale: () => RuleLocale): void {
  const rule = program.command('rule').description(t().ruleCli.description);

  rule.command('ls').description(t().ruleCli.lsDescription).action(() => run(async () => {
    const rows = await listRuleLists(undefined, currentLocale());
    for (const row of rows) {
      console.log([row.slot, row.id, row.version.padEnd(16), String(row.rules).padStart(3), row.layer.padEnd(7), row.title].join('  '));
    }
  }));

  rule.command('show').description(t().ruleCli.showDescription).argument('<reference>', t().ruleCli.argReference)
    .action((reference: string) => run(async () => { await emit(await showRule(reference)); }));

  localizedOptions(localizedOptions(rule.command('add').description(t().ruleCli.addDescription)
    .argument('<list>', t().ruleCli.argList)
    .option('--name <name>', t().ruleCli.optName)
    .option('--level <level>', t().ruleCli.optLevel, parseLevel)
    .option('--scope <dimension=value>', t().ruleCli.optScope(Object.keys(RULE_APPLICABILITY_DIMENSIONS).join(', ')), parseScope)
    .option('--file <yaml>', t().ruleCli.optFile), 'description'), 'instruction')
    .action((list: string, opts: Record<string, unknown>) => run(async () => {
      const result = await addRuleToList(list, required(await fieldsFrom(opts)));
      console.log(t().ruleCli.added(result.reference, result.version));
      if (result.location) console.log(t().ruleCli.written(result.location));
    }));

  localizedOptions(localizedOptions(rule.command('update').description(t().ruleCli.updateDescription)
    .argument('<rule>', t().ruleCli.argRule)
    .option('--name <name>', t().ruleCli.optName)
    .option('--level <level>', t().ruleCli.optLevel, parseLevel)
    .option('--scope <dimension=value>', t().ruleCli.optScope(Object.keys(RULE_APPLICABILITY_DIMENSIONS).join(', ')), parseScope)
    .option('--clear-scope', t().ruleCli.optClearScope)
    .option('--file <yaml>', t().ruleCli.optFile), 'description'), 'instruction')
    .action((reference: string, opts: Record<string, unknown>) => run(async () => {
      const result = await updateRuleInList(reference, await fieldsFrom(opts));
      if (result.location) console.log(t().ruleCli.written(result.location));
    }));

  // Removing Rules is not supported yet; the name is kept so its place in the command set is stable.
  // A non-zero exit keeps scripts from taking the call for a removal.
  rule.command('rm').description(t().ruleCli.rmDescription).argument('[rule]', t().ruleCli.argRule)
    .action(() => {
      console.error('rule_command_disabled: rm');
      console.error(t().ruleCli.rmDisabled);
      process.exitCode = 1;
    });

  localizedOptions(localizedOptions(localizedOptions(rule.command('create-list').description(t().ruleCli.createListDescription)
    .requiredOption('--slot <slot>', t().ruleCli.optSlot)
    .option('--name <name>', t().ruleCli.optName)
    .option('--level <level>', t().ruleCli.optLevel, parseLevel)
    .option('--scope <dimension=value>', t().ruleCli.optScope(Object.keys(RULE_APPLICABILITY_DIMENSIONS).join(', ')), parseScope)
    .option('--file <yaml>', t().ruleCli.optFile), 'title'), 'description'), 'instruction')
    .action((opts: Record<string, unknown>) => run(async () => {
      const title = localizedValue(opts, 'title') ?? {};
      const result = await createLocalRuleList({
        title: title as RuleLocalizedText, slot: String(opts.slot), first: required(await fieldsFrom(opts)),
      });
      console.log(t().ruleCli.created(result.listId));
      if (result.location) console.log(t().ruleCli.written(result.location));
    }));

  rule.command('discard').description(t().ruleCli.discardDescription).argument('<list>', t().ruleCli.argList)
    .action((list: string) => run(async () => { console.log(t().ruleCli.removed(await discardRuleOverlay(list))); }));

  rule.command('check').description(t().ruleCli.checkDescription).action(() => run(async () => {
    const report = await checkRules();
    console.log(t().ruleCli.checkSummary(report.lists, report.rules));
    for (const overlay of report.overlays) {
      console.log(overlay.status === 'applied'
        ? t().ruleCli.overlayApplied(overlay.listId) : t().ruleCli.overlayPending(overlay.listId, overlay.reason ?? ''));
    }
    for (const invalid of report.invalidOverlays) console.log(t().ruleCli.overlayInvalid(invalid.id, invalid.reason, invalid.location));
    for (const problem of report.bindings) console.log(t().ruleCli.bindingProblem(problem.reason, problem.slot, problem.key));
    for (const finding of report.descriptions) console.log(t().ruleCli.descriptionStyle(finding.reference, finding.locales.join(', ')));
    // Near duplicates are for the author to read; they do not change the exit code (O-6).
    for (const pair of report.similar) console.log(t().ruleCli.similarRules(pair.first, pair.second, pair.similarity));
    // A binding that cannot resolve fails requests; a pending overlay or an unclear description is
    // not an error, but neither is silently in force (revision 11.7).
    // A damaged overlay file stops every request, as an unresolvable binding does.
    if (report.bindings.length || report.invalidOverlays.length) process.exitCode = 1;
    else if (report.descriptions.length || report.overlays.some((overlay) => overlay.status === 'pending')) process.exitCode = 2;
  }));

  rule.command('render').description(t().ruleCli.renderDescription)
    .requiredOption('--role <role>', t().ruleCli.optRole, parseRole)
    .requiredOption('--work <work>', t().ruleCli.optWork, parseWork)
    .option('--step-work <work>', t().ruleCli.optStepWork, parseChoice<StepWorkId>(STEP_WORK_IDS, t().ruleCli.optStepWork))
    .option('--language <language>', t().ruleCli.optLanguage, parseChoice<Language>(LANGUAGES, t().ruleCli.optLanguage))
    .option('--baseline-deferred', t().ruleCli.optBaselineDeferred, false)
    .option('--locale <locale>', t().ruleCli.optLocale, parseChoice<RuleLocale>(RULE_LOCALES, t().ruleCli.optLocale))
    .option('--output-language <locale>', t().ruleCli.optOutputLanguage,
      parseChoice<RuleLocale>(RULE_LOCALES, t().ruleCli.optOutputLanguage))
    // The request facts applicability reads (revision 11.4); a fact left out skips Rules scoped to it.
    .option('--intent <intent>', t().ruleCli.optIntent, parseChoice<PlanIntent>(PLAN_INTENTS, t().ruleCli.optIntent))
    .option('--project-type <type>', t().ruleCli.optProjectType, parseChoice<ProjectType>(PROJECT_TYPES, t().ruleCli.optProjectType))
    .option('--tool <tool>', t().ruleCli.optTool, collect, undefined)
    .option('--writable <path>', t().ruleCli.optWritablePath, collect, undefined)
    .option('--failure-category <category>', t().ruleCli.optFailureCategory,
      parseChoice<DebugFailureCategory>(DEBUG_FAILURE_CATEGORIES, t().ruleCli.optFailureCategory))
    .action((opts: {
      role: RoleId; work: WorkId; stepWork?: StepWorkId; language?: Language; baselineDeferred: boolean; locale?: RuleLocale;
      outputLanguage?: RuleLocale; intent?: PlanIntent; projectType?: ProjectType; tool?: string[]; writable?: string[]; failureCategory?: DebugFailureCategory;
    }) => run(async () => {
      await emit(await renderRules({
        role: opts.role, work: opts.work,
        ...(opts.stepWork ? { stepWork: opts.stepWork } : {}), ...(opts.language ? { language: opts.language } : {}),
        ...(opts.baselineDeferred ? { baselineDeferred: true } : {}),
        ...(opts.intent ? { intent: opts.intent } : {}), ...(opts.projectType ? { projectType: opts.projectType } : {}),
        ...(opts.tool ? { tools: opts.tool } : {}), ...(opts.writable ? { writablePaths: opts.writable } : {}),
        ...(opts.failureCategory ? { failureCategory: opts.failureCategory } : {}),
      }, opts.locale ?? currentLocale(), undefined, opts.outputLanguage));
    }));

  rule.command('export').description(t().ruleCli.exportDescription).option('-o, --output <file>', t().ruleCli.optOutput)
    .action((opts: { output?: string }) => run(async () => { await emit(await exportRuleOverlays(), opts.output); }));

  rule.command('promote').description(t().ruleCli.promoteDescription).action(() => run(async () => {
    const result = await promoteRuleOverlays();
    if (!result.promoted.length) console.log(t().ruleCli.nothingToPromote);
    else { console.log(t().ruleCli.promoted(result.promoted.join(', '))); console.log(t().ruleCli.promoteRebuild); }
    for (const listId of result.pending) console.log(t().ruleCli.overlayPending(listId, 'base_changed'));
  }));
}
