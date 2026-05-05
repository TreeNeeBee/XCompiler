import { OllamaClient } from '../src/llm/ollama.js';

const BASE = process.env.OLLAMA_BASE_URL ?? 'http://10.80.105.160:11434';

async function probe(model: string, prompt: string, json = false): Promise<void> {
  const c = new OllamaClient({ baseUrl: BASE, model, requestTimeoutMs: 5 * 60 * 1000 });
  const t0 = Date.now();
  try {
    let chunks = 0;
    let firstChunkAt = 0;
    const out = await c.chat(
      [
        { role: 'system', content: json ? 'You only respond with strict JSON.' : 'You are concise.' },
        { role: 'user', content: prompt },
      ],
      {
        temperature: 0.1,
        responseFormat: json ? 'json' : 'text',
        onToken: (chunk) => {
          chunks++;
          if (firstChunkAt === 0) firstChunkAt = Date.now();
          process.stderr.write(chunk);
        },
      },
    );
    process.stderr.write('\n');
    const dt = Date.now() - t0;
    const ttft = firstChunkAt ? firstChunkAt - t0 : -1;
    const preview = out.replace(/\s+/g, ' ').slice(0, 200);
    console.log(
      `[OK total=${dt}ms first-token=${ttft}ms chunks=${chunks}] ${model} -> ${preview}`,
    );
  } catch (err) {
    console.error(`[FAIL] ${model} -> ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log(`Smoke test against ${BASE} (streaming)`);
  await probe('gemma4:31b', 'Reply with the single word: pong');
  await probe(
    'qwen3-coder:30b',
    'Return JSON only: {"lang":"python","ok":true} — no extra text.',
    true,
  );
})();
