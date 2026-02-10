import fetch from 'node-fetch';

async function sendOne({ token, chatId, text, parseMode = null }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(parseMode ? { parse_mode: parseMode } : {}),
  };
  const timeoutMs = Number(process.env.TELEGRAM_HTTP_TIMEOUT_MS || '30000');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).finally(() => clearTimeout(t));
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function sanitizeTelegramText(input) {
  const text = String(input ?? '');
  // Telegram expects valid UTF-8. Also, some control characters can cause issues.
  // Keep \n and \t; strip the rest of C0/C1 controls.
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\r\n?/g, '\n');
}

function splitTelegram(text, limit = 3800) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    // try split on newline close to limit
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.6) cut = limit; // fallback hard cut
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim().length) parts.push(rest);
  return parts;
}

function escapeTelegramMarkdownLite(input) {
  // Telegram "Markdown" (legacy) treats _ and [ as control chars.
  // We don't rely on them for formatting in our summaries, but they appear in nicknames/words.
  // Escape them so usernames like Artyom_Payments don't break rendering.
  return String(input ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[');
}

export async function sendTelegramMessage({ token, chatId, text }) {
  if (!token || !chatId) throw new Error('Telegram token/chatId missing');
  const safe = sanitizeTelegramText(text);
  const chunks = splitTelegram(safe);

  // Prefer Telegram Markdown rendering so summaries look nice.
  // If Telegram rejects malformed Markdown, fall back to plain text.
  let last = null;
  for (const chunk of chunks) {
    const mdSafe = escapeTelegramMarkdownLite(chunk);
    try {
      last = await sendOne({ token, chatId, text: mdSafe, parseMode: 'Markdown' });
    } catch (e) {
      last = await sendOne({ token, chatId, text: chunk, parseMode: null });
    }
  }
  return last;
}
