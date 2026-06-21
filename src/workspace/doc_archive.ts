import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './workspace.js';
import type { AuditLogger } from '../audit/audit.js';
import { t } from '../i18n/index.js';

/**
 * 文档历史归档：写入阶段产物前，把上一版本平移到 docs/history/ 下，
 * 文件名形如 `<base>-<YYYYMMDD-HHMMSS>.<ext>`。
 *
 * - 仅当目标文件已存在时归档；
 * - 仅在产物落在 `docs/` 子树时归档（其它位置不动）；
 * - 失败仅记录审计，不抛错（避免阻断主流程）。
 *
 * @returns 归档后的相对路径，若未归档返回 null
 */
export async function archiveIfExists(
  ws: Workspace,
  rel: string,
  audit?: AuditLogger,
): Promise<string | null> {
  const norm = rel.replaceAll('\\', '/');
  if (!norm.startsWith('docs/')) return null;
  if (norm.startsWith('docs/history/')) return null;
  if (!(await ws.exists(norm))) return null;

  const ext = path.extname(norm);
  const base = path.basename(norm, ext);
  const ts = formatStamp(new Date());
  const target = `docs/history/${base}-${ts}${ext}`;
  try {
    await ws.ensure('docs/history');
    await fs.rename(ws.abs(norm), ws.abs(target));
    await audit?.event('plan.persist', t().audit.documentArchived(norm, target), {
      messageId: 'audit.document_archived',
      from: norm,
      to: target,
    });
    return target;
  } catch (err) {
    const message = (err as Error).message;
    await audit?.event('plan.persist', t().audit.documentArchiveFailed(norm, message), {
      messageId: 'audit.document_archive_failed',
      from: norm,
      error: message,
    });
    return null;
  }
}

function formatStamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}
