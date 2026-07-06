import { AcpServer } from './server.js';
import { StdioTransport } from './transport.js';

export { AcpServer } from './server.js';
export { StdioTransport, type AcpTransport } from './transport.js';
export { AcpMethod, JsonRpcErrorCode } from './protocol.js';
export type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
} from './protocol.js';
export type {
  AcpCodeTaskParams,
  AcpInitializeResult,
  AcpRuntimeFacade,
  AcpServerLogger,
  AcpServerOptions,
  AcpSession,
  AcpTask,
} from './types.js';

export async function runAcpStdioServer(): Promise<void> {
  const server = new AcpServer();
  await server.start(new StdioTransport());
}
