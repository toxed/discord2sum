import { resolve, sep } from 'node:path';

export function clampNumber(name, value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (typeof min === 'number' && n < min) return min;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

export function sanitizeLabel(input, { maxLen = 80 } = {}) {
  const s = String(input ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();

  // Keep it single-line for logs/filenames; replace newlines/tabs.
  const oneLine = s.replace(/[\n\t]+/g, ' ');

  // Collapse whitespace
  const compact = oneLine.replace(/\s+/g, ' ');

  if (compact.length <= maxLen) return compact;
  return compact.slice(0, maxLen - 1) + '…';
}

export function safePathWithinCwd(p, { cwd = process.cwd(), allowAbsolute = false } = {}) {
  if (!p) return null;
  const resolved = resolve(cwd, p);

  // If user provided an absolute path, `resolve(cwd, abs)` returns abs.
  // We only allow it when explicitly enabled.
  const isAbsoluteProvided = resolve(p) === p;
  if (isAbsoluteProvided && !allowAbsolute) {
    throw new Error('Absolute paths are not allowed for this setting');
  }

  const cwdResolved = resolve(cwd);
  const prefix = cwdResolved.endsWith(sep) ? cwdResolved : cwdResolved + sep;
  if (resolved !== cwdResolved && !resolved.startsWith(prefix)) {
    throw new Error('Path must stay within the project directory');
  }

  return resolved;
}
