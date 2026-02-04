import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  REST,
  Routes,
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeLogger } from './logger.js';
import { startUserRecording } from './recorder.js';
import { transcribeFile } from './stt.js';
import { sendTelegramMessage } from './telegram.js';
import { summarizeTranscriptWithLLM } from './llm_summary.js';
import { sanitizeLabel } from './security.js';
import { loadConfigFromEnv, validateConfig } from './config.js';
import { pruneOldFiles } from './retention.js';
import { runSttSelfTest } from './selftest.js';
import { deliverSummary } from './delivery.js';

const logger = makeLogger(process.env.LOG_LEVEL || 'info');

// Load + validate config at startup (fail fast)
const CFG = loadConfigFromEnv(process.env);
validateConfig(CFG);

const DISCORD_TOKEN = CFG.DISCORD_TOKEN;
const GUILD_ID = CFG.DISCORD_GUILD_ID;
const NOTICE_TEXT_CHANNEL_ID = CFG.DISCORD_NOTICE_TEXT_CHANNEL_ID;
let noticeChannelOverrideId = null;

const TELEGRAM_BOT_TOKEN = CFG.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = CFG.TELEGRAM_CHAT_ID;

const WHISPER_CPP_BIN = CFG.WHISPER_CPP_BIN;
const WHISPER_CPP_MODEL = CFG.WHISPER_CPP_MODEL;
const PY_STT_CMD = CFG.PY_STT_CMD;

// SUMMARY_PROMPT_LANG removed; prompt selected by SUMMARY_PROMPT file.

const CHUNK_SECONDS = CFG.CHUNK_SECONDS;
const MIN_SEGMENT_SECONDS = CFG.MIN_SEGMENT_SECONDS;
const MAX_SEGMENT_TEXT_CHARS = CFG.MAX_SEGMENT_TEXT_CHARS;
const MAX_TRANSCRIPT_CHARS_FOR_LLM = CFG.MAX_TRANSCRIPT_CHARS_FOR_LLM;
const MAX_TRANSCRIPT_ITEMS = CFG.MAX_TRANSCRIPT_ITEMS;
const SKIP_EMPTY_CALL_UNDER_MS = CFG.SKIP_EMPTY_CALL_UNDER_MS;

const INTRO_OPUS_PATH = CFG.INTRO_OPUS_PATH;
const TRANSCRIPTS_DIR = CFG.TRANSCRIPTS_DIR;

const DISCORD_DAVE_ENCRYPTION = CFG.DISCORD_DAVE_ENCRYPTION;

const TRANSCRIPTS_MAX_FILES = CFG.TRANSCRIPTS_MAX_FILES;
const TRANSCRIPTS_MAX_AGE_DAYS = CFG.TRANSCRIPTS_MAX_AGE_DAYS;

const WEBHOOK_URL = CFG.WEBHOOK_URL;
const WEBHOOK_TIMEOUT_MS = CFG.WEBHOOK_TIMEOUT_MS;

const SLACK_WEBHOOK_URL = CFG.SLACK_WEBHOOK_URL;
const SLACK_CHANNEL = CFG.SLACK_CHANNEL;
const SLACK_USERNAME = CFG.SLACK_USERNAME;
const SLACK_ICON_EMOJI = CFG.SLACK_ICON_EMOJI;
const SLACK_TIMEOUT_MS = CFG.SLACK_TIMEOUT_MS;
const SLACK_MAX_CHARS = CFG.SLACK_MAX_CHARS;

const STT_SELFTEST = CFG.STT_SELFTEST;
const STT_ERROR_NOTIFY = CFG.STT_ERROR_NOTIFY;
const STT_ERROR_NOTIFY_COOLDOWN_SEC = CFG.STT_ERROR_NOTIFY_COOLDOWN_SEC;

