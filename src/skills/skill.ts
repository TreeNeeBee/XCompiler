import type { Tool } from '../tools/types.js';

/**
 * Skill：把一组原子工具组合为面向 LLM 的"高阶能力"。
 *
 * 在 M3 阶段 Skill 是一层"语义包装"——执行器仍然按 step.tools 中的工具名调用具体 Tool，
 * 但 Step 可以声明 `tools: ["skill:patcher"]`，Skill Registry 会展开为底层工具集合，
 * 并把 Skill 的 `prompt` 注入 system prompt，提示 LLM 该如何组合这些工具。
 */
export interface Skill {
  /** 形如 `patcher` / `tester` / `dep_resolver`。 */
  readonly name: string;
  /** 注入到 system prompt 的简短指引（中文一句话）。 */
  readonly prompt: string;
  /** 该 Skill 暴露给 LLM 的底层工具名集合。 */
  readonly tools: string[];
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(s: Skill): void {
    this.skills.set(s.name, s);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * 把 `step.tools` 中的 `skill:xxx` 项展开为底层工具名（去重，保持顺序）。
   * 非 skill 项原样保留，便于与裸工具混用。
   * 返回 { resolvedToolNames, hints }。
   */
  resolve(toolRefs: string[]): { resolvedToolNames: string[]; hints: string[] } {
    const out: string[] = [];
    const hints: string[] = [];
    const seen = new Set<string>();
    for (const ref of toolRefs) {
      if (ref.startsWith('skill:')) {
        const sk = this.skills.get(ref.slice('skill:'.length));
        if (!sk) continue;
        hints.push(`[${sk.name}] ${sk.prompt}`);
        for (const t of sk.tools) if (!seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      } else {
        if (!seen.has(ref)) {
          seen.add(ref);
          out.push(ref);
        }
      }
    }
    return { resolvedToolNames: out, hints };
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }
}

/** 默认 Skill 集合，参考 implementation_plan §M3.1。 */
export function buildDefaultSkills(): SkillRegistry {
  const reg = new SkillRegistry();
  reg.register({
    name: 'patcher',
    prompt: '通过 apply_patch / replace_in_file 对已有文件做小改动，禁止整文件覆盖。',
    tools: ['read_file', 'code_search', 'apply_patch', 'replace_in_file'],
  });
  reg.register({
    name: 'author',
    prompt: '通过 write_file 创建新文件；优先放在 outputs 白名单内。',
    tools: ['read_file', 'list_dir', 'write_file'],
  });
  reg.register({
    name: 'tester',
    prompt:
      '编写并运行 pytest 测试，验证函数行为；失败时通过 analyze_error 解析。' +
      '【fixture 自包含】测试**严禁**直接 open() 磁盘上不存在的样例文件（如 "test.dbc"）；' +
      '若被测函数需要文件输入，请用 pytest 的 tmp_path fixture 在测试里临时构造内容，' +
      '或用 write_file 直接写到 tests/fixtures/<name>——TEST/DEBUG 阶段该目录已默认放开写权限，' +
      '子目录自动 mkdir -p，**无需**提前把 fixture 路径登记到 outputs。' +
      '生成测试时务必同时输出全部依赖资源，避免后续 Debugger 因 FileNotFoundError 反复重试。' +
      '【fixture 迭代】若测试运行中被测函数报"Invalid syntax / Parse error / Malformed"等解析错误，' +
      '说明你写出的 fixture 内容不合该格式 spec：read_file 看清，write_file 整文件重写为合法样例，再 run_tests，' +
      '严禁去改被测模块或断言。',
    tools: ['read_file', 'list_dir', 'write_file', 'run_tests', 'analyze_error'],
  });
  reg.register({
    name: 'dep_resolver',
    prompt: '当出现 ModuleNotFoundError 时，用 add_dependency 写回 requirements.txt 并重建沙盒。',
    tools: ['analyze_error', 'add_dependency', 'pip_install'],
  });
  reg.register({
    name: 'debugger',
    prompt:
      '先 run_tests / run_python 复现错误 → analyze_error → patch/replace_in_file 修复 → 再次 run_tests。每次只做最小修改。【重要】同一文件上 replace_in_file 连续失败 2 次以上请立即改用 read_file + write_file 整文件重写（≤ 6000 字节可直接覆盖），不要反复猜测 find 字符串。【禁止 no-op】replace_in_file 的 find 与 replace 必须不同——若你只是想"确认"某段代码，请用 read_file，不要提交相同字符串的替换。',
    tools: [
      'read_file',
      'code_search',
      'run_tests',
      'run_python',
      'analyze_error',
      'apply_patch',
      'replace_in_file',
      'write_file',
      'add_dependency',
    ],
  });
  reg.register({
    name: 'refactorer',
    prompt: '重构必须保证行为不变；先跑回归测试 → 修改 → 再跑回归测试。',
    tools: ['read_file', 'code_search', 'apply_patch', 'replace_in_file', 'run_tests'],
  });
  return reg;
}

/** 便利函数：把 skill / tool refs 解析为可注入 prompt 的提示串。 */
export function renderSkillHints(hints: string[]): string {
  if (hints.length === 0) return '';
  return ['## skill hints', ...hints.map((h) => `- ${h}`)].join('\n');
}

/** 把工具元信息渲染为 prompt 段。 */
export function renderToolDocs(tools: Tool[]): string {
  return tools
    .map((t) => `- ${t.name}: ${t.description} args=${JSON.stringify(t.argsSchema)}`)
    .join('\n');
}
