import { OllamaClient } from '../src/llm/ollama.js';
import { setLocale, t } from '../src/i18n/index.js';

setLocale(process.env.XC_LANG ?? process.env.XCOMPILER_LANG ?? 'en');

const BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const REQUEST_TIMEOUT_MS = envMs('OLLAMA_REQUEST_TIMEOUT_MS', 15 * 60 * 1000);
const STREAM_IDLE_TIMEOUT_MS = envMs('OLLAMA_STREAM_IDLE_TIMEOUT_MS', 5 * 60 * 1000);
const DESIGN_MODEL = process.env.OLLAMA_DESIGN_MODEL ?? 'gemma4:31b-mlx';
const CODE_MODEL = process.env.OLLAMA_CODE_MODEL ?? 'qwen3.6:35b-mlx';

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function probe(model: string, prompt: string, json = false): Promise<void> {
  const c = new OllamaClient({
    baseUrl: BASE,
    model,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  });
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
    console.log(t().system.smokeOk(model, dt, ttft, chunks, preview));
  } catch (err) {
    console.error(t().system.smokeFail(model, (err as Error).message));
    process.exitCode = 1;
  }
}

(async () => {
  console.log(t().system.smokeHeader(BASE));
  await probe(DESIGN_MODEL, 'Reply with the single word: pong');
  await probe(
    CODE_MODEL,
    'Return JSON only: {"lang":"python","ok":true} — no extra text.',
    true,
  );
})();