// Optional startup self-test
if (STT_SELFTEST) {
  runSttSelfTest({
    transcribeFile,
    whisperCppBin: WHISPER_CPP_BIN,
    whisperCppModel: WHISPER_CPP_MODEL,
    pyCmdTemplate: PY_STT_CMD,
    logger,
  }).catch(() => {});
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

// Current active voice session state.
let active = {
  guildId: null,
  voiceChannelId: null,
  startedAt: null,
  participants: new Map(), // userId -> username
  recordingsDir: null,
  transcripts: [],
  noticeMessageSent: false,
  joining: false,
  finishing: false,
  recordingUsers: new Set(),
  pending: [],
  pendingMeta: [],
  nonEmptySince: null,
  candidateChannelId: null,
  introPlayed: false,
  introEligibleAt: null,

  // Manual control
  manual: false,
  manualGuildId: null,
  manualVoiceChannelId: null,

  // Metrics / health (per active session)
  metrics: {
    lastSpeechAt: null,
    lastSttOkAt: null,
    lastSttEmptyAt: null,
    lastSttFailAt: null,
    lastNonEmptyTextAt: null,

    segmentsOk: 0,
    segmentsEmpty: 0,
    segmentsTotal: 0,

    sttFailures: 0,
    decodeFailures: 0,
    totalAudioSeconds: 0,

    // Debug (best-effort; local paths)
    lastSegmentSeconds: null,
    lastSegmentWav: null,
    lastSttTextLen: null,
    lastSttSafeTextLen: null,
  },
};

// Cross-session timestamps so /status shows the most recent finalize/delivery
// even after the bot auto-rejoins and resets `active`.
const last = {
  finalizeAt: null,
  summarySentAt: null,

  // Cross-session STT diagnostics (last observed segment)
  nonEmptyTextAt: null,
  sttEmptyAt: null,

  // Snapshot of the most recent finalized call (copied from active right before reset)
  call: {
    guildId: null,
    voiceChannelId: null,
    startedAt: null,
    endedAt: null,
    participants: 0,
    metrics: null,
  },

  // debug (local)
  lastSegmentWav: null,
  lastSegmentSeconds: null,
  lastSttTextLen: null,
  lastSttSafeTextLen: null,
};

let tickInFlight = false;
let joinTimer = null;

// Rate-limited ops notifications
let lastSttErrorNotifyAtMs = 0;

function redactErrorMessage(err) {
  const msg = String(err?.message || err || 'unknown error');
  return msg
    .replace(/\s+\/tmp\/[^\s]+/g, ' <tmpfile>')
    .replaceAll(process.cwd(), '<cwd>')
    .slice(0, 800);
}

async function notifySttErrorOnce({ channelName, err }) {
  if (!STT_ERROR_NOTIFY) return;
  const now = Date.now();
  const cooldownMs = (Number(STT_ERROR_NOTIFY_COOLDOWN_SEC) || 0) * 1000;
  if (cooldownMs > 0 && now - lastSttErrorNotifyAtMs < cooldownMs) return;
  lastSttErrorNotifyAtMs = now;

  const text =
    `discord2sum: STT failure\n` +
    `Channel: ${sanitizeLabel(channelName)}\n` +
    `Error: ${redactErrorMessage(err)}\n` +
    `Hint: check PY_STT_CMD / venv and logs.`;

  try {
    await sendTelegramMessage({
      token: TELEGRAM_BOT_TOKEN,
      chatId: TELEGRAM_CHAT_ID,
      text,
    });
  } catch (e) {
    logger.warn('Failed to send STT alert to Telegram', e?.message || e);
  }
}

function getNoticeChannel(guild) {
  const id = noticeChannelOverrideId || NOTICE_TEXT_CHANNEL_ID;
  if (id) {
    const ch = guild.channels.cache.get(id);
    if (ch && ch.type === ChannelType.GuildText) return ch;
  }
  return guild.systemChannel ?? null;
}

function listHumansInChannel(voiceChannel) {
  return [...voiceChannel.members.values()].filter((m) => !m.user.bot);
}

function pickChannelToRecord(guild) {
  const voiceChannels = [...guild.channels.cache.values()].filter(
    (c) => c.type === ChannelType.GuildVoice
  );
  const candidates = voiceChannels
    .map((vc) => ({ vc, humans: listHumansInChannel(vc) }))
    .filter(({ humans }) => humans.length > 0)
    .sort((a, b) => b.humans.length - a.humans.length);

  return candidates[0]?.vc || null;
}

function shouldJoinCandidate(guild, voiceChannel) {
  // Debounce: require channel to be non-empty for a short time window.
  const humans = listHumansInChannel(voiceChannel).length;
  if (humans === 0) return false;

  const now = Date.now();
  if (!active.nonEmptySince || active.candidateChannelId !== voiceChannel.id) {
    active.nonEmptySince = now;
    active.candidateChannelId = voiceChannel.id;
    // Schedule a follow-up tick soon (don't wait for 5s interval)
    if (joinTimer) clearTimeout(joinTimer);
    joinTimer = setTimeout(() => {
      tick().catch(() => {});
    }, 2200);
    return false;
  }
  return now - active.nonEmptySince >= 2000; // 2s stable presence
}

function scheduleTick(ms) {
  if (joinTimer) clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    tick().catch(() => {});
  }, ms);
}

