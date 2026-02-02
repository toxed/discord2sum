import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadTemplate(path) {
  const p = resolve(process.cwd(), path);
  return readFileSync(p, 'utf-8');
}

function applyTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

export async function summarizeTranscriptWithLLM({ transcript, lang = 'ru' }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const fileRu = process.env.SUMMARY_PROMPT_FILE_RU || 'prompts/summary_ru.txt';
  const fileEn = process.env.SUMMARY_PROMPT_FILE_EN || 'prompts/summary_en.txt';
  const promptFile = (lang || 'ru').toLowerCase().startsWith('en') ? fileEn : fileRu;

  const template = loadTemplate(promptFile);
  const prompt = applyTemplate(template, {
    TRANSCRIPT: transcript,
  });

  const timeoutMs = Number(process.env.OPENAI_HTTP_TIMEOUT_MS || '60000');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'user', content: prompt },
      ],
    }),
    signal: ac.signal,
  }).finally(() => clearTimeout(t));

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI error: ${res.status} ${JSON.stringify(json)}`);
  }

  const text = json?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned empty summary');
  return text;
}
