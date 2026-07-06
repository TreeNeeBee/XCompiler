import { JsonRpcErrorCode } from './protocol.js';

export class AcpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

export function invalidParams(message: string, data?: unknown): AcpError {
  return new AcpError(JsonRpcErrorCode.InvalidParams, message, data);
}

export function sessionNotFound(sessionId: string): AcpError {
  return new AcpError(JsonRpcErrorCode.SessionNotFound, `ACP session not found: ${sessionId}`);
}

export function taskNotFound(taskId: string): AcpError {
  return new AcpError(JsonRpcErrorCode.TaskNotFound, `ACP task not found: ${taskId}`);
}

export function pendingRequestNotFound(requestId: string): AcpError {
  return new AcpError(JsonRpcErrorCode.PendingRequestNotFound, `pending ACP request not found: ${requestId}`);
}