async function ffmpegPcmToWav(pcmPath, wavPath) {
  // input is raw s16le, 48kHz, mono (our Opus decoder is configured for 1 channel)
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '1',
      '-i', pcmPath,
      '-y',
      wavPath,
    ];
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString('utf-8')));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed code=${code}: ${err.slice(0, 1000)}`));
    });
  });
}

async function playIntroIfNeeded(conn, voiceChannel) {
  if (active.introPlayed) return;
  if (!INTRO_OPUS_PATH) return; // intro disabled

  const humans = listHumansInChannel(voiceChannel).length;
  if (humans < 2) {
    // reset gate if people dropped below 2
    active.introEligibleAt = null;
    return;
  }

  // Delay: wait 10–15 seconds after the 2nd human appears
  const now = Date.now();
  if (!active.introEligibleAt) {
    active.introEligibleAt = now + 12_000; // 12s (middle of 10-15)
    scheduleTick(12_500);
    logger.info('Intro scheduled', { inMs: active.introEligibleAt - now });
    return;
  }
  if (now < active.introEligibleAt) {
    scheduleTick(active.introEligibleAt - now + 200);
    return;
  }

  try {
    // Temporarily unmute to speak the intro
    conn.rejoin({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);

    const introPath = INTRO_OPUS_PATH;
    if (!introPath) return;
    const player = createAudioPlayer();
    logger.info('Intro playback starting');
    const resource = createAudioResource(createReadStream(introPath), {
      inputType: StreamType.OggOpus,
    });
    const sub = conn.subscribe(player);
    if (!sub) logger.warn('Intro: no subscription created');
    player.play(resource);

    await Promise.race([
      new Promise((resolve) => player.once(AudioPlayerStatus.Idle, resolve)),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
    player.stop(true);
    logger.info('Intro playback finished');

    // Re-mute after speaking so UI shows "mic off"
    conn.rejoin({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);

    active.introPlayed = true;
  } catch (e) {
    logger.warn('Intro playback failed', e?.message || e);
  }
}

async function ensureJoined(voiceChannel) {
  if (active.joining) return null; // prevent join storms

  const existing = getVoiceConnection(voiceChannel.guild.id);
  if (existing && active.voiceChannelId === voiceChannel.id) return existing;

  active.joining = true;
  try {
    if (existing) {
      try {
        existing.destroy();
      } catch {}
    }

    logger.info('Joining voice channel', voiceChannel.guild.name, voiceChannel.name);

    // Join muted by default (UI shows mic off). We'll temporarily unmute when we need to play the intro.
    const conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      // Disable DAVE voice encryption unless explicitly enabled; improves receiver stability.
      daveEncryption: DISCORD_DAVE_ENCRYPTION,
    });

    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);

    active.guildId = voiceChannel.guild.id;
    active.voiceChannelId = voiceChannel.id;
    active.startedAt = new Date();
    active.participants = new Map();
    active.transcripts = [];
    active.noticeMessageSent = false;
    active.finishing = false;
    active.recordingUsers = new Set();
    active.pending = [];
    active.pendingMeta = [];
    active.nonEmptySince = null;
    active.candidateChannelId = null;
    active.introPlayed = false;
    active.introEligibleAt = null;

    // reset metrics for new call
    active.metrics = {
      lastSpeechAt: null,
      lastSttOkAt: null,
      lastSttEmptyAt: null,
      lastSttFailAt: null,
      lastNonEmptyTextAt: null,

      segmentsOk: 0,
      segmentsEmpty: 0,
      segmentsTotal: 0,

      sttFailures: 0,
      decodeFailures: 0,
      totalAudioSeconds: 0,

      lastSegmentSeconds: null,
      lastSegmentWav: null,
      lastSttTextLen: null,
      lastSttSafeTextLen: null,
    };

    const dir = join(tmpdir(), `discord-voice-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    active.recordingsDir = dir;

    // Try intro (will only actually play when 2+ humans are present)
    await playIntroIfNeeded(conn, voiceChannel);

    // Start receiving audio (register once per connection)
    const receiver = conn.receiver;
    receiver.speaking.removeAllListeners('start');
    receiver.speaking.on('start', async (userId) => {
      if (active.finishing) return;
      if (active.recordingUsers.has(userId)) return;

      const guild = voiceChannel.guild;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member || member.user.bot) return;

      active.recordingUsers.add(userId);
      active.participants.set(userId, member.displayName);

      active.metrics.lastSpeechAt = new Date().toISOString();

      const { done } = startUserRecording({
        receiver,
        userId,
        outDir: active.recordingsDir,
        minSegmentSeconds: MIN_SEGMENT_SECONDS,
        logger,
      });

      const meta = {
        userId,
        user: sanitizeLabel(member.displayName, { maxLen: 64 }) || `user:${userId}`,
        startedAtMs: Date.now(),
        done: false,
        doneAtMs: null,
      };
      active.pendingMeta.push(meta);

      const job = done
        .then(async ({ segmentPath: pcmPath, seconds }) => {
          if (!pcmPath) return;
          const wavPath = pcmPath.replace(/\.pcm$/, '.wav');
          try {
            await ffmpegPcmToWav(pcmPath, wavPath);

            // Track last segment details for diagnostics (local only).
            active.metrics.lastSegmentSeconds = Number(seconds) || 0;
            active.metrics.lastSegmentWav = wavPath;

            const text = await transcribeFile({
              filePath: wavPath,
              whisperCppBin: WHISPER_CPP_BIN,
              whisperCppModel: WHISPER_CPP_MODEL,
              pyCmdTemplate: PY_STT_CMD,
            });

            const rawText = String(text || '');
            const safeUser = sanitizeLabel(member.displayName, { maxLen: 64 }) || `user:${userId}`;
            const safeText = sanitizeLabel(rawText, { maxLen: MAX_SEGMENT_TEXT_CHARS });

            // Always count audio time even if STT is empty.
            active.metrics.totalAudioSeconds += Number(seconds) || 0;
            active.metrics.segmentsTotal += 1;
            active.metrics.lastSttTextLen = rawText.length;
            active.metrics.lastSttSafeTextLen = safeText.length;

            // Mirror last-seen diagnostics across sessions.
            last.lastSegmentWav = wavPath;
            last.lastSegmentSeconds = Number(seconds) || 0;
            last.lastSttTextLen = rawText.length;
            last.lastSttSafeTextLen = safeText.length;

            if (safeText && safeText.trim().length > 0) {
              active.transcripts.push({
                at: new Date().toISOString(),
                user: safeUser,
                seconds,
                text: safeText,
              });

              active.metrics.segmentsOk += 1;
              active.metrics.lastSttOkAt = new Date().toISOString();
              active.metrics.lastNonEmptyTextAt = new Date().toISOString();
              last.nonEmptyTextAt = active.metrics.lastNonEmptyTextAt;

              // Safety: prevent unbounded memory growth on long calls.
              if (active.transcripts.length > MAX_TRANSCRIPT_ITEMS) {
                active.transcripts.splice(0, active.transcripts.length - MAX_TRANSCRIPT_ITEMS);
              }
            } else {
              active.metrics.segmentsEmpty += 1;
              active.metrics.lastSttEmptyAt = new Date().toISOString();
              last.sttEmptyAt = active.metrics.lastSttEmptyAt;
              logger.info('STT empty', {
                user: safeUser,
                seconds: Number(seconds) || 0,
                textLen: rawText.length,
                safeLen: safeText.length,
              });
            }
          } catch (e) {
            active.metrics.sttFailures += 1;
            active.metrics.lastSttFailAt = new Date().toISOString();
            logger.warn('STT failed', e?.message || e);
            await notifySttErrorOnce({ channelName: voiceChannel.name, err: e });
          } finally {
            rmSync(pcmPath, { force: true });
            rmSync(wavPath, { force: true });
          }
        })
        .catch((e) => {
          active.metrics.decodeFailures += 1;
          logger.warn('record pipeline failed', userId, e?.message || e);
        })
        .finally(() => {
          meta.done = true;
          meta.doneAtMs = Date.now();
          active.recordingUsers.delete(userId);
        });

      active.pending.push(job);
    });

    return conn;
  } finally {
    active.joining = false;
  }
}

