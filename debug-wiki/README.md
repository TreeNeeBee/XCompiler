# XCompiler Debug Wiki

This directory is a bundled LLM-wiki style knowledge base for Debugger repair. Wiki experience
provides debugging context; it does not replace current judgement, verification or formal Rules.

- `wiki/system/` contains shared compiler/system debugging knowledge.
- `wiki/agent/` contains shared agent/model-interaction experience.
- `wiki/external/` contains shared external dependency/ecosystem knowledge and is the existing
  writer fallback for callers without a project path.
- `wiki/project/` lives under the separate derived-project Wiki root. It retains that project's
  verified Bug experience without writing project findings into the shared categories.
- `index.md` is regenerated in the runtime copy as a human-readable catalog.
- `index.json` is regenerated in the runtime copy as a machine-readable retrieval index.
- `log.md` is an append-only runtime operation log for retrieval, failed reuse, and confirmed repairs.

The three shared categories and the project-local storage scope are distinct. Here the compiler is
XCompiler itself; a derived project is the user's project generated through XCompiler `build` and
`run`.

At runtime XCompiler copies `system` and `agent` pages into the configured shared Wiki root and
builds retrieval indexes. Normal `run` also supplies the derived-project Wiki root; its new Bug
experience is written there only after the Bug is closed with a verified solution. Without a
project path, the store retains its existing `external` writer fallback. Runtime feedback does not
publish or rewrite formal Rules.
