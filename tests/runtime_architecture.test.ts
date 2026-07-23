import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

describe('Runtime architecture boundary', () => {
  it('public runtime exports build/run from runtime modules, not CLI adapters', async () => {
    const runtime = await read('src/runtime.ts');
    expect(runtime).toContain("./runtime/build.js");
    expect(runtime).toContain("./runtime/run.js");
    expect(runtime).toContain("./runtime/bootstrap.js");
    expect(runtime).toContain("./runtime/doctor.js");
    expect(runtime).toContain("./runtime/inspect.js");
    expect(runtime).not.toContain("./cli/compile.js");
    expect(runtime).not.toContain("./cli/execute.js");
    expect(runtime).not.toContain("./cli/bootstrap.js");
  });

  it('build/run CLI files are thin adapters and do not import business internals', async () => {
    const compile = await read('src/cli/compile.ts');
    const execute = await read('src/cli/execute.ts');
    const cli = `${compile}\n${execute}`;

    expect(compile).toContain("../runtime/build.js");
    expect(execute).toContain("../runtime/run.js");
    expect(cli).not.toMatch(/\.\.\/agents\/planner|Planner|buildPlan/u);
    expect(cli).not.toMatch(/\.\.\/core\/engine|PhaseEngine/u);
    expect(cli).not.toMatch(/\.\.\/llm\/router|LLMRouter/u);
    expect(cli).not.toMatch(/\.\.\/plugins\/host|PluginHost/u);
    expect(cli).not.toMatch(/\.\.\/tools\/|buildDefaultRegistry/u);
  });

  it('command-line entrypoints delegate command orchestration to runtime commands', async () => {
    const main = await read('src/cli/xcompiler.ts');
    const build = await read('src/cli/xcompiler_build.ts');
    const run = await read('src/cli/xcompiler_run.ts');
    const bootstrap = await read('src/cli/bootstrap.ts');
    const doctor = await read('src/cli/doctor.ts');
    const inspect = await read('src/cli/inspect.ts');
    const entrypoints = `${main}\n${build}\n${run}`;

    expect(entrypoints).toContain("../runtime/commands.js");
    expect(entrypoints).not.toMatch(/loadXCompilerProject|resolveCompileWorkspace|resolveEvolveWorkspace/u);
    expect(entrypoints).not.toMatch(/from '\.\/compile\.js'|from '\.\/execute\.js'|from '\.\/workspace\.js'/u);
    expect(entrypoints).not.toMatch(/runCompile\(|runExecute\(/u);
    expect(bootstrap).toContain("../runtime/bootstrap.js");
    expect(bootstrap).not.toContain("../runtime/build.js");
    expect(bootstrap).not.toContain("../runtime/run.js");
    expect(bootstrap).not.toMatch(/from '\.\/compile\.js'|from '\.\/execute\.js'/u);
    expect(doctor).toContain("../runtime/doctor.js");
    expect(inspect).toContain("../runtime/inspect.js");
    expect(`${doctor}\n${inspect}`).not.toMatch(/from '\.\.\/core\//u);
  });

  it('runtime build/run modules do not own terminal rendering or process exit codes', async () => {
    const build = await read('src/runtime/build.ts');
    const run = await read('src/runtime/run.ts');
    const bootstrap = await read('src/runtime/bootstrap.ts');
    const doctor = await read('src/runtime/doctor.ts');
    const inspect = await read('src/runtime/inspect.ts');
    const runtimeCommands = `${build}\n${run}\n${bootstrap}\n${doctor}\n${inspect}`;

    expect(runtimeCommands).not.toMatch(/from '@inquirer\/prompts'|from 'chalk'|spinner as ora/u);
    expect(runtimeCommands).not.toMatch(/console\.(log|error|warn)/u);
    expect(runtimeCommands).not.toMatch(/process\.(exitCode|stdin|stdout|stderr)/u);
  });

  it('configuration and router internals do not write directly to the terminal', async () => {
    const config = await read('src/config/config.ts');
    const router = await read('src/llm/router.ts');
    expect(`${config}\n${router}`).not.toMatch(/console\.(log|error|warn)|process\.(stdout|stderr)\.write/u);
  });
});
