import type { Plan } from './plan.js';
import { t } from '../i18n/index.js';

export function renderPlanMarkdown(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`# Plan (language: ${plan.language})`);
  lines.push('');
  lines.push(`- Created: ${plan.createdAt}`);
  lines.push(`- Steps: ${plan.steps.length}`);
  lines.push('');
  lines.push('## Requirement digest');
  lines.push('');
  lines.push(plan.requirementDigest);
  lines.push('');
  if (plan.globalPrompt && plan.globalPrompt.trim()) {
    lines.push(t().render.sectionGlobalPrompt);
    lines.push('');
    lines.push('```text');
    lines.push(plan.globalPrompt.trim());
    lines.push('```');
    lines.push('');
  }
  if (plan.pythonRequirements && plan.pythonRequirements.length > 0) {
    lines.push(t().render.sectionPythonRequirements);
    lines.push('');
    for (const r of plan.pythonRequirements) lines.push(`- ${r}`);
    lines.push('');
  }
  lines.push('## Steps');
  lines.push('');
  lines.push('| ID | Phase | Role | Title | Outputs | Depends |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const s of plan.steps) {
    lines.push(
      `| ${s.id} | ${s.phase} | ${s.role} | ${escapePipe(s.title)} | ${s.outputs.join(', ')} | ${
        s.dependsOn.join(', ') || '—'
      } |`,
    );
  }
  lines.push('');
  lines.push('## Detail');
  lines.push('');
  for (const s of plan.steps) {
    lines.push(`### ${s.id} — ${s.title} (${s.phase} / ${s.role})`);
    lines.push('');
    lines.push(s.description);
    lines.push('');
    lines.push(`- Inputs: ${s.inputs.join(', ') || '—'}`);
    lines.push(`- Outputs: ${s.outputs.join(', ')}`);
    lines.push(`- Tools: ${s.tools.join(', ') || '—'}`);
    lines.push(`- Acceptance: ${s.acceptance}`);
    lines.push('');
    lines.push(t().render.labelSystemPrompt);
    lines.push('');
    lines.push('```text');
    lines.push(s.systemPrompt.trim());
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, '\\|');
}
