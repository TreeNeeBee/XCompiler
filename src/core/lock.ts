import { promises as fs, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 工程级文件锁，防止多个 toaa 进程并发改同一个 workspace。
 * 锁文件：<workspace>/.toaa/.lock，内容为 JSON：{pid, host, command, startedAt}。
 *
 * 语义：
 *   - 优先 O_EXCL 创建，成功即获锁；
 *   - 若已存在但记录的 PID 在本机不存活（`process.kill(pid, 0)` 抛 ESRCH），视为陈旧锁，强制接管；
 *   - 跨主机的锁一律拒绝（无法证伪）。
 */

export interface LockInfo {
  pid: number;
  host: string;
  command: string;
  startedAt: string;
}

export class LockError extends Error {
  constructor(message: string, public readonly info?: LockInfo) {
    super(message);
    this.name = 'LockError';
  }
}

const LOCK_REL = '.toaa/.lock';

function lockPath(workspace: string): string {
  return path.join(workspace, LOCK_REL);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM 表示进程存在但无权限发信号 → 视为存活
    return true;
  }
}

async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

export interface AcquiredLock {
  release(): Promise<void>;
}

export async function acquireLock(
  workspace: string,
  command: string,
  options: { force?: boolean } = {},
): Promise<AcquiredLock> {
  const file = lockPath(workspace);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    host: os.hostname(),
    command,
    startedAt: new Date().toISOString(),
  };
  const payload = JSON.stringify(info, null, 2);

  const tryCreate = async (): Promise<boolean> => {
    try {
      const fh = await fs.open(file, 'wx');
      await fh.writeFile(payload, 'utf8');
      await fh.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (await tryCreate()) {
    return makeReleaser(file);
  }

  if (options.force) {
    // 强制接管：覆写现有锁文件。仅在用户明确传入 --force 时生效。
    await fs.writeFile(file, payload, 'utf8');
    return makeReleaser(file);
  }

  const existing = await readLock(file);
  if (existing) {
    const sameHost = existing.host === info.host;
    if (sameHost && !isAlive(existing.pid)) {
      // 陈旧锁：直接覆写
      await fs.writeFile(file, payload, 'utf8');
      return makeReleaser(file);
    }
    throw new LockError(
      `workspace 已被其它 toaa 进程占用 (pid=${existing.pid}, host=${existing.host}, cmd=${existing.command}, since=${existing.startedAt}).\n` +
        `如确信该进程已退出，请删除 ${file} 后重试。`,
      existing,
    );
  }
  // 文件存在但读不出（损坏） → 接管
  await fs.writeFile(file, payload, 'utf8');
  return makeReleaser(file);
}

function makeReleaser(file: string): AcquiredLock {
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await fs.unlink(file);
    } catch {
      /* ignore */
    }
  };
  // 进程异常退出时也尽力清理（同步删除）
  const sync = () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
  process.once('exit', sync);
  process.once('SIGINT', () => {
    sync();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    sync();
    process.exit(143);
  });
  return { release };
}
