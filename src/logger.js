const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export function makeLogger(level = 'info') {
  const base = levels[level] ?? levels.info;
  const log = (lvl, ...args) => {
    if ((levels[lvl] ?? 999) < base) return;
    const ts = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`[${ts}] ${lvl.toUpperCase()}:`, ...args);
  };
  return {
    debug: (...a) => log('debug', ...a),
    info: (...a) => log('info', ...a),
    warn: (...a) => log('warn', ...a),
    error: (...a) => log('error', ...a),
  };
}
