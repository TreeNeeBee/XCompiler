import { promises as fs } from 'node:fs';
import type { Tool } from './types.js';

/**
 * add_dependency：把一组 pip 依赖追加到 workspace/requirements.txt（去重 + 排序），
 * 然后请求 sandbox.build('requirements.txt') 重建虚拟环境。
 *
 * 注意：requirements.txt 必须在该 Step 的 outputs 白名单内（一般用于 ARCH/DEBUG/TASK Step）。
 */
export const addDependencyTool: Tool<
  { packages: string[] },
  { added: string[]; finalLines: string[] }
> = {
  name: 'add_dependency',
  description: '向 requirements.txt 追加依赖（去重）并重建沙盒。',
  argsSchema: { packages: 'string[]' },
  async run(args, ctx) {
    const reqPath = 'requirements.txt';
    if (!ctx.allowedWrites.includes(reqPath)) {
      return { ok: false, error: 'requirements.txt not in step outputs whitelist' };
    }
    const abs = ctx.ws.abs(reqPath);
    let existing = '';
    try {
      existing = await fs.readFile(abs, 'utf8');
    } catch {
      /* new file */
    }
    const set = new Set<string>();
    for (const line of existing.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) set.add(t);
    }
    const before = new Set(set);
    const added: string[] = [];
    for (const p of args.packages) {
      const t = p.trim();
      if (!t) continue;
      if (!before.has(t)) added.push(t);
      set.add(t);
    }
    const final = [...set].sort();
    await fs.writeFile(abs, final.join('\n') + '\n', 'utf8');
    try {
      await ctx.sandbox.build(reqPath);
    } catch (err) {
      return {
        ok: false,
        error: `requirements.txt 已写入，但沙盒重建失败：${(err as Error).message}`,
      };
    }
    return {
      ok: true,
      data: { added, finalLines: final },
      summary: `add_dependency +${added.length} (${added.join(', ') || 'none new'})`,
    };
  },
};
