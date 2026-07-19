import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { AuditLogger } from '../src/audit/audit.js';
import { getLanguageProfile } from '../src/core/language.js';

describe('TypeScript language profile', () => {
  it('splits known third-party type-only imports before entry probes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-lang-'));
    const ws = new Workspace(tmp);
    const audit = new AuditLogger({ root: tmp, command: 'test' });
    await audit.start({});
    await ws.writeFile(
      'src/fetcher.ts',
      [
        'import axios, { AxiosInstance, AxiosError, isAxiosError } from "axios";',
        '',
        'function createClient(): AxiosInstance {',
        '  return axios.create();',
        '}',
        '',
        'export function isWrappedAxiosError(err: unknown): boolean {',
        '  return err instanceof AxiosError || isAxiosError(err);',
        '}',
        '',
        'export { createClient };',
        '',
      ].join('\n'),
    );

    const fixed = await getLanguageProfile('typescript').autoFixImports?.(ws, audit);

    expect(fixed).toEqual(['src/fetcher.ts']);
    await expect(ws.readFile('src/fetcher.ts')).resolves.toContain(
      'import axios, { AxiosError, isAxiosError } from "axios";\nimport type { AxiosInstance } from "axios";',
    );
  });
});
