import fetch from 'node-fetch';

function sanitizeSlackText(input) {
  const text = String(input ?? '');
  // Slack accepts UTF-8; strip control chars except \n and \t.
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\r\n?/g, '\n');
}

/**
 * Send a message to Slack.
 *
 * Preferred: Incoming Webhook URL.
 * https://api.slack.com/messaging/webhooks
 */
function splitSlack(text, limit = 35000) {
  const t = String(text ?? '');
  if (t.length <= limit) return [t];

  const parts = [];
  let rest = t;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.6) cut = limit; // fallback hard cut
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim().length) parts.push(rest);
  return parts;
}

export async function sendSlackMessage({
  webhookUrl,
  text,
  channel = null,
  username = null,
  iconEmoji = null,
  timeoutMs = 15000,
  maxChars = 35000,
}) {
  if (!webhookUrl) throw new Error('Slack webhookUrl missing');

  const safe = sanitizeSlackText(text);
  const chunks = splitSlack(safe, maxChars);

  let last = null;
  for (const chunk of chunks) {
    const payload = { text: chunk };
    if (channel) payload.channel = channel;
    if (username) payload.username = username;
    if (iconEmoji) payload.icon_emoji = iconEmoji;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });

      const body = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(`Slack webhook failed: ${res.status} ${body.slice(0, 500)}`);
      }
      last = { ok: true, body: String(body).trim().slice(0, 200) };
    } finally {
      clearTimeout(t);
    }
  }

  return last || { ok: true };
}
