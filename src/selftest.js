import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(cmd, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout after ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);

    child.stderr.on('data', (d) => (err += d.toString('utf-8')));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`command failed code=${code}: ${cmd}\n${err.slice(0, 1000)}`));
      resolve();
    });
  });
}

export async function runSttSelfTest({ transcribeFile, whisperCppBin, whisperCppModel, pyCmdTemplate, logger }) {
  const dir = mkdtempSync(join(tmpdir(), 'discord2sum-selftest-'));
  const wavPath = join(dir, 'silence.wav');

  try {
    // Generate a short silent WAV (48kHz mono) so STT can run end-to-end.
    await run(ffmpegPath, [
      '-f', 'lavfi',
      '-i', 'anullsrc=r=48000:cl=mono',
      '-t', '1',
      '-ac', '1',
      '-ar', '48000',
      '-y',
      wavPath,
    ], { timeoutMs: 30_000 });

    const text = await transcribeFile({
      filePath: wavPath,
      whisperCppBin,
      whisperCppModel,
      pyCmdTemplate,
    });

    // Text may be empty; success is "no exception".
    logger?.info?.('STT self-test OK', { resultLen: (text || '').length });
    return true;
  } catch (e) {
    logger?.error?.('STT self-test FAILED', e?.message || e);
    return false;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
