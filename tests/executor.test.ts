import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace/workspace.js';
import { StepExecutor } from '../src/agents/executor.js';
import type { ChatMessage, ChatOptions, LLMClient } from '../src/llm/types.js';
import type { Step } from '../src/core/plan.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { readFileTool, writeFileTool } from '../src/tools/fs.js';

class CapturingLLM implements LLMClient {
  readonly name = 'cap';
  public lastSystem = '';
  public lastUser = '';
  async chat(messages: ChatMessage[], _o?: ChatOptions): Promise<string> {
    const sys = messages.find((m) => m.role === 'system');
    const users = messages.filter((m) => m.role === 'user');
    const user = users[users.length - 1];
    this.lastSystem = sys?.content ?? '';
    this.lastUser = user?.content ?? '';
    return JSON.stringify({
      thoughts: 'create file',
      actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }],
      done: true,
    });
  }
}

let tmp: string;
let ws: Workspace;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xcompiler-exec-'));
  ws = new Workspace(tmp);
  ctx = { ws, sandbox: undefined as never, allowedWrites: ['src/'], stepId: 'S010' };
});

const baseStep: Step = {
  id: 'S010',
  iterationId: 'P1',
  phase: 'CODE',
  title: 't',
  description: 'd',
  systemPrompt: '本 Step 专属：仅生成 src/x.py，禁止触碰其它文件。',
  role: 'Coder',
  tools: ['write_file'],
  inputs: [],
  outputs: ['src/x.py'],
  dependsOn: [],
  acceptance: 'src/x.py exists',
  status: 'PENDING',
  retries: 0,
  maxRetries: 3,
};

