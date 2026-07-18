# XCompiler ACP Adapter

XCompiler exposes an ACP Code Agent adapter over stdio:

```bash
xcompiler acp
```

The adapter is protocol-facing only. It maps ACP requests to the XCompiler Runtime and streams Runtime progress back through `session/update`.

## Supported ACP v1 Flow

- `initialize`
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/close`
- `session/update`
- `session/request_permission`

The adapter keeps stdout reserved for JSON-RPC messages. Runtime logs and adapter diagnostics must go to stderr.

## Zed Local Configuration

When XCompiler is installed on PATH:

```json
{
  "agent_servers": {
    "XCompiler": {
      "command": "xcompiler",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

For local development from this repository:

```json
{
  "agent_servers": {
    "XCompiler Dev": {
      "command": "/path/to/XCompiler/node_modules/.bin/tsx",
      "args": [
        "/path/to/XCompiler/src/cli/xcompiler.ts",
        "acp"
      ],
      "env": {}
    }
  }
}
```

Replace `/path/to/XCompiler` with the local repository path. ACP mode must keep stdout reserved for JSON-RPC only; use stderr for adapter diagnostics.

## Current Limitations

- The adapter supports Code Agent task execution, not general chat.
- Build-stage confirm/select interactions are mapped to `session/request_permission`.
- Free-form build-stage follow-up text is not yet modeled as a multi-turn ACP prompt loop.
- Runtime cancellation is best-effort until Runtime exposes hard cancellation.
- Official ACP registry publication still requires a real Zed smoke test and final registry metadata alignment.
