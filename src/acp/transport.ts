import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  failure,
  JsonRpcErrorCode,
  type JsonRpcMessage,
} from './protocol.js';

export interface AcpTransport {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: unknown) => void | Promise<void>): void;
  onClose(handler: () => void | Promise<void>): void;
  start(): Promise<void>;
  close(): void;
}

export class StdioTransport implements AcpTransport {
  private messageHandler: ((message: unknown) => void | Promise<void>) | undefined;
  private closeHandler: (() => void | Promise<void>) | undefined;
  private closed = false;
  private rl?: readline.Interface;

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}

  send(message: JsonRpcMessage): void {
    if (this.closed) return;
    this.output.write(JSON.stringify(message) + '\n');
  }

  onMessage(handler: (message: unknown) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void | Promise<void>): void {
    this.closeHandler = handler;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: this.input,
      crlfDelay: Infinity,
      terminal: false,
    });
    for await (const line of this.rl) {
      if (this.closed) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        this.send(failure(null, JsonRpcErrorCode.ParseError, (err as Error).message));
        continue;
      }
      void Promise.resolve(this.messageHandler?.(parsed)).catch((err: unknown) => {
        this.send(failure(null, JsonRpcErrorCode.InternalError, (err as Error).message ?? String(err)));
      });
    }
    this.closed = true;
    await this.closeHandler?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
  }
}
