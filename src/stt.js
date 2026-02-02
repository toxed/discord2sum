import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parse as shellParse } from 'shell-quote';

function run(cmd, args, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';

    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`STT command timeout after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d.toString('utf-8')));
    child.stderr.on('data', (d) => (err += d.toString('utf-8')));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) {
        reject(new Error(`STT command failed (code=${code}): ${cmd} ${args.join(' ')}\n${err.slice(0, 4000)}`));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

/**
 * Transcribe with whisper.cpp if configured.
 * Returns plain text.
 */
function parsePyCmd(cmdline) {
  const tokens = shellParse(cmdline);

  // Reject any non-string tokens (operators, env assignments, etc.)
  // shell-quote returns objects for things like { op: '|' }
  for (const t of tokens) {
    if (typeof t !== 'string') {
      throw new Error('PY_STT_CMD must be a simple command without shell operators');
    }
  }

  const parts = tokens.filter((t) => t.length > 0);
  if (!parts.length) throw new Error('PY_STT_CMD is empty');

  const cmd = parts[0];
  const args = parts.slice(1);

  // Max-safety allowlist:
  // 1) Only allow python executables
  const base = basename(cmd);
  const isPython = /^python(\d+(\.\d+)?)?$/.test(base);
  if (!isPython) {
    throw new Error(`PY_STT_CMD command must be python (got: ${cmd})`);
  }

  // 2) Require our bundled transcriber script as the first positional arg.
  //    (So env can't point to arbitrary python scripts.)
  if (!args.length) {
    throw new Error('PY_STT_CMD must include scripts/transcribe_faster_whisper.py');
  }

  const scriptArg = args[0];
  const resolvedScript = resolve(process.cwd(), scriptArg);
  const allowedScript = resolve(process.cwd(), 'scripts', 'transcribe_faster_whisper.py');
  if (resolvedScript !== allowedScript) {
    throw new Error(`PY_STT_CMD script must be ./scripts/transcribe_faster_whisper.py (got: ${scriptArg})`);
  }

  // Extra: block obvious shell metacharacters even though we don't use a shell.
  // This prevents surprising configs and keeps the safety guarantee tight.
  const bad = /[;&|<>`$]/;
  if (bad.test(cmdline)) {
    throw new Error('PY_STT_CMD must not contain shell metacharacters');
  }

  return { cmd, args };
}

export async function transcribeFile({ filePath, whisperCppBin, whisperCppModel, pyCmdTemplate }) {
  if (pyCmdTemplate) {
    const { cmd, args } = parsePyCmd(pyCmdTemplate);
    const finalArgs = [...args, filePath];
    const { stdout } = await run(cmd, finalArgs);
    return stdout.trim();
  }

  if (!whisperCppBin || !whisperCppModel) {
    throw new Error('No STT configured. Set PY_STT_CMD or WHISPER_CPP_BIN+WHISPER_CPP_MODEL');
  }

  // whisper.cpp writes output files; use a temp dir.
  const dir = mkdtempSync(join(tmpdir(), 'whispercpp-'));
  try {
    // We ask it to output text only.
    // NOTE: flags may vary by version; user may need to adjust.
    const args = [
      '-m', whisperCppModel,
      '-f', filePath,
      '-otxt',
      '-of', join(dir, 'out'),
      '-nt',
    ];
    await run(whisperCppBin, args);
    const fs = await import('node:fs');
    const txt = fs.readFileSync(join(dir, 'out.txt'), 'utf-8');
    return txt.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
