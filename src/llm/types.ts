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
   * 可选验证钩子：provider 返回后调用。抛异常会被 FallbackClient
   * 视为该 provider 失败，并切换到下一个。适用于：JSON 退化、
   * 空输出、model token loop 等“表面成功但语义不可用”场景。
   */
  validate?: (text: string) => void;
}

export interface LLMClient {
  readonly name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
