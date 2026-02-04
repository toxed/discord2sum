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
  // Supports a simple JSON API.
  //
  // Request (generic): { model?: string, prompt: string }
  // Response (generic): { text: string }
  //
  // Also supports Ollama /api/generate (non-stream):
  // Request: { model: string, prompt: string, stream: false }
  // Response: { response: string, ... }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  const isOllamaGenerate = /\/api\/generate\b/.test(url);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || undefined,
      prompt,
      ...(isOllamaGenerate ? { stream: false } : {}),
    }),
    signal: ac.signal,
  }).finally(() => clearTimeout(t));

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP LLM error: ${res.status} ${JSON.stringify(json)}`);
  }

  const text = (json?.text ?? json?.response ?? json?.result)?.trim();
  if (!text) throw new Error('HTTP LLM returned empty text');
  return text;
}

function splitIntoChunksByNewline(text, { maxChars }) {
  const t = String(text || '');
  if (!t) return [];
  if (!Number.isFinite(maxChars) || maxChars <= 0) return [t];
  if (t.length <= maxChars) return [t];

  const lines = t.split('\n');
  const chunks = [];
  let cur = '';

  for (const line of lines) {
    const candidate = cur ? `${cur}\n${line}` : line;

    // If adding this line exceeds max, flush current chunk.
    if (cur && candidate.length > maxChars) {
      chunks.push(cur);
      cur = line;
      continue;
    }

    // If a single line is longer than maxChars, hard-split it (rare; should not happen).
    if (!cur && line.length > maxChars) {
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
      cur = '';
      continue;
    }

    cur = candidate;
  }

  if (cur) chunks.push(cur);
  return chunks;
}

export async function summarizeTranscriptWithLLM({ transcript }) {
  const timeoutMs = Number(process.env.LLM_HTTP_TIMEOUT_MS || process.env.OPENAI_HTTP_TIMEOUT_MS || '60000');

  const provider = String(process.env.LLM_PROVIDER || '').toLowerCase().trim();
  const httpUrl = String(process.env.LLM_HTTP_URL || '').trim();

  // Default behavior: OpenAI if OPENAI_API_KEY is set.
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.LLM_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const summaryPromptName = String(process.env.SUMMARY_PROMPT || '').trim();
  const chosenName = summaryPromptName || 'summary_ru.txt';

  // Security: only allow simple filenames; force prompts/ prefix.
  if (!/^[a-zA-Z0-9._-]+$/.test(chosenName)) {
    throw new Error(`Invalid SUMMARY_PROMPT filename: ${chosenName}`);
  }

  const promptFile = `prompts/${chosenName}`;
  const template = loadTemplate(promptFile);

  const lang = String(process.env.SUMMARY_LANG || process.env.LLM_OUTPUT_LANG || '').trim() || 'English';

  // Provider selection:
  // - LLM_PROVIDER=http + LLM_HTTP_URL => use local/remote HTTP LLM
  // - otherwise => OpenAI (requires OPENAI_API_KEY)
  const useHttp = provider === 'http' || (provider !== 'openai' && Boolean(httpUrl));

  async function callLLM(prompt) {
    if (useHttp) {
      if (!httpUrl) throw new Error('LLM_HTTP_URL is not set');
      return callHttpLLM({ url: httpUrl, model, prompt, timeoutMs });
    }
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    return callOpenAI({ apiKey, model, prompt, timeoutMs });
  }

  const chunkChars = Number(process.env.LLM_CHUNK_CHARS || '8000');
  const maxChunks = Number(process.env.LLM_MAX_CHUNKS || '12');

  // If transcript is small, do single-shot.
  const t = String(transcript || '');
  if (!t || t.length <= chunkChars) {
    const prompt = applyTemplate(template, { TRANSCRIPT: t, LANG: lang });
    return callLLM(prompt);
  }

  // Map-reduce for long transcripts.
  let chunks = splitIntoChunksByNewline(t, { maxChars: chunkChars });
  let omittedCount = 0;
  if (Number.isFinite(maxChunks) && maxChunks > 0 && chunks.length > maxChunks) {
    omittedCount = chunks.length - maxChunks;
    chunks = chunks.slice(-maxChunks);
  }

  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkHeader =
      `You will receive a transcript chunk ${i + 1}/${chunks.length}. ` +
      `Produce a structured partial summary in ${lang} using the exact required format. ` +
      `Do not reference other chunks.\n\n`;

    const basePrompt = applyTemplate(template, { TRANSCRIPT: chunk, LANG: lang });
    partials.push(await callLLM(chunkHeader + basePrompt));
  }

  const mergePrompt =
    `You are given ${partials.length} partial summaries from chunks of a single team call transcript.\n` +
    (omittedCount > 0
      ? `Note: ${omittedCount} earlier chunk(s) were omitted due to LLM_MAX_CHUNKS. Focus on the provided chunks.\n`
      : '') +
    `Merge them into ONE final structured summary in ${lang}, using the SAME format as the partial summaries.\n` +
    `Deduplicate repeated points, consolidate decisions/tasks, and keep owners/deadlines if present.\n\n` +
    `PARTIAL SUMMARIES:\n\n` +
    partials.map((p, idx) => `--- PART ${idx + 1}/${partials.length} ---\n${p}\n`).join('\n');

  return callLLM(mergePrompt);
}
