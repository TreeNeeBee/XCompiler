import type { ChatMessage, ChatOptions, LLMClient } from './types.js';

export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
}

export class OpenAIClient implements LLMClient {
  readonly name: string;
  constructor(private readonly cfg: OpenAIConfig) {
    this.name = `openai:${cfg.model}`;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    if (!this.cfg.apiKey) throw new Error('OpenAI api_key is empty (set OPENAI_API_KEY).');
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens,
    };
    if (options?.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
    }
    const json = (await res.json()) as OpenAIChatResponse;
    if (json.error) throw new Error(`OpenAI error: ${json.error.message}`);
    return json.choices?.[0]?.message?.content ?? '';
  }
}
