import fetch from 'node-fetch';

export async function sendWebhook({ url, payload, timeoutMs = 15000, logger = null }) {
  if (!url) return;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Webhook failed: ${res.status} ${text.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(t);
  }

  logger?.info?.('Webhook delivered');
}
