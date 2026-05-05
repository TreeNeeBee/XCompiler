import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { writeFileTool, readFileTool } from '../src/tools/fs.js';
import { EditGuard } from '../src/tools/guard.js';
import type { ToolContext } from '../src/tools/types.js';
import { SkillRegistry, buildDefaultSkills } from '../src/skills/skill.js';

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'toaa-guard-'));
  ws = new Workspace(tmp);
  ctx = {
    ws,
    sandbox: undefined as never,
    allowedWrites: ['src/'],
    stepId: 'S010',
  };
});

describe('EditGuard', () => {
  it('passes through non-write tools unchanged', async () => {
    const g = new EditGuard({ ws, stepId: 'S010', maxLines: 10 });
    const wrapped = g.wrap(readFileTool);
    expect(wrapped).toBe(readFileTool);
  });

  it('writes edits-*.jsonl audit and counts lines', async () => {
    const g = new EditGuard({ ws, stepId: 'S010', maxLines: 100 });
    const wrapped = g.wrap(writeFileTool);
    const r = await wrapped.run({ path: 'src/a.py', content: 'a\nb\nc\n' }, ctx);
    expect(r.ok).toBe(true);
    expect(g.totalLines).toBeGreaterThan(0);
    const log = await ws.readFile(`logs/edits-S010.jsonl`);
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].tool).toBe('write_file');
    expect(lines[0].ok).toBe(true);
  });

  it('rejects write once line cap exceeded', async () => {
    const g = new EditGuard({ ws, stepId: 'S010', maxLines: 3 });
    const wrapped = g.wrap(writeFileTool);
    const big = 'x\n'.repeat(10);
    const r1 = await wrapped.run({ path: 'src/a.py', content: big }, ctx);
    expect(r1.ok).toBe(true);
    const r2 = await wrapped.run({ path: 'src/b.py', content: 'y\n' }, ctx);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/max .* lines per step exceeded/);
  });
});

describe('SkillRegistry', () => {
  it('expands skill: refs to underlying tools and collects hints', () => {
    const reg = buildDefaultSkills();
    const { resolvedToolNames, hints } = reg.resolve(['skill:patcher', 'run_tests']);
    expect(resolvedToolNames).toContain('apply_patch');
    expect(resolvedToolNames).toContain('replace_in_file');
    expect(resolvedToolNames).toContain('run_tests');
    expect(hints[0]).toMatch(/patcher/);
  });

  it('ignores unknown skill but keeps bare tools', () => {
    const reg = new SkillRegistry();
    const { resolvedToolNames } = reg.resolve(['skill:nope', 'read_file']);
    expect(resolvedToolNames).toEqual(['read_file']);
  });
});
