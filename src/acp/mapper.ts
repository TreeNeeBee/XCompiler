import type { RuntimeEvent } from '../runtime/io.js';
import type { AcpSessionUpdate } from './types.js';

export interface AcpMappedUpdate {
  update: AcpSessionUpdate;
  legacyType: string;
  path?: string;
}

export function mapRuntimeEventToAcpUpdates(
  event: RuntimeEvent,
  ctx: { taskId: string; phase: 'build' | 'run' },
): AcpMappedUpdate[] {
  const meta = (legacyType: string, extra: Record<string, unknown> = {}) => ({
    xcompiler: { eventType: legacyType, taskId: ctx.taskId, phase: ctx.phase, ...extra },
  });

  if (event.type === 'log') {
    const legacyType = event.level === 'warning'
      ? 'warning'
      : event.level === 'error'
        ? 'error'
        : ctx.phase === 'build' ? 'build_progress' : 'run_progress';
    return [{
      legacyType,
      update: agentText(event.message, meta(legacyType, { level: event.level })),
    }];
  }

  if (event.type === 'progress') {
    const legacyType = ctx.phase === 'build' ? 'build_progress' : 'run_progress';
    return [{
      legacyType,
      update: agentText(event.message, meta(legacyType, { status: event.status })),
    }];
  }

  if (event.type === 'result') {
    const legacyType = event.command === 'build' ? 'build_completed' : 'run_completed';
    return [{
      legacyType,
      update: agentText(
        `${event.command} ${event.status}`,
        meta(legacyType, { status: event.status, data: event.data }),
      ),
    }];
  }

  if (event.type === 'tool_call') {
    const legacyType =
      event.tool === 'run_tests'
        ? event.status === 'started' ? 'test_started' : 'test_completed'
        : event.status === 'started' ? 'tool_call_started' : 'run_progress';
    const toolCallId = event.callId;
    if (event.status === 'started') {
      return [{
        legacyType,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: event.target ? `${event.tool}: ${event.target}` : event.tool,
          kind: event.tool === 'run_tests' ? 'execute' : 'other',
          status: 'pending',
          rawInput: {
            stepId: event.stepId,
            tool: event.tool,
            target: event.target,
          },
          _meta: meta(legacyType, { stepId: event.stepId, tool: event.tool }),
        },
      }];
    }
    return [{
      legacyType,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: event.ok === false ? 'failed' : 'completed',
        rawOutput: {
          ok: event.ok,
          summary: event.summary,
          error: event.error,
        },
        content: [{
          type: 'content',
          content: {
            type: 'text',
            text: event.summary ?? event.error ?? `${event.tool} completed`,
          },
        }],
        _meta: meta(legacyType, { stepId: event.stepId, tool: event.tool }),
      },
    }];
  }

  if (event.type === 'file_changed') {
    const legacyType = 'file_changed';
    return [{
      legacyType,
      path: event.path,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.callId,
        status: 'completed',
        locations: [{ path: event.path }],
        content: [{
          type: 'content',
          content: { type: 'text', text: `Changed ${event.path}` },
        }],
        _meta: meta(legacyType, {
          stepId: event.stepId,
          tool: event.tool,
          path: event.path,
        }),
      },
    }];
  }

  if (event.type === 'patch_proposed') {
    const legacyType = 'patch_proposed';
    return [{
      legacyType,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.callId,
        status: 'pending',
        content: [{
          type: 'content',
          content: { type: 'text', text: `Patch proposed:\n\n${event.patch}` },
        }],
        rawOutput: { patch: event.patch },
        _meta: meta(legacyType, {
          stepId: event.stepId,
          tool: event.tool,
          patch: event.patch,
        }),
      },
    }];
  }

  if (event.type === 'permission') {
    const legacyType = event.status === 'requested' ? 'permission_required' : `permission_${event.status}`;
    return [{
      legacyType,
      update: agentText(legacyType, meta(legacyType, { request: event.request })),
    }];
  }

  return [];
}

export function agentText(text: string, meta?: Record<string, unknown>): AcpSessionUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(meta ? { _meta: meta } : {}),
  };
}

export function taskUpdate(
  type: string,
  taskId: string,
  message: string,
  extra: Record<string, unknown> = {},
): AcpSessionUpdate {
  return agentText(message, { xcompiler: { eventType: type, taskId, ...extra } });
}
