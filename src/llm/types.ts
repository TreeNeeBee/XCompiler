export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Force JSON-only response if provider supports it. */
  responseFormat?: 'text' | 'json';
  /**
   * 流式 token 回调。设置后 provider 会以增量方式推送 token；
   * provider 仍会聚合并返回完整文本作为最终结果。
   */
  onToken?: (chunk: string) => void;
  /**
   * 流式模式下的“可提前结束”判定。用于兼容一些 provider：
   * 输出内容本身已经完整，但既不及时发送 [DONE]，也不主动断开连接。
   * 返回 true 后 provider 应尽快结束本次流读取并返回当前 aggregate。
   */
  streamStopWhen?: (text: string) => boolean;
  /**
   * 可选验证钩子：provider 返回后调用。抛异常会被 FallbackClient
   * 视为该 provider 失败，并切换到下一个。适用于：JSON 退化、
   * 空输出、model token loop 等“表面成功但语义不可用”场景。
   */
  validate?: (text: string) => void;
  /**
   * 调用者可传入回调，与 LLM 输出一同拿到实际产出该响应的 provider 名。
   * 主要用于追溯：在 FallbackClient 中服务于响应的是链中某一个后选 provider，
   * 调用者（如 Executor）需要在审计 / Markdown 记录中为响应打上正确的“via 哪个模型”标签。
   */
  onProvider?: (name: string) => void;
}

export interface LLMClient {
  readonly name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
