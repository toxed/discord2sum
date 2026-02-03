import { sendTelegramMessage } from './telegram.js';
import { sendSlackMessage } from './slack.js';
import { sendWebhook } from './webhook.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetries(fn, { retries = 2, baseDelayMs = 800, logger = null, name = 'op' } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn({ attempt });
    } catch (e) {
      lastErr = e;
      const msg = e?.message || e;
      if (attempt >= retries) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      logger?.warn?.(`${name} failed; retrying`, { attempt: attempt + 1, delayMs: delay, err: String(msg).slice(0, 300) });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Deliver summary to all configured outputs.
 *
 * - Telegram: required (current primary)
 * - Slack: optional
 * - Webhook (JSON): optional
 */
export async function deliverSummary({
  logger,
  telegram,
  slack,
  webhook,
  text,
  webhookPayload,
}) {
  if (telegram?.enabled) {
    await withRetries(
      async () =>
        sendTelegramMessage({
          token: telegram.token,
          chatId: telegram.chatId,
          text,
        }),
      { logger, name: 'Telegram delivery', retries: telegram.retries ?? 2, baseDelayMs: telegram.retryDelayMs ?? 800 }
    );
  }

  if (slack?.enabled && slack.webhookUrl) {
    await withRetries(
      async () =>
        sendSlackMessage({
          webhookUrl: slack.webhookUrl,
          channel: slack.channel,
          username: slack.username,
          iconEmoji: slack.iconEmoji,
          timeoutMs: slack.timeoutMs,
          maxChars: slack.maxChars,
          text,
        }),
      { logger, name: 'Slack delivery', retries: slack.retries ?? 2, baseDelayMs: slack.retryDelayMs ?? 800 }
    );
  }

  if (webhook?.enabled && webhook.url) {
    await withRetries(
      async () =>
        sendWebhook({
          url: webhook.url,
          timeoutMs: webhook.timeoutMs,
          logger,
          payload: webhookPayload,
        }),
      { logger, name: 'Webhook delivery', retries: webhook.retries ?? 1, baseDelayMs: webhook.retryDelayMs ?? 800 }
    );
  }
}
