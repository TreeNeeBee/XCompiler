import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { archiveIfExists } from '../src/workspace/doc_archive.js';

let tmp: string;
let ws: Workspace;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-archive-'));
  ws = new Workspace(tmp);
});

describe('archiveIfExists', () => {
  it('moves existing docs/* file into docs/history with a timestamp', async () => {
    await ws.writeFile('docs/plan.md', 'v1');
    const archived = await archiveIfExists(ws, 'docs/plan.md');
    expect(archived).toMatch(/^docs\/history\/plan-\d{8}-\d{6}\.md$/);
    expect(await ws.exists('docs/plan.md')).toBe(false);
    expect(await ws.exists(archived!)).toBe(true);
    expect(await ws.readFile(archived!)).toBe('v1');
  });

  it('returns null when target does not exist', async () => {
    expect(await archiveIfExists(ws, 'docs/plan.md')).toBeNull();
  });

  it('skips files outside docs/', async () => {
    await ws.writeFile('plan.json', '{}');
    expect(await archiveIfExists(ws, 'plan.json')).toBeNull();
    expect(await ws.exists('plan.json')).toBe(true);
  });

  it('skips files already inside docs/history/', async () => {
    await ws.writeFile('docs/history/plan-20250101-000000.md', 'old');
    expect(await archiveIfExists(ws, 'docs/history/plan-20250101-000000.md')).toBeNull();
  });
});
