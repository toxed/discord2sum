# Privacy

## What this bot does

- Joins a Discord voice channel when people are present.
- Captures short per-speaker audio segments from Discord (Opus frames).
- Decodes Opus to PCM locally and converts PCM to WAV.
- Runs speech-to-text (STT) locally (whisper.cpp or faster-whisper via Python).
- Produces a structured summary (LLM optional).
- Sends the summary to Telegram.

## What leaves your server

- **Telegram:** the final summary text.
- **OpenAI (optional):** if `OPENAI_API_KEY` is set, the transcript text (or its capped portion) is sent to OpenAI to generate a summary.

## What is stored on disk

- Temporary audio files (PCM/WAV) are created during processing and then removed.
- Transcripts are saved locally to `TRANSCRIPTS_DIR` (default: `./transcripts`).

## What is NOT sent by default

- Raw transcripts are **not** posted to Telegram by default.

## Recommendations

- Treat `.env` as secret; never commit it.
- If you enable OpenAI summarization, assume transcript text leaves your server.
- Store transcripts on an encrypted disk if they may contain sensitive information.
- Consider a retention policy (rotate/delete old transcripts).
