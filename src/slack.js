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
export async function sendSlackMessage({ webhookUrl, text, channel = null, username = null, iconEmoji = null, timeoutMs = 15000 }) {
  if (!webhookUrl) throw new Error('Slack webhookUrl missing');
  const payload = {
    text: sanitizeSlackText(text),
  };
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

    // Slack webhooks return 'ok' body on success.
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`Slack webhook failed: ${res.status} ${body.slice(0, 500)}`);
    }
    if (String(body).trim() !== 'ok') {
      // still often ok, but keep visibility
      return { ok: true, body: String(body).slice(0, 200) };
    }
    return { ok: true };
  } finally {
    clearTimeout(t);
  }
}