function channelHumansCount(guild, voiceChannelId) {
  const vc = guild.channels.cache.get(voiceChannelId);
  if (!vc || vc.type !== ChannelType.GuildVoice) return 0;
  return listHumansInChannel(vc).length;
}

function channelIsEmpty(guild, voiceChannelId) {
  return channelHumansCount(guild, voiceChannelId) === 0;
}

function buildRawTranscript({ maxChars } = {}) {
  const lines = active.transcripts
    .map((t) => `[${t.user}] ${t.text}`)
    .join('\n');

  if (!lines) return '(no speech captured)';

  if (Number.isFinite(maxChars) && maxChars > 0 && lines.length > maxChars) {
    // Trim from the start for safety/cost control, but try not to start mid-line.
    const sliceStart = lines.length - maxChars;
    const nextNl = lines.indexOf('\n', sliceStart);
    return (nextNl >= 0 ? lines.slice(nextNl + 1) : lines.slice(-maxChars));
  }

  return lines;
}

function summarizeToBullets(raw, { min = 5, max = 10 } = {}) {
  if (!raw || raw === '(no speech captured)') return ['(нет распознанной речи)'];

  // Split into sentences (very rough, RU/EN mixed ok)
  const text = raw.replace(/\[[^\]]+\]\s*/g, '');
  const sentences = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);

  // Heuristics: boost "decision/next step" cues
  const cues = [
    'решили', 'договор', 'договорились', 'итог', 'итоги', 'значит', 'надо', 'нужно',
    'сделаем', 'делаем', 'давай', 'план', 'следующий', 'next', 'todo', 'задача',
    'fix', 'почин', 'срок', 'today', 'завтра', 'понедельник'
  ];

  function scoreSentence(s) {
    const lower = s.toLowerCase();
    let score = 0;
    // length sweet spot
    if (s.length <= 180) score += 2;
    if (s.length <= 120) score += 2;
    // cue words
    for (const c of cues) {
      if (lower.includes(c)) score += 4;
    }
    // numbers / dates
    if (/[0-9]{1,4}/.test(s)) score += 1;
    // penalize filler
    if (/(ээ+|ну\b|короче|типа|как бы)/.test(lower)) score -= 1;
    return score;
  }

  const ranked = sentences
    .map((s, i) => ({ s, i, score: scoreSentence(s) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const picked = [];
  const used = new Set();
  for (const r of ranked) {
    // dedupe near-identical sentences
    const key = r.s.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    if (used.has(key)) continue;
    used.add(key);
    picked.push(r.s);
    if (picked.length >= max) break;
  }

  // If all scores were low and we picked too little, just take first sentences.
  if (picked.length < min) {
    for (const s of sentences) {
      if (picked.length >= min) break;
      if (!picked.includes(s)) picked.push(s);
    }
  }

  return picked.slice(0, max).map((s) => `• ${s.replace(/\s+/g, ' ')}`);
}

async function finalizeAndSend(guild) {
  // Wait for last audio segments to flush (prefer reliability over speed).
  const pendingAtStart = active.pendingMeta?.filter((p) => !p.done).length || 0;
  const waitStartMs = Date.now();
  const FINALIZE_WAIT_MS = 30_000;
  let waitTimedOut = false;
  try {
    await Promise.race([
      Promise.allSettled(active.pending),
      new Promise((r) => setTimeout(r, FINALIZE_WAIT_MS)),
    ]);
    waitTimedOut = (Date.now() - waitStartMs) >= (FINALIZE_WAIT_MS - 50);
  } catch {
    // ignore
  }
  const pendingAfterWait = active.pendingMeta?.filter((p) => !p.done).length || 0;
  if (pendingAtStart > 0) {
    logger.info('Finalize wait', {
      pendingAtStart,
      pendingAfterWait,
      waitedMs: Date.now() - waitStartMs,
      timedOut: waitTimedOut,
    });
  }

  const vc = guild.channels.cache.get(active.voiceChannelId);
  const channelName = vc?.name || '(unknown)';
  const startedAt = active.startedAt ? active.startedAt.toISOString() : '(unknown)';
  const endedAtIso = new Date().toISOString();
  const participants = [...new Set([...active.participants.values()])].join(', ') || '(none)';

  // Full transcript for saving to disk.
  const raw = buildRawTranscript();

  // Bound transcript size passed to LLM (untrusted STT output; cost/DoS guard)
  const rawForLLM = buildRawTranscript({ maxChars: MAX_TRANSCRIPT_CHARS_FOR_LLM });

  last.finalizeAt = new Date().toISOString();

  // Snapshot last call state for /status after we reset `active`.
  last.call = {
    guildId: active.guildId,
    voiceChannelId: active.voiceChannelId,
    startedAt,
    endedAt: endedAtIso,
    participants: active.participants?.size || 0,
    metrics: { ...(active.metrics || {}) },
    pendingAtFinalizeStart: pendingAtStart,
    pendingAfterWait,
    finalizeWaitMs: Date.now() - waitStartMs,
    finalizeWaitTimedOut: waitTimedOut,
  };
  // Persist transcript to disk
  try {
    const safeName = sanitizeLabel(channelName, { maxLen: 80 }).replace(/[^a-zA-Z0-9а-яА-Я._-]+/g, '_');
    const fs = await import('node:fs');
    const outDir = TRANSCRIPTS_DIR;
    fs.mkdirSync(outDir, { recursive: true });
    const startedStamp = active.startedAt ? active.startedAt.toISOString().replace(/[:]/g, '-') : 'unknown';
    const outPath = `${outDir}/${startedStamp}__${safeName}.txt`;
    const header =
      `Channel: ${channelName}\n` +
      `Started: ${startedAt}\n` +
      `Ended: ${endedAtIso}\n` +
      `Participants: ${participants}\n\n`;
    fs.writeFileSync(outPath, header + raw + '\n', { encoding: 'utf-8' });
    logger.info('Transcript saved', outPath);

    // Retention: prune old local transcripts
    try {
      pruneOldFiles({
        dir: TRANSCRIPTS_DIR,
        maxFiles: TRANSCRIPTS_MAX_FILES,
        maxAgeDays: TRANSCRIPTS_MAX_AGE_DAYS,
        logger,
      });
    } catch (e) {
      logger.warn('Transcript retention prune failed', e?.message || e);
    }
  } catch (e) {
    logger.warn('Failed to save transcript', e?.message || e);
  }

  // If nobody spoke / nothing captured and call was very short, skip spammy messages.
  const durationMs = active.startedAt ? Date.now() - active.startedAt.getTime() : 0;
  if ((raw === '(no speech captured)') && durationMs < SKIP_EMPTY_CALL_UNDER_MS) {
    logger.info('Skipping empty short call notification', sanitizeLabel(channelName), durationMs, { SKIP_EMPTY_CALL_UNDER_MS });
  } else {
    let summaryText = '';
    try {
      summaryText = await summarizeTranscriptWithLLM({
        transcript: rawForLLM,
      });
    } catch (e) {
      logger.warn('LLM summary failed; falling back to heuristics', e?.message || e);
      summaryText =
        '1. Краткое резюме звонка (5–10 пунктов)\n' +
        summarizeToBullets(raw, { min: 5, max: 10 }).join('\n') +
        '\n\n' +
        '2. Принятые решения (если есть)\nРешений не зафиксировано.\n\n' +
        '3. Задачи / To-Do\n(не удалось извлечь автоматически)\n\n' +
        '4. Риски / Блокеры (если обсуждались)\nНет';
    }

    const msg =
      `Discord call summary\n` +
      `Channel: ${channelName}\n` +
      `Started: ${startedAt}\n` +
      `Ended: ${endedAtIso}\n` +
      `Participants: ${participants}\n\n` +
      `${summaryText}`;

    const webhookPayload = {
      channel: channelName,
      startedAt,
      endedAt: endedAtIso,
      participants: participants.split(',').map((s) => s.trim()).filter(Boolean),
      summary: summaryText,
    };

    try {
      await deliverSummary({
        logger,
        telegram: {
          enabled: true,
          token: TELEGRAM_BOT_TOKEN,
          chatId: TELEGRAM_CHAT_ID,
        },
        slack: {
          enabled: Boolean(SLACK_WEBHOOK_URL),
          webhookUrl: SLACK_WEBHOOK_URL,
          channel: SLACK_CHANNEL,
          username: SLACK_USERNAME,
          iconEmoji: SLACK_ICON_EMOJI,
          timeoutMs: SLACK_TIMEOUT_MS,
          maxChars: SLACK_MAX_CHARS,
        },
        webhook: {
          enabled: Boolean(WEBHOOK_URL),
          url: WEBHOOK_URL,
          timeoutMs: WEBHOOK_TIMEOUT_MS,
        },
        text: msg,
        webhookPayload,
      });
      last.summarySentAt = new Date().toISOString();
      // Keep latest ids for convenience
      last.call.guildId = active.guildId;
      last.call.voiceChannelId = active.voiceChannelId;
    } catch (e) {
      logger.warn('Delivery failed (one or more destinations)', e?.message || e);
    }
  }

  // cleanup
  try {
    rmSync(active.recordingsDir, { recursive: true, force: true });
  } catch {}

  active = {
    guildId: null,
    voiceChannelId: null,
    startedAt: null,
    participants: new Map(),
    recordingsDir: null,
    transcripts: [],
    noticeMessageSent: false,
    joining: false,
    finishing: false,
    recordingUsers: new Set(),
    pending: [],
    nonEmptySince: null,
    candidateChannelId: null,
    introPlayed: false,
    introEligibleAt: null,

    manual: false,
    manualGuildId: null,
    manualVoiceChannelId: null,

    metrics: {
      lastSpeechAt: null,
      lastSttOkAt: null,
      lastSttFailAt: null,
      lastFinalizeAt: null,
      lastSummarySentAt: null,
      segmentsOk: 0,
      sttFailures: 0,
      decodeFailures: 0,
      totalAudioSeconds: 0,
    },
  };
}

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      if (GUILD_ID && guild.id !== GUILD_ID) continue;

      if (!active.voiceChannelId) {
        // If manually controlled, do not auto-pick channels.
        if (!active.manual) {
          const vc = pickChannelToRecord(guild);
          if (vc && shouldJoinCandidate(guild, vc)) {
            await ensureJoined(vc).catch((e) => logger.error('Failed to join', e?.message || e));
          }
        }
        continue;
      }

      // Active recording: play intro once there are 2+ humans
      if (active.guildId === guild.id && active.voiceChannelId) {
        const vc = guild.channels.cache.get(active.voiceChannelId);
        const conn = getVoiceConnection(guild.id);
        if (vc && conn && !active.introPlayed) {
          await playIntroIfNeeded(conn, vc);
        }
      }

      // Active recording: wait until empty
      if (active.guildId === guild.id && channelIsEmpty(guild, active.voiceChannelId)) {
        if (active.finishing) continue;
        active.finishing = true;
        logger.info('Voice channel empty; finalizing', active.voiceChannelId);

        // grace period so last speech segments can end cleanly
        const FINALIZE_GRACE_MS = 2000;
        await new Promise((r) => setTimeout(r, FINALIZE_GRACE_MS));

        await finalizeAndSend(guild).catch((e) => logger.error('Finalize failed', e?.message || e));

        const conn = getVoiceConnection(guild.id);
        if (conn) {
          try {
            conn.destroy();
          } catch {}
        }
      }
    }
  } finally {
    tickInFlight = false;
  }
}

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  const commands = [
    {
      name: 'status',
      description: 'Show bot status (recording, queue, last call)'
    },
    {
      name: 'join',
      description: 'Join a specific voice channel (manual mode)',
      options: [
        {
          name: 'channel',
          description: 'Voice channel to join',
          type: 7, // ApplicationCommandOptionType.Channel
          required: true,
          channel_types: [2], // ChannelType.GuildVoice
        },
      ],
    },
    {
      name: 'leave',
      description: 'Leave voice channel and exit manual mode'
    },
    {
      name: 'set_notice_channel',
      description: 'Override notice text channel for this process',
      options: [
        {
          name: 'channel',
          description: 'Text channel for notices',
          type: 7,
          required: true,
          channel_types: [0], // ChannelType.GuildText
        },
      ],
    },
  ];

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    logger.info('Slash commands registered (guild)');
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logger.info('Slash commands registered (global)');
  }
}

