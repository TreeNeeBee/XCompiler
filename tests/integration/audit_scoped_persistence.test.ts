import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger, type AuditEvent } from '../../src/audit/audit.js';

let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-scoped-audit-'))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const logicalRequestId = 'abababab-abab-4bab-8bab-abababababab';
const messageId = 'test.scoped_input';
const oldJsonl = '{"preserved":"prior JSONL evidence"}\n';
const oldMarkdown = '# Prior Markdown evidence\n';

async function fixture(name = 'project', mdRelPath?: string, jsonlRelPath?: string) {
  const containerRoot = path.join(root, name);
  const stateRoot = path.join(containerRoot, '.xcompiler');
  const auditRoot = path.join(stateRoot, 'audit');
  await fs.mkdir(containerRoot);
  return {
    containerRoot, auditRoot, location: { containerRoot, auditRoot },
    jsonl: path.join(auditRoot, 'audit.jsonl'),
    markdown: path.resolve(stateRoot, mdRelPath ?? 'audit/process_log.md'),
    logger: new AuditLogger({ root: containerRoot, stateRoot, command: 'scoped-audit-fixture',
      mdRelPath, jsonlRelPath, contentMode: 'redacted' }),
  };
}

function write(logger: AuditLogger, location: { containerRoot: string; auditRoot: string }) {
  return logger.event('llm.request', 'Retain current business evidence', {
    messageId, logicalRequestId, evidence: 'Current evidence: count=2; token=fixture-private-value',
  }, { persistence: 'required', location });
}

function persistenceFailure(target: string) {
  return {
    code: 'evidence_persistence_failed',
    failure: { operation: 'initialize', target, eventKind: 'llm.request', messageId, logicalRequestId },
    cause: expect.any(Error),
  };
}

