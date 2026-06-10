import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import { DOC_NAMES } from './docs.js';
import { PlanSchema, type PlanIntent } from './plan.js';

export interface IncrementalBaseline {
  summary: string;
  sources: string[];
}

/**
 * 增量开发基线汇总：把现有 workspace 中的 topic / 计划 / 关键文档 / 代码树
 * 收敛成一段可直接拼进 Planner prompt 的文本，供 feature/refactor 计划使用。
 */
export async function loadIncrementalBaseline(
  ws: Workspace,
  opts: { planPath?: string; maxChars?: number } = {},
): Promise<IncrementalBaseline> {
  const sections: string[] = [];
  const sources: string[] = [];
  const maxChars = opts.maxChars ?? 14_000;

  const relPlan = relInsideWorkspace(ws.root, opts.planPath);
  const planSource = opts.planPath ? path.resolve(opts.planPath) : path.join(ws.root, 'plan.json');
  const planLabel = relPlan ?? path.relative(ws.root, planSource).replace(/\\/g, '/');
  const plan = await loadPlanSummary(ws, planSource, planLabel || 'plan.json');
  if (plan) {
    sections.push(plan);
    sources.push(planLabel || 'plan.json');
  }

  for (const rel of [
    DOC_NAMES.topic,
    DOC_NAMES.requirement,
    DOC_NAMES.architecture,
    DOC_NAMES.tasks,
    DOC_NAMES.refactor,
    DOC_NAMES.delivery,
  ]) {
    const text = await readWorkspaceFile(ws, rel, 2200);
    if (!text) continue;
    sections.push(`## Existing document: ${rel}\n${text}`);
    sources.push(rel);
  }

  const manifestSummary = await loadManifestSummary(ws);
  if (manifestSummary) {
    sections.push(manifestSummary.text);
    sources.push(...manifestSummary.sources);
  }

  const tree = await listProjectFiles(ws.root);
  if (tree.length > 0) {
    sections.push(`## Current source/test tree\n${tree.map((p) => `- ${p}`).join('\n')}`);
    sources.push('src/**', 'tests/**');
  }

  const summary = joinCappedSections(sections, maxChars);
  return { summary, sources: dedup(sources) };
}

function joinCappedSections(sections: string[], maxChars: number): string {
  let out = '';
  for (const sec of sections) {
    const next = out ? `${out}\n\n${sec}` : sec;
    if (next.length <= maxChars) {
      out = next;
      continue;
    }
    const remain = maxChars - out.length - (out ? 2 : 0);
    if (remain > 64) {
      out = out ? `${out}\n\n${sec.slice(0, remain)}\n... [truncated]` : `${sec.slice(0, remain)}\n... [truncated]`;
    }
    break;
  }
  return out.trim();
}

async function loadPlanSummary(ws: Workspace, planPath: string, label: string): Promise<string> {
  try {
    const raw = await fs.readFile(planPath, 'utf8');
    const parsed = PlanSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return `## Existing plan summary\n- path: ${label}\n- status: unreadable by current schema`;
    const plan = parsed.data;
    return [
      '## Existing plan summary',
      `- path: ${label}`,
      `- language: ${plan.language}`,
      `- intent: ${plan.intent}`,
      `- steps: ${plan.steps.length}`,
      `- requirementDigest: ${plan.requirementDigest}`,
      `- generatedAt: ${plan.createdAt}`,
    ].join('\n');
  } catch {
    return '';
  }
}

async function loadManifestSummary(
  ws: Workspace,
): Promise<{ text: string; sources: string[] } | null> {
  if (await ws.exists('package.json')) {
    try {
      const pkg = JSON.parse(await ws.readFile('package.json')) as Record<string, unknown>;
      const scripts =
        pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
          ? Object.entries(pkg.scripts as Record<string, string>)
              .slice(0, 8)
              .map(([k, v]) => `  - ${k}: ${v}`)
          : [];
      const deps = [
        ...Object.keys((pkg.dependencies as Record<string, unknown>) ?? {}),
        ...Object.keys((pkg.devDependencies as Record<string, unknown>) ?? {}).map((d) => `${d} (dev)`),
      ].slice(0, 24);
      return {
        text: [
          '## Existing manifest: package.json',
          `- name: ${String(pkg.name ?? '(unknown)')}`,
          `- type: ${String(pkg.type ?? '(unset)')}`,
          deps.length > 0 ? `- dependencies: ${deps.join(', ')}` : '- dependencies: (none)',
          scripts.length > 0 ? '- scripts:' : '- scripts: (none)',
          ...scripts,
        ].join('\n'),
        sources: ['package.json'],
      };
    } catch {
      /* ignore */
    }
  }
  if (await ws.exists('requirements.txt')) {
    const text = await readWorkspaceFile(ws, 'requirements.txt', 1200);
    if (text) {
      return {
        text: `## Existing manifest: requirements.txt\n${text}`,
        sources: ['requirements.txt'],
      };
    }
  }
  return null;
}

async function readWorkspaceFile(ws: Workspace, rel: string, maxChars: number): Promise<string> {
  try {
    const text = await ws.readFile(rel);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n... [truncated]` : text;
  } catch {
    return '';
  }
}

async function listProjectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const base of ['src', 'tests']) {
    const abs = path.join(root, base);
    await walk(abs, base, out, 0);
  }
  return out.slice(0, 120);
}

async function walk(abs: string, rel: string, out: string[], depth: number): Promise<void> {
  if (depth > 6 || out.length >= 120) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= 120) break;
    if (entry.name.startsWith('.')) continue;
    const childRel = `${rel}/${entry.name}`;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      await walk(childAbs, childRel, out, depth + 1);
    } else {
      out.push(childRel);
    }
  }
}

function relInsideWorkspace(root: string, maybeAbs?: string): string | null {
  if (!maybeAbs) return null;
  const full = path.resolve(maybeAbs);
  const rel = path.relative(root, full).replace(/\\/g, '/');
  return rel.startsWith('..') ? null : rel || path.basename(full);
}

function dedup(values: string[]): string[] {
  return [...new Set(values)];
}

export function isIncrementalIntent(intent: PlanIntent): boolean {
  return intent !== 'greenfield';
}