client.once('clientReady', async () => {
  logger.info('Bot ready as', client.user?.tag);
  try {
    await registerSlashCommands();
  } catch (e) {
    logger.warn('Failed to register slash commands', e?.message || e);
  }

  setInterval(() => {
    tick().catch((e) => logger.error('tick error', e?.message || e));
  }, 5_000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'status') {
      const started = active.startedAt ? active.startedAt.toISOString() : '(none)';
      const dur = active.startedAt ? Math.round((Date.now() - active.startedAt.getTime()) / 1000) : 0;
      const m = active.metrics || {};
      const health = (() => {
        const sttOk = Number(m.segmentsOk || 0);
        const sttEmpty = Number(m.segmentsEmpty || 0);
        const sttTotal = Number(m.segmentsTotal || 0);
        const sttFail = Number(m.sttFailures || 0);
        const decFail = Number(m.decodeFailures || 0);
        const audio = Number(m.totalAudioSeconds || 0);

        if (sttFail > 0 && sttOk === 0) return 'BAD (STT failing)';
        if (decFail > 0 && sttOk === 0) return 'BAD (decode failing)';
        if (decFail > 0 || sttFail > 0) return 'WARN';

        // Audio is flowing but recognition is consistently empty.
        if (audio > 10 && sttOk === 0 && (sttEmpty > 0 || sttTotal > 0)) return 'WARN (no recognized speech)';

        // Still early or just joined.
        if (dur > 180 && sttOk === 0) return 'WARN (no text yet)';
        return 'OK';
      })();

      const text =
        `Status\n` +
        `health: ${health}\n` +
        `manual: ${active.manual}\n` +
        `guild: ${active.guildId || '(none)'}\n` +
        `voice: ${active.voiceChannelId || '(none)'}\n` +
        `started: ${started}\n` +
        `duration_s: ${dur}\n` +
        `participants: ${active.participants.size}\n` +
        `segments_total: ${active.transcripts.length}\n` +
        `pending_jobs: ${active.pending.length}\n` +
        `pending_not_done: ${active.pendingMeta?.filter((p) => !p.done).length || 0}\n` +
        `\n` +
        `Metrics (active)\n` +
        `lastSpeechAt: ${m.lastSpeechAt || '(none)'}\n` +
        `lastSttOkAt: ${m.lastSttOkAt || '(none)'}\n` +
        `lastSttEmptyAt: ${m.lastSttEmptyAt || '(none)'}\n` +
        `lastSttFailAt: ${m.lastSttFailAt || '(none)'}\n` +
        `lastNonEmptyTextAt: ${m.lastNonEmptyTextAt || '(none)'}\n` +
        `segmentsOk: ${m.segmentsOk || 0}\n` +
        `segmentsEmpty: ${m.segmentsEmpty || 0}\n` +
        `segmentsTotal: ${m.segmentsTotal || 0}\n` +
        `sttFailures: ${m.sttFailures || 0}\n` +
        `decodeFailures: ${m.decodeFailures || 0}\n` +
        `totalAudioSeconds: ${Math.round((m.totalAudioSeconds || 0) * 10) / 10}\n` +
        `lastSegSeconds: ${m.lastSegmentSeconds ?? '(none)'}\n` +
        `lastSegWav: ${m.lastSegmentWav ? String(m.lastSegmentWav).split('/').slice(-2).join('/') : '(none)'}\n` +
        `lastSttTextLen: ${m.lastSttTextLen ?? '(none)'}\n` +
        `lastSttSafeTextLen: ${m.lastSttSafeTextLen ?? '(none)'}\n` +
        `\n` +
        `LastCall (snapshot)\n` +
        `finalizeAt: ${last.finalizeAt || '(none)'}\n` +
        `summarySentAt: ${last.summarySentAt || '(none)'}\n` +
        `guild: ${last.call?.guildId || '(none)'}\n` +
        `voice: ${last.call?.voiceChannelId || '(none)'}\n` +
        `started: ${last.call?.startedAt || '(none)'}\n` +
        `ended: ${last.call?.endedAt || '(none)'}\n` +
        `participants: ${last.call?.participants ?? 0}\n` +
        `pendingAtFinalizeStart: ${last.call?.pendingAtFinalizeStart ?? 0}\n` +
        `pendingAfterWait: ${last.call?.pendingAfterWait ?? 0}\n` +
        `finalizeWaitMs: ${last.call?.finalizeWaitMs ?? 0}\n` +
        `finalizeWaitTimedOut: ${last.call?.finalizeWaitTimedOut ?? false}\n` +
        `segmentsOk: ${last.call?.metrics?.segmentsOk ?? 0}\n` +
        `segmentsEmpty: ${last.call?.metrics?.segmentsEmpty ?? 0}\n` +
        `segmentsTotal: ${last.call?.metrics?.segmentsTotal ?? 0}\n` +
        `sttFailures: ${last.call?.metrics?.sttFailures ?? 0}\n` +
        `decodeFailures: ${last.call?.metrics?.decodeFailures ?? 0}\n` +
        `totalAudioSeconds: ${Math.round(((last.call?.metrics?.totalAudioSeconds) || 0) * 10) / 10}\n` +
        `lastSttOkAt: ${last.call?.metrics?.lastSttOkAt || '(none)'}\n` +
        `lastSttEmptyAt: ${last.call?.metrics?.lastSttEmptyAt || '(none)'}\n` +
        `lastNonEmptyTextAt: ${last.call?.metrics?.lastNonEmptyTextAt || '(none)'}`;
      await interaction.reply({ content: '```\n' + text + '\n```', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'set_notice_channel') {
      const ch = interaction.options.getChannel('channel', true);
      noticeChannelOverrideId = ch?.id || null;
      await interaction.reply({ content: `OK. Notice channel override set to <#${noticeChannelOverrideId}>`, ephemeral: true });
      return;
    }

    if (interaction.commandName === 'leave') {
      const gid = interaction.guildId;
      const conn = gid ? getVoiceConnection(gid) : null;
      if (conn) {
        try { conn.destroy(); } catch {}
      }
      // reset state
      active.guildId = null;
      active.voiceChannelId = null;
      active.startedAt = null;
      active.participants = new Map();
      active.recordingsDir = null;
      active.transcripts = [];
      active.pending = [];
      active.recordingUsers = new Set();
      active.nonEmptySince = null;
      active.candidateChannelId = null;
      active.introPlayed = false;
      active.introEligibleAt = null;
      active.finishing = false;
      active.manual = false;
      active.manualGuildId = null;
      active.manualVoiceChannelId = null;

      active.metrics = {
        lastSpeechAt: null,
        lastSttOkAt: null,
        lastSttEmptyAt: null,
        lastSttFailAt: null,
        lastNonEmptyTextAt: null,

        segmentsOk: 0,
        segmentsEmpty: 0,
        segmentsTotal: 0,

        sttFailures: 0,
        decodeFailures: 0,
        totalAudioSeconds: 0,

        lastSegmentSeconds: null,
        lastSegmentWav: null,
        lastSttTextLen: null,
        lastSttSafeTextLen: null,
      };

      await interaction.reply({ content: 'OK. Left voice channel and cleared manual mode.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'join') {
      const ch = interaction.options.getChannel('channel', true);
      if (!ch || ch.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Please pick a voice channel.', ephemeral: true });
        return;
      }
      const vc = ch;

      active.manual = true;
      active.manualGuildId = vc.guild.id;
      active.manualVoiceChannelId = vc.id;

      await interaction.reply({ content: `OK. Joining ${vc.name} (manual mode).`, ephemeral: true });
      await ensureJoined(vc).catch((e) => logger.error('Manual join failed', e?.message || e));
      return;
    }

    await interaction.reply({ content: 'Unknown command', ephemeral: true });
  } catch (e) {
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: `Error: ${e?.message || e}`, ephemeral: true });
      }
    } catch {}
  }
});

client.on('voiceStateUpdate', () => {
  // Trigger immediate evaluation
  tick().catch((e) => logger.error('voiceStateUpdate tick error', e?.message || e));
});

client.login(DISCORD_TOKEN);