describe('required audit events confined to their declared project container', () => {
  it.each([undefined, 'audit/details/custom.md'])(
    'writes protected evidence to both logs with Markdown path %s', async (mdRelPath) => {
      const current = await fixture('project', mdRelPath);
      await write(current.logger, current.location);
      const jsonl = await fs.readFile(current.jsonl, 'utf8');
      const events = jsonl.trim().split('\n').map((line) => JSON.parse(line) as AuditEvent);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'llm.request', messageId,
        data: { logicalRequestId, evidence: 'Current evidence: count=2; token=[REDACTED]' } });
      const markdown = await fs.readFile(current.markdown, 'utf8');
      expect(markdown).toContain('Current evidence: count=2; token=[REDACTED]');
      expect(jsonl).not.toContain('fixture-private-value');
      expect(markdown).not.toContain('fixture-private-value');
      await write(current.logger, current.location);
      expect((await fs.readFile(current.jsonl, 'utf8')).trim().split('\n')).toHaveLength(2);
      expect((await fs.readFile(current.markdown, 'utf8')).startsWith(markdown)).toBe(true);
    },
  );

  it('retains every record exactly once in both logs during concurrent first writes', async () => {
    const current = await fixture();
    const recordIds = Array.from({ length: 12 }, () => randomUUID());
    await Promise.all(recordIds.map((inputRecordId) => current.logger.event('llm.request', 'Concurrent input evidence', {
      messageId, logicalRequestId, inputRecordId,
    }, { persistence: 'required', location: current.location })));
    const events = (await fs.readFile(current.jsonl, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as AuditEvent);
    expect(events).toHaveLength(recordIds.length);
    const markdown = await fs.readFile(current.markdown, 'utf8');
    const markdownRecords = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/gu)]
      .map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
    expect(markdownRecords).toHaveLength(recordIds.length);
    for (const recordId of recordIds) {
      expect(events.filter((event) => event.data?.inputRecordId === recordId)).toHaveLength(1);
      expect(markdownRecords.filter((record) => record.inputRecordId === recordId)).toHaveLength(1);
    }
  });

  it.each([undefined, 'audit/details/custom.md'])(
    'rejects a linked Markdown target %s before appending any JSONL', async (mdRelPath) => {
      const current = await fixture('project', mdRelPath);
      const external = path.join(root, 'external.md');
      await fs.writeFile(external, oldMarkdown);
      await fs.mkdir(path.dirname(current.markdown), { recursive: true });
      await fs.writeFile(current.jsonl, oldJsonl);
      await fs.symlink(external, current.markdown);
      await expect(write(current.logger, current.location)).rejects.toMatchObject(persistenceFailure(current.markdown));
      expect(await fs.readFile(external, 'utf8')).toBe(oldMarkdown);
      expect(await fs.readFile(current.jsonl, 'utf8')).toBe(oldJsonl);
      expect((await fs.lstat(current.markdown)).isSymbolicLink()).toBe(true);
    },
  );

  it('rejects a linked JSONL target without modifying either log or the external file', async () => {
    const current = await fixture();
    const external = path.join(root, 'external.jsonl');
    await fs.writeFile(external, oldJsonl);
    await fs.mkdir(current.auditRoot, { recursive: true });
    await fs.writeFile(current.markdown, oldMarkdown);
    await fs.symlink(external, current.jsonl);
    await expect(write(current.logger, current.location)).rejects.toMatchObject(persistenceFailure(current.jsonl));
    expect(await fs.readFile(external, 'utf8')).toBe(oldJsonl);
    expect(await fs.readFile(current.markdown, 'utf8')).toBe(oldMarkdown);
  });

  it('rejects an audit directory symlink without writing into its external referent', async () => {
    const current = await fixture();
    const external = path.join(root, 'external-audit');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'audit.jsonl'), oldJsonl);
    await fs.writeFile(path.join(external, 'process_log.md'), oldMarkdown);
    await fs.mkdir(path.dirname(current.auditRoot), { recursive: true });
    await fs.symlink(external, current.auditRoot);
    await expect(write(current.logger, current.location)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', cause: expect.any(Error),
      failure: { operation: 'initialize', target: current.jsonl, eventKind: 'llm.request', messageId, logicalRequestId },
    });
    expect(await fs.readFile(path.join(external, 'audit.jsonl'), 'utf8')).toBe(oldJsonl);
    expect(await fs.readFile(path.join(external, 'process_log.md'), 'utf8')).toBe(oldMarkdown);
    expect((await fs.readdir(external)).sort()).toEqual(['audit.jsonl', 'process_log.md']);
  });

  it('rejects a linked custom Markdown ancestor before writing either log', async () => {
    const current = await fixture('project', 'audit/details/custom.md');
    const external = path.join(root, 'external-details');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'custom.md'), oldMarkdown);
    await fs.mkdir(current.auditRoot, { recursive: true });
    await fs.writeFile(current.jsonl, oldJsonl);
    await fs.symlink(external, path.dirname(current.markdown));
    await expect(write(current.logger, current.location)).rejects.toMatchObject({
      code: 'evidence_persistence_failed', cause: expect.any(Error),
      failure: { operation: 'initialize', target: current.markdown, eventKind: 'llm.request', messageId, logicalRequestId },
    });
    expect(await fs.readFile(current.jsonl, 'utf8')).toBe(oldJsonl);
    expect(await fs.readFile(path.join(external, 'custom.md'), 'utf8')).toBe(oldMarkdown);
  });

  it('rejects a logger owned by another project before changing either project logs', async () => {
    const declared = await fixture('declared-project');
    const other = await fixture('other-project');
    for (const current of [declared, other]) {
      await fs.mkdir(current.auditRoot, { recursive: true });
      await fs.writeFile(current.jsonl, oldJsonl);
      await fs.writeFile(current.markdown, oldMarkdown);
    }
    await expect(write(other.logger, declared.location)).rejects.toMatchObject(persistenceFailure(other.jsonl));
    for (const current of [declared, other]) {
      expect(await fs.readFile(current.jsonl, 'utf8')).toBe(oldJsonl);
      expect(await fs.readFile(current.markdown, 'utf8')).toBe(oldMarkdown);
    }
  });

  it('rejects a differently configured JSONL filename before creating log files', async () => {
    const current = await fixture('project', undefined, 'audit/alternate.jsonl');
    await expect(write(current.logger, current.location)).rejects.toMatchObject(
      persistenceFailure(path.join(current.auditRoot, 'alternate.jsonl')),
    );
    expect(await fs.readdir(current.containerRoot)).toEqual([]);
  });

  it('rejects Markdown configured outside the declared audit root before writing JSONL', async () => {
    const current = await fixture('project', '../../external.md');
    await fs.writeFile(current.markdown, oldMarkdown);
    await fs.mkdir(current.auditRoot, { recursive: true });
    await fs.writeFile(current.jsonl, oldJsonl);
    await expect(write(current.logger, current.location)).rejects.toMatchObject(persistenceFailure(current.markdown));
    expect(await fs.readFile(current.jsonl, 'utf8')).toBe(oldJsonl);
    expect(await fs.readFile(current.markdown, 'utf8')).toBe(oldMarkdown);
  });
});
