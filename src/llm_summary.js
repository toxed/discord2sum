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

async function callOpenAI({ apiKey, model, prompt, timeoutMs }) {
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
      messages: [{ role: 'user', content: prompt }],
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

async function callHttpLLM({ url, model, prompt, timeoutMs }) {
  // Supports a very simple JSON API:
  // Request: { model?: string, prompt: string }
  // Response: { text: string }
  //
  // This is compatible with many small wrappers around local LLM servers.

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || undefined,
      prompt,
    }),
    signal: ac.signal,
  }).finally(() => clearTimeout(t));

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP LLM error: ${res.status} ${JSON.stringify(json)}`);
  }

  const text = json?.text?.trim();
  if (!text) throw new Error('HTTP LLM returned empty text');
  return text;
}

export async function summarizeTranscriptWithLLM({ transcript }) {
  const timeoutMs = Number(process.env.LLM_HTTP_TIMEOUT_MS || process.env.OPENAI_HTTP_TIMEOUT_MS || '60000');

  const provider = String(process.env.LLM_PROVIDER || '').toLowerCase().trim();
  const httpUrl = String(process.env.LLM_HTTP_URL || '').trim();

  // Default behavior: OpenAI if OPENAI_API_KEY is set.
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

  // Prompt selection:
  // SUMMARY_PROMPT: a file name inside ./prompts (e.g. "summary_ru.txt").
  // Fallback: summary_ru.txt

  const summaryPromptName = String(process.env.SUMMARY_PROMPT || '').trim();
  const chosenName = summaryPromptName || 'summary_ru.txt';

  // Security: only allow simple filenames; force prompts/ prefix.
  if (!/^[a-zA-Z0-9._-]+$/.test(chosenName)) {
    throw new Error(`Invalid SUMMARY_PROMPT filename: ${chosenName}`);
  }

  const promptFile = `prompts/${chosenName}`;

  const template = loadTemplate(promptFile);
  const prompt = applyTemplate(template, {
    TRANSCRIPT: transcript,
  });

  // Provider selection:
  // - LLM_PROVIDER=http + LLM_HTTP_URL => use local/remote HTTP LLM
  // - otherwise => OpenAI (requires OPENAI_API_KEY)
  const useHttp = provider === 'http' || (provider !== 'openai' && Boolean(httpUrl));

  if (useHttp) {
    if (!httpUrl) throw new Error('LLM_HTTP_URL is not set');
    return callHttpLLM({ url: httpUrl, model, prompt, timeoutMs });
  }

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  return callOpenAI({ apiKey, model, prompt, timeoutMs });
}