describe('StepExecutor system prompt assembly', () => {
  it('injects globalPrompt + step.systemPrompt into system message', async () => {
    const llm = new CapturingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({
      step: baseStep,
      tools: [writeFileTool],
      ctx,
      globalPrompt: '项目背景：CLI 工具，全局禁止网络访问。',
    });
    expect(r.success).toBe(true);
    expect(llm.lastSystem).toContain('## Project-wide constraints');
    expect(llm.lastSystem).toContain('CLI 工具');
    expect(llm.lastSystem).toContain('## Current Step prompt');
    expect(llm.lastSystem).toContain('禁止触碰其它文件');
  });

  it('records executor.turn audit events with thoughts + actions', async () => {
    const { AuditLogger } = await import('../src/audit/audit.js');
    const audit = new AuditLogger({ root: tmp, command: 'test' });
    await audit.start({});
    const llm = new CapturingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const ctxWithAudit = { ...ctx, audit };
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx: ctxWithAudit });
    expect(r.success).toBe(true);
    const jsonl = await fs.readFile(path.join(tmp, '.xcompiler/audit.jsonl'), 'utf8');
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
    const turns = lines.filter((l) => l.kind === 'executor.turn');
    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].data.thoughts).toBe('create file');
    expect(turns[0].data.actions[0].tool).toBe('write_file');
    expect(turns[0].data.done).toBe(true);
  });

  it('uses the runtime execution role in prompts and audit events', async () => {
    const { AuditLogger } = await import('../src/audit/audit.js');
    const audit = new AuditLogger({ root: tmp, command: 'test' });
    await audit.start({});
    const llm = new CapturingLLM();
    const exec = new StepExecutor({ llm, maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      executionRole: 'Debugger',
      tools: [writeFileTool],
      ctx: { ...ctx, audit },
    });
    expect(r.success).toBe(true);
    expect(llm.lastUser).toContain('role: Debugger');
    expect(llm.lastUser).not.toContain('role: Coder');

    const jsonl = await fs.readFile(path.join(tmp, '.xcompiler/audit.jsonl'), 'utf8');
    const turns = jsonl.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.kind === 'executor.turn');
    expect(turns[0].data.role).toBe('Debugger');
  });

  it('parses LLM output that contains multiple back-to-back ```json blocks (uses first)', async () => {
    class MultiBlockLLM implements LLMClient {
      readonly name = 'multi';
      async chat(): Promise<string> {
        return [
          '```json',
          JSON.stringify({
            thoughts: 'first block: write file',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } }],
            done: false,
          }),
          '```',
          '',
          '```json',
          JSON.stringify({ thoughts: 'second block', actions: [], done: true }),
          '```',
        ].join('\n');
      }
    }
    const exec = new StepExecutor({ llm: new MultiBlockLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    // 第一轮就应该执行到 write_file，并产出 src/x.py。
    // 由于 done=false，executor 会到 maxRounds 才停；但 toolCalls 必须包含 write_file，
    // 文件也必须真的写出来——这正是修复前 actions=[] 时不会发生的事。
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && c.ok)).toBeTruthy();
    const written = await fs.readFile(path.join(tmp, 'src/x.py'), 'utf8');
    expect(written).toBe('x = 1\n');
  });

  it('repairs common trailing-comma JSON mistakes so actions still run', async () => {
    class TrailingCommaLLM implements LLMClient {
      readonly name = 'trailing-comma';
      async chat(): Promise<string> {
        return `{
  "thoughts": "create file",
  "actions": [
    { "tool": "write_file", "args": { "path": "src/x.py", "content": "x = 1\\n" } },
  ],
  "done": true
}`;
      }
    }
    const exec = new StepExecutor({ llm: new TrailingCommaLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && c.ok)).toBeTruthy();
    const written = await fs.readFile(path.join(tmp, 'src/x.py'), 'utf8');
    expect(written).toBe('x = 1\n');
  });

  it('repairs malformed code-string JSON with raw newlines and unescaped inner quotes', async () => {
    class BrokenCodeJsonLLM implements LLMClient {
      readonly name = 'broken-code-json';
      async chat(): Promise<string> {
        return `{
  "thoughts": "create file",
  "actions": [
    { "tool": "write_file", "args": { "path": "src/x.py", "content": "def run():
    print("x")
    return None
" } }
  ],
  "done": true
}`;
      }
    }
    const exec = new StepExecutor({ llm: new BrokenCodeJsonLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && c.ok)).toBeTruthy();
    const written = await fs.readFile(path.join(tmp, 'src/x.py'), 'utf8');
    expect(written).toBe('def run():\n    print("x")\n    return None\n');
  });

  it('ignores malformed action entries without crashing history compaction', async () => {
    const { AuditLogger } = await import('../src/audit/audit.js');
    const audit = new AuditLogger({ root: tmp, command: 'test' });
    await audit.start({});
    class MalformedActionLLM implements LLMClient {
      readonly name = 'malformed-action';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'write file and accidentally put done in actions',
          actions: [
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
            { done: true },
          ],
          done: true,
        });
      }
    }

    const exec = new StepExecutor({ llm: new MalformedActionLLM(), maxRounds: 2 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx: { ...ctx, audit } });

    expect(r.success).toBe(true);
    expect(await ws.exists('src/x.py')).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'invalid_action' && !c.ok)?.error).toContain('missing string tool');
    const jsonl = await fs.readFile(path.join(tmp, '.xcompiler/audit.jsonl'), 'utf8');
    expect(jsonl).toContain('audit.executor_invalid_actions_ignored');
  });

  it('does not accept done=true while tool failures remain unresolved', async () => {
    class FailedToolLLM implements LLMClient {
      readonly name = 'failed-tool';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'write required output but also attempted a denied file',
          actions: [
            { tool: 'write_file', args: { path: 'outside/x.py', content: 'bad = True\n' } },
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
          ],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new FailedToolLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(false);
    expect(r.error).toContain('unresolved tool failures remain');
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && !c.ok)?.error).toContain('write denied');
    await expect(fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).resolves.toBe('x = 1\n');
  });

  it('allows completion when a pathless write_file arg failure is repaired by a later valid write_file', async () => {
    class MissingPathThenValidWriteLLM implements LLMClient {
      readonly name = 'missing-path-then-valid-write';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'first malformed write is followed by the real required output',
          actions: [
            { tool: 'write_file', args: { content: '# missing path\n' } },
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
          ],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new MissingPathThenValidWriteLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'write_file' && !c.ok)?.error).toContain('path must be a non-empty string');
    await expect(fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).resolves.toBe('x = 1\n');
  });

  it('allows completion after an unauthorized read-only probe once outputs are written', async () => {
    class ReadProbeThenWriteLLM implements LLMClient {
      readonly name = 'read-probe-then-write';
      async chat(): Promise<string> {
        return JSON.stringify({
          thoughts: 'try reading, then write required output',
          actions: [
            { tool: 'read_file', args: { path: 'src/x.py' } },
            { tool: 'write_file', args: { path: 'src/x.py', content: 'x = 1\n' } },
          ],
          done: true,
        });
      }
    }
    const exec = new StepExecutor({ llm: new ReadProbeThenWriteLLM(), maxRounds: 1 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(r.toolCalls.find((c) => c.tool === 'read_file' && !c.ok)?.error).toContain('tool not allowed');
    await expect(fs.readFile(path.join(tmp, 'src/x.py'), 'utf8')).resolves.toBe('x = 1\n');
  });

  it('truncates long tool failures before feeding them back to the LLM', async () => {
    class LongFailureLLM implements LLMClient {
      readonly name = 'long-failure';
      public secondUser = '';
      private calls = 0;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 2) {
          this.secondUser = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        }
        return this.calls === 1
          ? JSON.stringify({
              thoughts: 'trigger long failure',
              actions: [{ tool: 'huge_fail', args: {} }],
              done: false,
            })
          : JSON.stringify({ thoughts: 'stop after feedback', actions: [], done: true });
      }
    }
    const hugeFailTool: Tool<Record<string, never>, never> = {
      name: 'huge_fail',
      description: 'returns a huge error',
      argsSchema: {},
      async run() {
        return { ok: false, error: `prefix-${'x'.repeat(5000)}-suffix` };
      },
    };
    const llm = new LongFailureLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({ step: { ...baseStep, tools: ['huge_fail'] }, tools: [hugeFailTool], ctx });

    expect(r.success).toBe(false);
    expect(llm.secondUser.length).toBeLessThan(3200);
    expect(llm.secondUser).toContain('[truncated');
    expect(llm.secondUser).not.toContain('x'.repeat(3000));
  });

  it('stops a test step after the configured run_tests failure budget is exhausted', async () => {
    class RepeatingTestFailureLLM implements LLMClient {
      readonly name = 'test-failure-loop';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        return JSON.stringify({
          thoughts: 'run the test gate again',
          actions: [{ tool: 'run_tests', args: { args: ['tests/test_integration.py'] } }],
          done: false,
        });
      }
    }
    const failingRunTestsTool: Tool<{ args?: string[] }, never> = {
      name: 'run_tests',
      description: 'runs pytest and fails',
      argsSchema: { args: 'string[]' },
      async run() {
        return { ok: false, error: 'pytest exit=1\nsrc/parser.py: receivers bug' };
      },
    };
    const llm = new RepeatingTestFailureLLM();
    const exec = new StepExecutor({ llm, maxRounds: 6, maxFailedTestRuns: 2 });
    const testStep: Step = {
      ...baseStep,
      phase: 'INTEGRATION_TEST',
      role: 'Tester',
      tools: ['run_tests'],
      outputs: [],
    };

    const r = await exec.run({ step: testStep, tools: [failingRunTestsTool], ctx });

    expect(r.success).toBe(false);
    expect(r.rounds).toBe(2);
    expect(llm.calls).toBe(2);
    expect(r.error).toContain('V-model rollback');
  });

  it('requests permission before sensitive write tools and skips the write when denied', async () => {
    const requests: string[] = [];
    const events: string[] = [];
    const exec = new StepExecutor({ llm: new CapturingLLM(), maxRounds: 1 });
    const r = await exec.run({
      step: baseStep,
      tools: [writeFileTool],
      ctx: {
        ...ctx,
        requestPermission: async (request) => {
          requests.push(`${request.operationType}:${request.target}`);
          return { approved: false, reason: 'test denial' };
        },
        onToolEvent: (event) => {
          events.push(`${event.status}:${event.tool}:${event.ok ?? ''}`);
        },
      },
    });
    expect(r.success).toBe(false);
    expect(requests).toEqual(['file_write:src/x.py']);
    expect(r.toolCalls[0]?.error).toContain('permission denied');
    expect(events).toContain('completed:write_file:false');
    await expect(fs.stat(path.join(tmp, 'src/x.py'))).rejects.toThrow();
  });

  it('fails early when the model repeats read-only probes without progress', async () => {
    class ReadLoopLLM implements LLMClient {
      readonly name = 'read-loop';
      calls = 0;
      async chat(): Promise<string> {
        this.calls++;
        return JSON.stringify({
          thoughts: 'inspect again',
          actions: [{ tool: 'read_file', args: { path: 'src/source.py' } }],
          done: false,
        });
      }
    }
    await ws.writeFile('src/source.py', 'value = 1\n');
    const llm = new ReadLoopLLM();
    const exec = new StepExecutor({ llm, maxRounds: 10 });
    const r = await exec.run({ step: baseStep, tools: [readFileTool], ctx });
    expect(r.success).toBe(false);
    expect(r.error).toContain('repeated read-only/probe actions without progress');
    expect(llm.calls).toBe(3);
  });

  it('compacts large write content out of assistant history before the next round', async () => {
    class LargeWriteThenInspectLLM implements LLMClient {
      readonly name = 'large-history';
      calls = 0;
      sawContentBytes = false;
      sawRawContent = false;
      async chat(messages: ChatMessage[]): Promise<string> {
        this.calls++;
        if (this.calls === 1) {
          return JSON.stringify({
            thoughts: 'write a large file',
            actions: [{ tool: 'write_file', args: { path: 'src/x.py', content: `payload = "${'A'.repeat(2000)}"\n` } }],
            done: false,
          });
        }
        const history = messages.map((message) => message.content).join('\n');
        this.sawContentBytes = history.includes('"contentBytes"');
        this.sawRawContent = history.includes('A'.repeat(500));
        return JSON.stringify({ thoughts: 'finish', actions: [], done: true });
      }
    }
    const llm = new LargeWriteThenInspectLLM();
    const exec = new StepExecutor({ llm, maxRounds: 2 });
    const r = await exec.run({ step: baseStep, tools: [writeFileTool], ctx });
    expect(r.success).toBe(true);
    expect(llm.sawContentBytes).toBe(true);
    expect(llm.sawRawContent).toBe(false);
  });
});
