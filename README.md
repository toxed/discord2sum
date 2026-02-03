# discord2sum

`discord2sum` is a small Discord bot that:

- Watches voice channels in a guild
- Auto-joins when people start talking
- Records short speech segments per speaker (locally, in chunks)
- Runs **local STT** (whisper.cpp or faster-whisper)
- When the voice channel becomes empty, sends a **structured summary** to Telegram

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

If `OPENAI_API_KEY` is set, the bot will produce a structured summary using OpenAI.
If it is **not** set, it falls back to a simple extractive bullet summary.

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `SUMMARY_PROMPT_LANG=ru|en`
- `SUMMARY_PROMPT_FILE_RU` (default: `prompts/summary_ru.txt`)
- `SUMMARY_PROMPT_FILE_EN` (default: `prompts/summary_en.txt`)

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

## Roadmap

- (Optional) Upload raw transcript as a file to Telegram (disabled by default)
- Better diarization + timestamps
- Support multiple simultaneous calls (queue)
