export function debug(...args: unknown[]) {
  if (process.env.LM_BRIDGE_QUIET) return;
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}]`, ...args);
}

export function error(...args: unknown[]) {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] ERROR:`, ...args);
}
