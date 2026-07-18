import { promises as fs } from 'node:fs';
import type { Tool } from './types.js';
import { resolveWorkspacePath } from './path_guard.js';

/**
 * add_dependency：把一组依赖追加到语言对应的依赖清单并重建沙盒。
 *  - Python     → requirements.txt（去重 + 排序）
 *  - TypeScript → package.json.dependencies（去重 + 排序，版本占位为 "*"）
 *
 * 这是受控文件：无需也不应该要求它出现在 Step.outputs 里。
 */
export const addDependencyTool: Tool<
  { packages: string[] },
  { added: string[]; finalLines: string[] }
> = {
  name: 'add_dependency',
  description: '向依赖清单追加依赖（python: requirements.txt；typescript: package.json）并重建沙盒。',
  argsSchema: { packages: 'string[]' },
  async run(args, ctx) {
    if (!args || !Array.isArray(args.packages) || !args.packages.every((p) => typeof p === 'string')) {
      return { ok: false, error: 'invalid add_dependency args: packages must be a non-empty string[]' };
    }
    const normalized = [...new Set(args.packages.map((p) => p.trim()).filter(Boolean))];
    if (normalized.length === 0) {
      return { ok: false, error: 'invalid add_dependency args: packages must include at least one package name' };
    }
    const manifestPath = ctx.language === 'typescript' ? 'package.json' : 'requirements.txt';
    const resolved = await resolveWorkspacePath(ctx.ws, manifestPath, 'add_dependency', { forWrite: true });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const abs = resolved.abs;
    const added: string[] = [];
    let final: string[];

    if (ctx.language === 'typescript') {
      const pkg = await fs
        .readFile(abs, 'utf8')
        .then((text) => JSON.parse(text) as Record<string, unknown>)
        .catch(() => ({} as Record<string, unknown>));
      const existingDeps =
        pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)
          ? { ...(pkg.dependencies as Record<string, string>) }
          : {};
      const before = new Set(Object.keys(existingDeps));
      for (const name of normalized) {
        if (!before.has(name)) added.push(name);
        existingDeps[name] = existingDeps[name] || '*';
      }
      final = Object.keys(existingDeps).sort();
      pkg.dependencies = Object.fromEntries(final.map((name) => [name, existingDeps[name] ?? '*']));
      await fs.writeFile(abs, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    } else {
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
      for (const p of normalized) {
        if (!before.has(p)) added.push(p);
        set.add(p);
      }
      final = [...set].sort();
      await fs.writeFile(abs, final.join('\n') + '\n', 'utf8');
    }
    try {
      await ctx.sandbox.build(manifestPath);
    } catch (err) {
      return {
        ok: false,
        error: `${manifestPath} 已写入，但沙盒重建失败：${(err as Error).message}`,
      };
    }
    return {
      ok: true,
      data: { added, finalLines: final },
      summary: `add_dependency ${manifestPath} +${added.length} (${added.join(', ') || 'none new'})`,
    };
  },
};
