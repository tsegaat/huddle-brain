// Small helpers for paths, JSON files and running other programs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(SCRIPT_DIR, '..');
export const SCRIPT_PATH = path.join(SCRIPT_DIR, 'huddle.mjs');

export const home = () => os.homedir();
export const huddleHome = () => process.env.HUDDLE_HOME || path.join(home(), '.huddle');
export const configPath = () => path.join(huddleHome(), 'config.json');
export const chatsPath = () => path.join(huddleHome(), 'chats.json');
export const logPath = () => path.join(huddleHome(), 'logs', 'sync.log');
export const lockPath = () => path.join(huddleHome(), 'sync.lock');

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file, then rename, so a crash never leaves half a file.
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function run(cmd, args, { cwd, input, timeoutMs = 60_000, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    env: env || process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return {
    ok: r.status === 0 && !r.error,
    out: (r.stdout || '').trim(),
    err: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (r.stderr || '').trim() || (r.error ? r.error.message : ''),
  };
}

// Find a program on PATH (plus the usual install folders, for when PATH is thin).
export function which(bin) {
  if (path.isAbsolute(bin)) return isExecutable(bin) ? bin : null;
  const extra = [path.join(home(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extra].filter(Boolean);
  const names = process.platform === 'win32' ? [bin, `${bin}.cmd`, `${bin}.exe`] : [bin];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function git(args, { timeoutMs = 60_000 } = {}) {
  return run('git', ['-C', REPO_DIR, ...args], {
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export function log(line) {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
