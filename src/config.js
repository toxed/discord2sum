import { existsSync } from 'node:fs';
import { safePathWithinCwd, clampNumber } from './security.js';

function isTruthy(v) {
  return String(v || '').toLowerCase() === 'true';
}

export function loadConfigFromEnv(env = process.env) {
  const cfg = {
    DISCORD_TOKEN: env.DISCORD_TOKEN,
    DISCORD_GUILD_ID: env.DISCORD_GUILD_ID || null,
    DISCORD_NOTICE_TEXT_CHANNEL_ID: env.DISCORD_NOTICE_TEXT_CHANNEL_ID || null,

    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID,

    WHISPER_CPP_BIN: env.WHISPER_CPP_BIN || null,
    WHISPER_CPP_MODEL: env.WHISPER_CPP_MODEL || null,
    PY_STT_CMD: env.PY_STT_CMD || null,

    SUMMARY_PROMPT_LANG: env.SUMMARY_PROMPT_LANG || 'ru',

    OPENAI_API_KEY: env.OPENAI_API_KEY || null,
    OPENAI_MODEL: env.OPENAI_MODEL || 'gpt-4o-mini',

    ALLOW_ABSOLUTE_PATHS: isTruthy(env.ALLOW_ABSOLUTE_PATHS),

    CHUNK_SECONDS: clampNumber('CHUNK_SECONDS', env.CHUNK_SECONDS, { min: 10, max: 5 * 60, fallback: 60 }),
    MIN_SEGMENT_SECONDS: clampNumber('MIN_SEGMENT_SECONDS', env.MIN_SEGMENT_SECONDS, { min: 0.3, max: 60, fallback: 1.0 }),
    SKIP_EMPTY_CALL_UNDER_MS: clampNumber('SKIP_EMPTY_CALL_UNDER_MS', env.SKIP_EMPTY_CALL_UNDER_MS, { min: 0, max: 10 * 60_000, fallback: 20_000 }),

    MAX_TRANSCRIPT_ITEMS: clampNumber('MAX_TRANSCRIPT_ITEMS', env.MAX_TRANSCRIPT_ITEMS, { min: 50, max: 10_000, fallback: 800 }),
    MAX_SEGMENT_TEXT_CHARS: clampNumber('MAX_SEGMENT_TEXT_CHARS', env.MAX_SEGMENT_TEXT_CHARS, { min: 200, max: 20_000, fallback: 4000 }),
    MAX_TRANSCRIPT_CHARS_FOR_LLM: clampNumber('MAX_TRANSCRIPT_CHARS_FOR_LLM', env.MAX_TRANSCRIPT_CHARS_FOR_LLM, { min: 1000, max: 200_000, fallback: 20_000 }),

    // Local transcript retention (0 disables)
    TRANSCRIPTS_MAX_FILES: clampNumber('TRANSCRIPTS_MAX_FILES', env.TRANSCRIPTS_MAX_FILES, { min: 0, max: 100_000, fallback: 0 }),
    TRANSCRIPTS_MAX_AGE_DAYS: clampNumber('TRANSCRIPTS_MAX_AGE_DAYS', env.TRANSCRIPTS_MAX_AGE_DAYS, { min: 0, max: 3650, fallback: 0 }),

    // Optional webhook
    WEBHOOK_URL: env.WEBHOOK_URL || null,
    WEBHOOK_TIMEOUT_MS: clampNumber('WEBHOOK_TIMEOUT_MS', env.WEBHOOK_TIMEOUT_MS, { min: 1000, max: 120_000, fallback: 15000 }),

    // Alerts / self-check
    // Default true unless explicitly set to false.
    STT_SELFTEST: env.STT_SELFTEST == null ? true : isTruthy(env.STT_SELFTEST),
    STT_ERROR_NOTIFY: env.STT_ERROR_NOTIFY == null ? true : isTruthy(env.STT_ERROR_NOTIFY),
    STT_ERROR_NOTIFY_COOLDOWN_SEC: clampNumber('STT_ERROR_NOTIFY_COOLDOWN_SEC', env.STT_ERROR_NOTIFY_COOLDOWN_SEC, { min: 0, max: 86_400, fallback: 600 }),

    INTRO_OPUS_PATH_RAW: env.INTRO_OPUS_PATH || 'assets/intro.opus',
    TRANSCRIPTS_DIR_RAW: env.TRANSCRIPTS_DIR || 'transcripts',
  };

  // Resolve paths with safety
  cfg.INTRO_OPUS_PATH = safePathWithinCwd(cfg.INTRO_OPUS_PATH_RAW, { allowAbsolute: cfg.ALLOW_ABSOLUTE_PATHS });
  cfg.TRANSCRIPTS_DIR = safePathWithinCwd(cfg.TRANSCRIPTS_DIR_RAW, { allowAbsolute: cfg.ALLOW_ABSOLUTE_PATHS });

  // If intro file doesn't exist, disable intro playback.
  if (cfg.INTRO_OPUS_PATH && !existsSync(cfg.INTRO_OPUS_PATH)) {
    cfg.INTRO_OPUS_PATH = null;
  }

  return cfg;
}

export function validateConfig(cfg) {
  const errors = [];

  function req(name) {
    if (!cfg[name] || String(cfg[name]).trim() === '') errors.push(`${name} is required`);
  }

  req('DISCORD_TOKEN');
  req('TELEGRAM_BOT_TOKEN');
  req('TELEGRAM_CHAT_ID');

  // Optional IDs format: digits only
  for (const name of ['DISCORD_GUILD_ID', 'DISCORD_NOTICE_TEXT_CHANNEL_ID', 'TELEGRAM_CHAT_ID']) {
    const v = cfg[name];
    if (v && !/^\d+$/.test(String(v))) {
      errors.push(`${name} must be numeric (got: ${v})`);
    }
  }

  // STT configuration must be present
  const hasPy = Boolean(cfg.PY_STT_CMD);
  const hasWhisperCpp = Boolean(cfg.WHISPER_CPP_BIN && cfg.WHISPER_CPP_MODEL);
  if (!hasPy && !hasWhisperCpp) {
    errors.push('No STT configured: set PY_STT_CMD or WHISPER_CPP_BIN+WHISPER_CPP_MODEL');
  }

  // If whisper.cpp configured, ensure files exist (best-effort)
  if (hasWhisperCpp) {
    if (!existsSync(cfg.WHISPER_CPP_BIN)) errors.push(`WHISPER_CPP_BIN not found: ${cfg.WHISPER_CPP_BIN}`);
    if (!existsSync(cfg.WHISPER_CPP_MODEL)) errors.push(`WHISPER_CPP_MODEL not found: ${cfg.WHISPER_CPP_MODEL}`);
  }

  // Intro is optional. If missing, we just disable intro playback.
  // (We still validate path safety elsewhere.)

  if (errors.length) {
    const msg = 'Invalid configuration:\n' + errors.map((e) => `- ${e}`).join('\n');
    throw new Error(msg);
  }

  return true;
}
