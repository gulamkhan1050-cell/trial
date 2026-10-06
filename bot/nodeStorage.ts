import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * A file-backed localStorage for running the bot under Node (e.g. Termux on a phone): the engine's
 * champions and the live grid's snapshot survive restarts exactly as they do in the app.
 * Import this before anything from src/.
 */

export const STATE_FILE = process.env.BOT_STATE ?? 'bot-state.json';

const data: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8') || '{}') : {};
let pending: ReturnType<typeof setTimeout> | null = null;

export function flushStorage() {
  if (pending) clearTimeout(pending);
  pending = null;
  // Write-then-rename, so a phone dying mid-write never leaves a half-written state file.
  writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(data));
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

const schedule = () => (pending ??= setTimeout(flushStorage, 2000));

(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => data[k] ?? null,
  setItem: (k: string, v: string) => {
    data[k] = String(v);
    schedule();
  },
  removeItem: (k: string) => {
    delete data[k];
    schedule();
  },
  clear: () => {
    for (const k of Object.keys(data)) delete data[k];
    schedule();
  },
  key: (i: number) => Object.keys(data)[i] ?? null,
  get length() {
    return Object.keys(data).length;
  },
};
