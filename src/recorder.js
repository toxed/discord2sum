import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';

/**
 * Records a single user's Opus stream to a WAV file (16-bit PCM, 48kHz, stereo).
 * The voice receiver gives Opus frames; we decode to PCM.
 */
export function startUserRecording({ receiver, userId, outDir, minSegmentSeconds = 1.0, logger }) {
  mkdirSync(outDir, { recursive: true });

  const opusStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 2500, // 2.5s of silence ends a segment (more stable)
    },
  });

  // Per-user Discord voice packets are typically mono.
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });

  // We'll write raw PCM for simplicity. (WAV header needs length; we can wrap later with ffmpeg.)
  const segmentPath = join(outDir, `${Date.now()}-${userId}.pcm`);
  const file = createWriteStream(segmentPath);

  let pcmBytes = 0;
  decoder.on('data', (chunk) => {
    pcmBytes += chunk.length;
  });

  const done = (async () => {
    try {
      await pipeline(opusStream, decoder, file);
      // duration in seconds: bytes / (rate * channels * bytesPerSample)
      const seconds = pcmBytes / (48000 * 1 * 2);
      if (seconds < minSegmentSeconds) {
        // too short; ignore
        return { segmentPath: null, seconds };
      }
      return { segmentPath, seconds };
    } catch (e) {
      logger?.warn('record pipeline failed', userId, e?.message || e);
      return { segmentPath: null, seconds: 0 };
    }
  })();

  return { segmentPath, done };
}
