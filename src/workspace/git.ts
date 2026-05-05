import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { Workspace } from './workspace.js';

/**
 * GitService 基于 simple-git 提供 TOAA 运行时所需的最小集：init / snapshot / revert / log。
 * 所有操作都局限在 workspace.root 内，提交带 [toaa] 前缀便于审计。
 */
export class GitService {
  private readonly git: SimpleGit;

  constructor(private readonly ws: Workspace) {
    this.git = simpleGit({ baseDir: ws.root });
  }

  /** 若仓库不存在则 git init + 首次空提交。幂等。 */
  async ensureRepo(): Promise<void> {
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (isRepo) return;
    await this.git.init();
    // 配置最小 user 以便能 commit；仅在缺省时设置
    const local = await this.git.listConfig('local').catch(() => null);
    const has = (k: string) => !!local?.all?.[k];
    if (!has('user.email')) await this.git.addConfig('user.email', 'toaa@local');
    if (!has('user.name')) await this.git.addConfig('user.name', 'TOAA');
    // 创建一个 .gitkeep 让初次 commit 不为空
    await this.ws.writeFile('.toaa/.gitkeep', '');
    await this.git.add(['.']);
    await this.git.commit('[toaa] init workspace');
  }

  /** 在某个 Step 的某次重试前打快照；返回 commit sha。 */
  async snapshot(stepId: string, retry: number, message?: string): Promise<string> {
    await this.ensureRepo();
    await this.git.add(['.']);
    const status = await this.git.status();
    const tag = `[toaa] ${stepId}#${retry}${message ? ` ${message}` : ''}`;
    if (status.files.length === 0) {
      // 没有变化也产生一个空 commit，便于精准 revert
      const r = await this.git.commit(tag, undefined, { '--allow-empty': null });
      return r.commit;
    }
    const r = await this.git.commit(tag);
    return r.commit;
  }

  /** 硬重置到指定 ref；用于 DEBUG 失败回滚。 */
  async revertTo(ref: string): Promise<void> {
    await this.git.reset(['--hard', ref]);
  }

  /** 返回最近 N 条 [toaa] 提交。 */
  async recentToaaCommits(n = 20): Promise<Array<{ sha: string; message: string; date: string }>> {
    const log = await this.git.log({ n });
    return log.all
      .filter((c) => c.message.startsWith('[toaa]'))
      .map((c) => ({ sha: c.hash, message: c.message, date: c.date }));
  }

  /** 暴露底层 git，仅供高级用法。 */
  raw(): SimpleGit {
    return this.git;
  }

  /** 返回相对 workspace 的路径，用于审计。 */
  rel(p: string): string {
    return path.relative(this.ws.root, path.resolve(this.ws.root, p));
  }
}
