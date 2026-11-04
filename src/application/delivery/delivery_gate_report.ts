import type { TicketContractBasis } from '../../domain/tickets/ticket.js';
import { t } from '../../i18n/index.js';
import type { ProjectAuditResult } from './project_audit.js';

/** Where a Phase's delivery gate report is committed, as a deliverable of the project. */
export function deliveryGateReportPath(phaseName: string): string {
  return `docs/delivery/${phaseName.replace(/[^A-Za-z0-9._-]+/gu, '-')}-delivery-gate.md`;
}

/**
 * The delivery gate's result as a document the project keeps.
 *
 * What a gate run produced is set aside and ignored by git, so this report is what remains of the
 * run in the delivered project: every check, the command each scenario ran and how it ended, what
 * its inspections printed, the judgement and the finding it became, and where the outputs went.
 */
export function renderDeliveryGateReport(input: {
  phaseName: string;
  evaluatedAt: string;
  result: ProjectAuditResult;
  /** Where this run's outputs were set aside, when it left any. */
  setAside?: { directory: string; paths: readonly string[] };
  /** Every change this Phase made to a test an earlier Phase delivered, and the contract behind it. */
  contractBases?: readonly (TicketContractBasis & { ticketName: string })[];
}): string {
  const M = t().deliveryGateReport;
  const lines = [
    `# ${M.title(input.phaseName)}`,
    '',
    `- ${M.evaluatedAt}: ${input.evaluatedAt}`,
    `- ${M.outcome}: ${input.result.ok ? M.passed : M.failed(input.result.errors)}`,
    '',
    `## ${M.checks}`,
    '',
  ];
  for (const check of input.result.checks) {
    lines.push(`### ${check.ok ? '✔' : '✖'} ${check.name}`, '', check.summary, '');
    if (check.scene) {
      lines.push(`- ${M.command}: \`${check.scene.command}\``, `- ${M.exitCode}: ${check.scene.exitCode}${check.scene.timedOut ? ` (${M.timedOut})` : ''}`);
      if (check.scene.stdoutTail) lines.push('', `${M.stdout}:`, '', fence(check.scene.stdoutTail));
      if (check.scene.stderrTail) lines.push('', `${M.stderr}:`, '', fence(check.scene.stderrTail));
      for (const inspection of check.scene.inspections ?? []) {
        lines.push('', `${M.inspection}: \`${inspection.command}\` (${M.exitCode} ${inspection.exitCode})`, '',
          fence(inspection.stdoutTail ?? inspection.stderrTail ?? ''));
      }
      lines.push('');
    }
    if (check.detail) lines.push(fence(check.detail), '');
    if (check.finding) lines.push(`- ${M.finding}: \`${check.finding.code}\` → ${check.finding.target}`, '');
  }
  if (input.contractBases && input.contractBases.length > 0) {
    lines.push(`## ${M.contractBases}`, '', M.contractBasesNote, '');
    for (const basis of input.contractBases) {
      const citation = basis.citation.kind === 'document'
        ? `\`${basis.citation.document}\`@${basis.citation.revision.slice(0, 7)}: "${basis.citation.quote}"`
        : basis.citation.ticketId;
      lines.push(`- \`${basis.path}\` (${basis.ticketName}): ${basis.reason}`, `  - ${citation}`);
    }
    lines.push('');
  }
  if (input.setAside && input.setAside.paths.length > 0) {
    lines.push(`## ${M.setAside}`, '', M.setAsideNote(input.setAside.directory), '',
      ...input.setAside.paths.map((file) => `- \`${file}\``), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}\n${text.trimEnd()}\n${marker}`;
}
