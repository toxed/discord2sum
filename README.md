# discord2sum

`discord2sum` is a small Discord bot that:

- Watches voice activity in a guild and joins the active voice channel
- Auto-joins when people start talking
- Records short speech segments per speaker (locally, in chunks)
- Runs **local STT** (whisper.cpp or faster-whisper)
- When the voice channel becomes empty, sends a **structured summary** to Telegram (optionally also to Slack and/or a generic webhook)

## Privacy / Safety

- **Never commit `.env`**. It contains secrets (Discord/Telegram/OpenAI tokens). This repo ships **only** `.env.example`.
- Audio is processed locally; intermediate audio files are removed after transcription.
- Transcripts may contain sensitive content. Store/share them responsibly.

See: [PRIVACY.md](./PRIVACY.md)

## Requirements

- Node.js 18+
- ffmpeg (this project uses `ffmpeg-static`, system ffmpeg is not required)
- One of:
  - **whisper.cpp** (recommended)
  - **Python faster-whisper** (supported via a command template)

## Quickstart

### Local (npm)

```bash
npm install
cp .env.example .env
# edit .env
npm start
```

### Docker

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
```

### Discord bot

1. Create an app in **Discord Developer Portal**
2. Create a **Bot** and copy its token into `DISCORD_TOKEN`
3. Invite the bot to your server with permissions:
   - View Channels
   - Connect
   - Speak (optional; only needed if you use intro playback)

This bot only needs the `Guilds` and `GuildVoiceStates` intents.

### Telegram

1. Create a Telegram bot via **@BotFather**
2. Put its token into `TELEGRAM_BOT_TOKEN`
3. Set `TELEGRAM_CHAT_ID` to the target user/chat id

## Configuration (env)

Core:

- `DISCORD_TOKEN` (required)
- `DISCORD_GUILD_ID` (optional; restrict to one guild)
- `DISCORD_NOTICE_TEXT_CHANNEL_ID` (optional; where to post status messages)
- `TELEGRAM_BOT_TOKEN` (required)
- `TELEGRAM_CHAT_ID` (required)

Recording:

- `CHUNK_SECONDS` (default: 60)
- `MIN_SEGMENT_SECONDS` (default: 1.0)

Transcripts:

- `TRANSCRIPTS_DIR` (optional; default: `./transcripts`)

Intro playback:

- `INTRO_OPUS_PATH` (optional; default: `./assets/intro.opus`)

## Local STT

### Option A: whisper.cpp

Set:

- `WHISPER_CPP_BIN=/path/to/whisper.cpp/main`
- `WHISPER_CPP_MODEL=/path/to/model.bin`

### Option B: faster-whisper (Python)

Provide a command template in `.env` (the WAV file path is appended as the last argument):

```bash
PY_STT_CMD=./.venv/bin/python ./scripts/transcribe_faster_whisper.py --model medium --language ru
```

## Summarization (LLM)

By default, if `OPENAI_API_KEY` is set, the bot will produce a structured summary using OpenAI.
If it is **not** set, it falls back to a simple extractive bullet summary.

Prompt template:
- `SUMMARY_PROMPT` — file name inside `./prompts` (default: `summary_ru.txt`)

OpenAI:
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `OPENAI_HTTP_TIMEOUT_MS`

Local/remote HTTP LLM (e.g. on another VM / Ollama):
- `LLM_PROVIDER=http`
- `LLM_HTTP_URL` — endpoint that accepts `{prompt, model?}` and returns `{text}`
  - Ollama example: `http://localhost:11434/api/generate` (the bot will send `stream: false` and read `.response`)
- `LLM_MODEL` (optional)
- `LLM_HTTP_TIMEOUT_MS`

## Run

```bash
npm start
```

## How it works (high-level)

- Picks the voice channel with the most non-bot members.
- Joins muted by default.
- Records per-speaker segments; converts PCM → WAV; transcribes; appends to an in-memory transcript.
- When the channel becomes empty, finalizes and sends a Telegram message:
  - channel name
  - start/end timestamps
  - participants who spoke
  - summary

Raw transcripts are saved locally to disk (see `TRANSCRIPTS_DIR`) but are not posted to Telegram.

## systemd (optional)

A template unit file is provided:

- `discord-voice-summarizer.service.example`

Replace placeholders (`REPLACE_ME_*`) and install it as a normal systemd unit.

## Troubleshooting

### Telegram: nothing arrives

- Ensure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set.
- Make sure the bot can message the chat (for groups: add the bot and allow it to post).
- Check logs (`journalctl -u discord-voice-summarizer -n 200 --no-pager`).

### STT: "No STT configured" / no transcript text

- Configure exactly one:
  - `PY_STT_CMD=./.venv/bin/python ./scripts/transcribe_faster_whisper.py ...` (recommended), or
  - `WHISPER_CPP_BIN` + `WHISPER_CPP_MODEL`
- For `PY_STT_CMD`, only `python/python3` is allowed and the script must be `./scripts/transcribe_faster_whisper.py`.

### Discord: bot joins but does not capture speech

- Ensure the bot has permissions to **Connect** (and optionally **Speak** for intro playback).
- Some Discord voice packet/decoder errors may occur; check logs for `record pipeline failed`.

### Keeping transcripts under control (retention)

Transcripts are saved locally to `TRANSCRIPTS_DIR` (default: `./transcripts`).

You can enable automatic pruning:

- `TRANSCRIPTS_MAX_FILES` — keep only newest N transcript files
- `TRANSCRIPTS_MAX_AGE_DAYS` — delete files older than N days

Set both to `0` to disable pruning.

## Optional webhook

You can also deliver minutes as JSON to your own service:

- `WEBHOOK_URL` — target URL
- `WEBHOOK_TIMEOUT_MS` — request timeout

Payload contains: channel, startedAt, endedAt, participants[], summary.

## Optional Slack

Send the same summary text to Slack via an **Incoming Webhook**:

- `SLACK_WEBHOOK_URL`
- `SLACK_CHANNEL` (optional override; otherwise uses webhook default)
- `SLACK_USERNAME` (optional)
- `SLACK_ICON_EMOJI` (optional)
- `SLACK_TIMEOUT_MS`

## Roadmap

- Optional: upload raw transcript as a file to Telegram (disabled by default)
- Better diarization + timestamps
- Multiple simultaneous calls (queue)
