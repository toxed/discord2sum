import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function pruneOldFiles({ dir, maxFiles = 0, maxAgeDays = 0, logger = null } = {}) {
  if (!dir) return;

  const mf = Number(maxFiles) || 0;
  const mad = Number(maxAgeDays) || 0;
  if (mf <= 0 && mad <= 0) return;

  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }

  const now = Date.now();
  const maxAgeMs = mad > 0 ? mad * 24 * 60 * 60_000 : 0;

  const entries = [];
  for (const name of files) {
    if (name === '.gitkeep') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    entries.push({ name, full, mtimeMs: st.mtimeMs, size: st.size });
  }

  // 1) Age-based pruning
  if (maxAgeMs > 0) {
    for (const e of entries) {
      if (now - e.mtimeMs > maxAgeMs) {
        try {
          unlinkSync(e.full);
          logger?.info?.('Pruned old transcript file', { file: e.name, reason: 'age', maxAgeDays: mad });
        } catch (err) {
          logger?.warn?.('Failed to prune old transcript file', { file: e.name, err: err?.message || String(err) });
        }
      }
    }
  }

  // Refresh list after deletions
  const remaining = [];
  for (const e of entries) {
    try {
      const st = statSync(e.full);
      if (st.isFile()) remaining.push({ ...e, mtimeMs: st.mtimeMs });
    } catch {}
  }

  // 2) Count-based pruning: keep newest `maxFiles`
  if (mf > 0 && remaining.length > mf) {
    remaining.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = remaining.slice(mf);
    for (const e of toDelete) {
      try {
        unlinkSync(e.full);
        logger?.info?.('Pruned old transcript file', { file: e.name, reason: 'maxFiles', maxFiles: mf });
      } catch (err) {
        logger?.warn?.('Failed to prune transcript file', { file: e.name, err: err?.message || String(err) });
      }
    }
  }
}
