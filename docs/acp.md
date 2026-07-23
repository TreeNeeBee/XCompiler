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
- A-E Build clarification choices are mapped to explicit ACP options. Arbitrary free-form follow-up text still requires a future multi-turn ACP prompt extension.
- Cancellation immediately rejects pending Build interactions and Run permissions and prevents the next Runtime phase from starting. An already-running provider/tool operation may finish before task closure.
- `sessionId` scopes the conversation, while every Runtime tool invocation has a unique `callId` mapped to ACP `toolCallId`; permission and Patch updates reuse that same call identity.
- Official ACP registry publication still requires a real Zed smoke test and final registry metadata alignment.
