#!/usr/bin/env node
// Huddle: a shared idea memory for friends' coding agents.
//
//   install     set up this computer (skill + scheduled routine)
//   connect     start sharing the current chat
//   disconnect  stop sharing the current chat
//   sync        share connected chats (the routine runs this every 30 minutes)
//   consult     "see what everyone thinks": friends' perspectives for a brief on stdin
//   status      what is set up and connected
//   uninstall   remove the routine, the skill and local settings
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEntry, cleanModelEntry, listEntries, parseEntry, safeName, slugify, validateEntry } from './lib/entries.mjs';
import { askModel } from './lib/llm.mjs';
import { redact } from './lib/redact.mjs';
import { installSchedule, removeSchedule, scheduleInstalled } from './lib/schedule.mjs';
import {
  REPO_DIR,
  SCRIPT_DIR,
  findAgentBin,
  SCRIPT_PATH,
  chatsPath,
  configPath,
  git,
  home,
  huddleHome,
  lockPath,
  log,
  logPath,
  readJson,
  run,
  today,
  which,
  writeJson,
} from './lib/sys.mjs';
import { findChatFile, readMessages } from './lib/transcripts.mjs';

const EVERY_MINUTES = 30;
const DEFAULT_QUIET_MINUTES = 10;
const MAX_CHAT_CHARS = 80_000;
const MAX_MESSAGE_CHARS = 6_000;
const NOT_SET_UP =
  "Huddle isn't set up on this computer yet. Paste the setup prompt (SETUP.md in the shared repo) into your coding agent.";

// ---------- small helpers ----------

function parseArgs(argv) {
  const [cmd = 'help', ...rest] = argv;
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) opts[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) opts[arg.slice(2)] = rest[++i];
    else opts[arg.slice(2)] = true;
  }
  return { cmd, opts, positional };
}

function fail(message) {
  console.log(message);
  process.exitCode = 1;
}

const firstLine = (s) => String(s || '').split('\n').filter(Boolean).slice(-1)[0] || 'unknown error';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const template = (name, vars) =>
  fs.readFileSync(path.join(SCRIPT_DIR, 'prompts', `${name}.md`), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');

function loadConfig() {
  const cfg = readJson(configPath(), null);
  if (!cfg) fail(NOT_SET_UP);
  return cfg;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const chatId = (file) => crypto.createHash('sha256').update(file).digest('hex').slice(0, 10);
const isHuddleCommand = (m) => m.role === 'user' && m.text.length < 120 && /^\/?\$?huddle\b/i.test(m.text.trim());

function preview(chat) {
  const first = readMessages(chat.file, chat.kind).find((m) => m.role === 'user' && !isHuddleCommand(m));
  const text = redact(first ? first.text : '(no messages yet)').replace(/\s+/g, ' ').trim();
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

// ---------- skill ----------

const huddleCommand = (cfg) => `"${cfg.nodeBin}" "${SCRIPT_PATH}"`;

function renderSkill(cfg) {
  return fs.readFileSync(path.join(SCRIPT_DIR, 'skill', 'SKILL.md'), 'utf8').replaceAll('{{HUDDLE}}', huddleCommand(cfg));
}

function skillDirs() {
  const dirs = [];
  if (fs.existsSync(path.join(home(), '.claude'))) dirs.push(path.join(home(), '.claude', 'skills', 'huddle'));
  if (fs.existsSync(path.join(home(), '.codex'))) dirs.push(path.join(home(), '.codex', 'skills', 'huddle'));
  return dirs;
}

// Writes the skill only where it changed, so the routine can keep friends up to date after a git pull.
function installSkill(cfg) {
  const text = renderSkill(cfg);
  const files = [path.join(huddleHome(), 'SKILL.md'), ...skillDirs().map((d) => path.join(d, 'SKILL.md'))];
  for (const file of files) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return files.slice(1);
}

// ---------- install ----------

function parseCommand(value) {
  const s = String(value).trim();
  if (s.startsWith('[')) return JSON.parse(s);
  return s.split(/\s+/);
}

function pickModel(opts, old) {
  const tryOne = (llm) => {
    try {
      const answer = askModel(llm, 'Reply with exactly the word OK and nothing else.', { timeoutMs: 180_000 });
      return /\bOK\b/i.test(answer) ? null : `unexpected answer "${answer.slice(0, 40)}"`;
    } catch (e) {
      return e.message;
    }
  };
  if (opts['llm-cmd']) {
    const [bin, ...args] = parseCommand(opts['llm-cmd']);
    const llm = { kind: 'command', bin, args };
    const problem = tryOne(llm);
    return problem ? { tried: [`${bin}: ${problem}`] } : { llm };
  }
  const preferred = typeof opts.llm === 'string' ? opts.llm : old.llm?.kind;
  const kinds = [...new Set([preferred, 'claude', 'codex'])].filter((k) => k === 'claude' || k === 'codex');
  const tried = [];
  for (const kind of kinds) {
    const bin = findAgentBin(kind);
    if (!bin) {
      tried.push(`${kind}: not installed`);
      continue;
    }
    const model = kind === preferred ? (typeof opts.model === 'string' ? opts.model : old.llm?.model) : undefined;
    const llm = { kind, bin, ...(model ? { model } : {}) };
    const problem = tryOne(llm);
    if (!problem) return { llm };
    tried.push(`${kind}: ${problem}`);
  }
  return { tried };
}

function guessName() {
  if (which('gh')) {
    const r = run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 15_000 });
    if (r.ok && r.out) return r.out;
  }
  const g = git(['config', 'user.name']);
  return (g.ok && g.out) || os.userInfo().username;
}

function scheduleEnv(cfg) {
  const dirs = [cfg.nodeBin, which('git'), cfg.llm.bin, which('gh')].filter(Boolean).map((p) => path.dirname(p));
  const env = {
    PATH: [...new Set([...dirs, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter),
    HOME: home(),
    LANG: 'en_US.UTF-8',
  };
  if (process.env.HUDDLE_HOME) env.HUDDLE_HOME = process.env.HUDDLE_HOME;
  return env;
}

function install(opts) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) return fail(`Huddle needs Node.js 20 or newer (this computer has ${process.version}).`);
  if (!git(['rev-parse', '--git-dir']).ok) return fail(`${REPO_DIR} is not a git clone of the shared repo.`);
  const old = readJson(configPath(), {});

  console.log('Checking that this computer can push to the shared repo...');
  const push = git(['push', '--dry-run', 'origin', 'HEAD'], { timeoutMs: 60_000 });
  if (!push.ok) {
    return fail(
      `Can't push to the shared repo: ${firstLine(push.err)}\n` +
        'Ask the repo owner to add your GitHub account as a collaborator, accept the invite, then run setup again.\n' +
        'If you use the GitHub CLI, also run: gh auth setup-git',
    );
  }

  console.log('Checking which model command works on this computer...');
  const picked = pickModel(opts, old);
  if (!picked.llm) {
    return fail(
      "Couldn't get an answer from Claude Code or Codex on this computer:\n  " +
        picked.tried.join('\n  ') +
        '\nLog in to one of them in a terminal (run `claude` or `codex` once), then run setup again.' +
        '\nIf Codex needs a specific model, add --model <name>.',
    );
  }

  const cfg = {
    version: 1,
    name: safeName(typeof opts.name === 'string' ? opts.name : old.name || guessName()),
    llm: picked.llm,
    nodeBin: which('node') || process.execPath,
    quietMinutes: Number(opts['quiet-minutes'] ?? old.quietMinutes ?? DEFAULT_QUIET_MINUTES),
    installedAt: old.installedAt || new Date().toISOString(),
  };
  writeJson(configPath(), cfg);
  if (!fs.existsSync(chatsPath())) writeJson(chatsPath(), { chats: [] });

  const skillFiles = installSkill(cfg);
  const schedule = opts['no-schedule']
    ? { ok: false, why: 'skipped (--no-schedule)' }
    : installSchedule({ nodeBin: cfg.nodeBin, script: SCRIPT_PATH, env: scheduleEnv(cfg), everyMinutes: EVERY_MINUTES, logFile: logPath() });
  if (schedule.ok) writeJson(configPath(), { ...cfg, schedule: schedule.how });

  const lines = [
    '',
    'Huddle is set up.',
    `  Your name in the repo: ${cfg.name} (entries go in entries/${cfg.name}/)`,
    `  Model: ${cfg.llm.kind}${cfg.llm.model ? ` (${cfg.llm.model})` : ''}`,
    `  Routine: ${schedule.ok ? `every ${EVERY_MINUTES} minutes via ${schedule.how}` : `NOT created: ${schedule.why}`}`,
  ];
  if (skillFiles.length) lines.push(`  Skill installed: ${skillFiles.join(', ')}`);
  else {
    lines.push(
      `  No Claude Code or Codex folder found. The skill is at ${path.join(huddleHome(), 'SKILL.md')}:`,
      "  install it wherever your agent reads skills, or paste it into your agent's instructions.",
    );
  }
  if (!schedule.ok && !opts['no-schedule']) {
    lines.push(`  Create a scheduled routine yourself that runs every ${EVERY_MINUTES} minutes: ${huddleCommand(cfg)} sync`);
  }
  lines.push(
    '',
    'How to use it, in any chat:',
    '  "/huddle connect"            share this chat (its goal and decisions) with your friends',
    '  "see what everyone thinks"   get your friends\' perspectives on what you are working on',
    '  "/huddle status"             see what is connected',
  );
  console.log(lines.join('\n'));
}

// ---------- connect / disconnect ----------

function findThisChat(opts) {
  const chat = findChatFile({ home: home(), marker: typeof opts.marker === 'string' ? opts.marker : undefined });
  if (!chat) fail("I couldn't find this chat's history on this computer. Huddle can connect Claude Code and Codex chats.");
  return chat;
}

function connect(opts) {
  const cfg = loadConfig();
  if (!cfg) return;
  const chat = findThisChat(opts);
  if (!chat) return;
  const state = readJson(chatsPath(), { chats: [] });
  if (state.chats.some((c) => c.file === chat.file)) {
    console.log(`This chat is already connected ("${preview(chat)}").`);
    return;
  }
  state.chats.push({
    id: chatId(chat.file),
    kind: chat.kind,
    file: chat.file,
    connectedAt: new Date().toISOString(),
    syncedUpTo: null,
    syncedCount: 0,
    entry: null,
    status: 'connected, not shared yet',
  });
  writeJson(chatsPath(), state);
  console.log(
    `Connected this chat ("${preview(chat)}").\n` +
      `The routine shares its goal and decisions every ${EVERY_MINUTES} minutes, once the chat has been quiet for ` +
      `${plural(cfg.quietMinutes, 'minute', 'minutes')}. To share it right away, say "huddle sync now".`,
  );
}

function disconnect(opts) {
  if (!loadConfig()) return;
  const chat = findThisChat(opts);
  if (!chat) return;
  const state = readJson(chatsPath(), { chats: [] });
  const found = state.chats.find((c) => c.file === chat.file);
  if (!found) {
    console.log("This chat isn't connected.");
    return;
  }
  state.chats = state.chats.filter((c) => c !== found);
  writeJson(chatsPath(), state);
  console.log(
    'Stopped sharing this chat.' +
      (found.entry ? ` Its entry (${found.entry}) stays in the repo; delete that file if you want it gone.` : ''),
  );
}

// ---------- sync ----------

function takeLock() {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid} ${Date.now()}`, { flag: 'wx' });
      return true;
    } catch {
      const age = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age < 30 * 60 * 1000) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

function formatMessages(messages) {
  const clip = (t) => (t.length > MAX_MESSAGE_CHARS ? `${t.slice(0, MAX_MESSAGE_CHARS)}\n[... message cut ...]` : t);
  const parts = messages.map((m) => `[${m.role}]\n${clip(redact(m.text))}`);
  let total = parts.reduce((n, p) => n + p.length, 0);
  if (total <= MAX_CHAT_CHARS) return parts.join('\n\n');
  // Too long: keep the first message (it usually states the goal) and as much of the end as fits.
  const kept = [];
  total = parts[0].length;
  for (let i = parts.length - 1; i > 0 && total + parts[i].length < MAX_CHAT_CHARS; i--) {
    kept.unshift(parts[i]);
    total += parts[i].length;
  }
  return [parts[0], '[... earlier messages left out ...]', ...kept].join('\n\n');
}

function entryPathFor(name, date, goal) {
  const base = `entries/${name}/${date}-${slugify(goal)}`;
  let rel = `${base}.md`;
  for (let n = 2; fs.existsSync(path.join(REPO_DIR, rel)); n++) rel = `${base}-${n}.md`;
  return rel;
}

function syncChat(cfg, chat, opts) {
  if (!fs.existsSync(chat.file)) {
    chat.status = 'chat file is gone';
    return {};
  }
  const messages = readMessages(chat.file, chat.kind).filter((m) => !isHuddleCommand(m));
  const fresh = messages.filter((m, i) => (m.ts ? !chat.syncedUpTo || m.ts > chat.syncedUpTo : i >= (chat.syncedCount || 0)));
  if (!fresh.length) return {};
  const lastTs = messages[messages.length - 1].ts || chat.syncedUpTo;
  const quietMs = (cfg.quietMinutes ?? DEFAULT_QUIET_MINUTES) * 60_000;
  if (!opts.now && lastTs && Date.now() - Date.parse(lastTs) < quietMs) {
    chat.status = 'waiting for the chat to go quiet';
    return {};
  }

  const entryFile = chat.entry ? path.join(REPO_DIR, chat.entry) : null;
  const existing = entryFile && fs.existsSync(entryFile) ? fs.readFileSync(entryFile, 'utf8') : null;
  const prompt = template('summarize', {
    AUTHOR: cfg.name,
    EXISTING: existing
      ? `Existing entry for this chat (update it):\n<entry>\n${existing.trim()}\n</entry>`
      : 'There is no entry for this chat yet.',
    SCOPE: existing ? 'only the messages since the existing entry was written' : 'the whole chat so far',
    MESSAGES: formatMessages(fresh),
  });

  let answer;
  try {
    answer = askModel(cfg.llm, prompt);
  } catch (e) {
    chat.status = `model error, will retry: ${e.message}`;
    return { note: `model error for one chat: ${e.message}` };
  }
  const done = () => {
    chat.syncedUpTo = lastTs;
    chat.syncedCount = messages.length;
  };
  if (/^\s*SKIP\s*$/i.test(answer)) {
    done();
    chat.status = 'nothing to share yet (no clear goal or decisions)';
    return {};
  }
  const cleaned = redact(cleanModelEntry(answer));
  const check = validateEntry(cleaned);
  if (!check.ok) {
    chat.status = `model gave a malformed entry (${check.reason}), will retry`;
    return { note: chat.status };
  }
  const day = today();
  const date = (existing && parseEntry(existing).data.date) || day;
  const rel = chat.entry && existing ? chat.entry : entryPathFor(cfg.name, date, check.goal);
  fs.mkdirSync(path.dirname(path.join(REPO_DIR, rel)), { recursive: true });
  fs.writeFileSync(path.join(REPO_DIR, rel), buildEntry(cleaned, { author: cfg.name, date, updated: day, chat: chat.id }));
  chat.entry = rel;
  done();
  chat.status = `shared ${new Date().toISOString()}`;
  return { changed: rel };
}

function commitAndPush(cfg, files) {
  if (files.length) {
    git(['add', '--', ...files]);
    const hasEmail = git(['config', 'user.email']).out;
    const identity = hasEmail ? [] : ['-c', `user.name=${cfg.name}`, '-c', `user.email=${cfg.name}@users.noreply.github.com`];
    const msg = `huddle: ${cfg.name} shared ${plural(files.length, 'chat', 'chats')}`;
    const c = git([...identity, 'commit', '--quiet', '-m', msg, '--', ...files]);
    if (!c.ok) return `commit failed: ${firstLine(c.err)}`;
  }
  const ahead = git(['rev-list', '--count', '@{u}..HEAD']);
  if (ahead.ok && ahead.out === '0') return files.length ? 'nothing to push' : 'nothing new';
  let p = git(['push', '--quiet', 'origin', 'HEAD'], { timeoutMs: 90_000 });
  if (!p.ok) {
    git(['pull', '--rebase', '--autostash', '--quiet'], { timeoutMs: 90_000 });
    p = git(['push', '--quiet', 'origin', 'HEAD'], { timeoutMs: 90_000 });
  }
  return p.ok ? 'pushed' : `push failed, will retry next run: ${firstLine(p.err)}`;
}

function sync(opts) {
  const cfg = loadConfig();
  if (!cfg) return;
  if (!takeLock()) {
    console.log('Another sync is already running.');
    return;
  }
  try {
    const notes = [];
    const pull = git(['pull', '--rebase', '--autostash', '--quiet'], { timeoutMs: 90_000 });
    if (!pull.ok) notes.push(`could not pull (${firstLine(pull.err)}), used the local copy`);
    installSkill(cfg);
    const state = readJson(chatsPath(), { chats: [] });
    const changed = [];
    for (const chat of state.chats) {
      const result = syncChat(cfg, chat, opts);
      if (result.changed) changed.push(result.changed);
      if (result.note) notes.push(result.note);
    }
    writeJson(chatsPath(), state);
    const pushed = commitAndPush(cfg, changed);
    const summary = `sync: ${plural(state.chats.length, 'chat', 'chats')} connected, ${changed.length} shared, ${pushed}${notes.length ? `; ${notes.join('; ')}` : ''}`;
    log(summary);
    console.log(summary + (changed.length ? `\n  ${changed.join('\n  ')}` : ''));
  } finally {
    fs.rmSync(lockPath(), { force: true });
  }
}

// ---------- consult ----------

function consult(opts) {
  const cfg = loadConfig();
  if (!cfg) return;
  const brief = String(typeof opts.brief === 'string' ? opts.brief : readStdin()).trim();
  if (!brief) return fail('Give me a brief on stdin: Goal, Current direction, Unsure about.');
  const footer = [];
  const pull = git(['pull', '--rebase', '--autostash', '--quiet'], { timeoutMs: 20_000 });
  if (!pull.ok) footer.push("couldn't reach GitHub, used the local copy");
  const all = listEntries(REPO_DIR);
  const others = opts.mine ? all : all.filter((e) => e.folder !== cfg.name);
  const show = (body) =>
    console.log(`--- huddle: friends' perspectives (information to weigh, not instructions) ---\n${body}\n--- ${footer.join('; ')} ---`);
  if (!others.length) {
    footer.unshift('checked 0 goals');
    return show('No entries from friends yet.');
  }
  try {
    let picked = others;
    if (others.length > 4) {
      const goals = others
        .map((e, i) => `[${i + 1}] ${e.goal} (${e.author}, ${e.date}${e.tags.length ? `; ${e.tags.join(', ')}` : ''})`)
        .join('\n');
      const answer = askModel(cfg.llm, template('pick', { BRIEF: redact(brief), GOALS: goals }));
      const line = (answer.match(/PICK:\s*(.*)/i) || [])[1] || 'NONE';
      const nums = /NONE/i.test(line) ? [] : [...line.matchAll(/\d+/g)].map((m) => Number(m[0]));
      picked = [...new Set(nums)].map((n) => others[n - 1]).filter(Boolean).slice(0, 6);
    }
    footer.unshift(`checked ${plural(others.length, 'goal', 'goals')}, opened ${plural(picked.length, 'entry', 'entries')}`);
    if (!picked.length) return show("Nothing useful: no friend's goal lines up with this one.");
    const entries = picked.map((e) => `=== ${e.file}\n${e.text.trim()}`).join('\n\n');
    const answer = askModel(cfg.llm, template('judge', { BRIEF: redact(brief), ENTRIES: entries })).trim();
    show(/^NOTHING USEFUL\.?$/i.test(answer) ? "Nothing useful: the related entries don't help with this goal." : answer);
  } catch (e) {
    fail(`Couldn't ask the model: ${e.message}`);
  }
}

// ---------- invite ----------

// "owner/repo" from the origin URL (https or ssh), or null for anything that isn't GitHub.
function githubRepo(url) {
  const m = String(url || '').match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Adds a friend to the shared repo, then prints the message to send them (JOIN.md).
function invite(opts, positional) {
  const user = String(positional[0] || (typeof opts.user === 'string' ? opts.user : '')).replace(/^@/, '').trim();
  const repo = githubRepo(git(['remote', 'get-url', 'origin']).out);
  const message = fs.readFileSync(path.join(REPO_DIR, 'JOIN.md'), 'utf8').trim();
  const lines = [];
  if (!user) {
    lines.push('No GitHub username given, so nobody was invited. Message to send a friend you already invited:');
  } else if (!/^[A-Za-z0-9-]{1,39}$/.test(user)) {
    return fail(`"${user}" doesn't look like a GitHub username (letters, digits and dashes).`);
  } else if (!repo) {
    return fail("The shared repo isn't on GitHub, so I can't invite anyone automatically.");
  } else if (!which('gh')) {
    lines.push(
      "The GitHub CLI (gh) isn't installed, so I couldn't send the invite. Invite them on GitHub:",
      `  https://github.com/${repo}/settings/access -> Add people -> ${user}`,
      '',
      'Then send them this message:',
    );
  } else {
    const r = run('gh', ['api', '-X', 'PUT', `repos/${repo}/collaborators/${user}`, '-f', 'permission=push'], { timeoutMs: 30_000 });
    if (!r.ok) {
      return fail(
        `Couldn't invite ${user}: ${firstLine(r.err || r.out)}\n` +
          `Check the username, and that you're logged in to gh as the repo's owner (gh auth status).\n` +
          `Or invite them on GitHub: https://github.com/${repo}/settings/access`,
      );
    }
    lines.push(
      r.out ? `Invited ${user} to ${repo}. GitHub emails them the invite.` : `${user} already has access to ${repo}.`,
      '',
      'Send them this message:',
    );
  }
  console.log([...lines, '', message].join('\n'));
}

// ---------- status / uninstall / help ----------

function status() {
  const cfg = loadConfig();
  if (!cfg) return;
  const remote = git(['remote', 'get-url', 'origin']).out;
  const state = readJson(chatsPath(), { chats: [] });
  const logLines = fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8').trim().split('\n') : [];
  const lastSync = [...logLines].reverse().find((l) => / sync: /.test(l));
  const counts = {};
  for (const e of listEntries(REPO_DIR)) counts[e.folder] = (counts[e.folder] || 0) + 1;
  const lines = [
    'Huddle on this computer',
    `  name: ${cfg.name}`,
    `  shared repo: ${remote} (local copy: ${REPO_DIR})`,
    `  model: ${cfg.llm.kind}${cfg.llm.model ? ` (${cfg.llm.model})` : ''}`,
    `  routine: ${scheduleInstalled() ? `installed, every ${EVERY_MINUTES} minutes` : 'NOT installed'}`,
    `  last sync: ${lastSync || 'never'}`,
    `Connected chats (${state.chats.length}):`,
    ...state.chats.map(
      (c) => `  - "${fs.existsSync(c.file) ? preview(c) : '(file gone)'}" [${c.kind}]: ${c.status || ''}${c.entry ? ` -> ${c.entry}` : ''}`,
    ),
    `Entries in the repo: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet'}`,
  ];
  console.log(lines.join('\n'));
}

function uninstall() {
  if (readJson(configPath(), {}).schedule) removeSchedule();
  for (const dir of skillDirs()) {
    const file = path.join(dir, 'SKILL.md');
    if (fs.existsSync(file) && /name:\s*huddle/.test(fs.readFileSync(file, 'utf8'))) fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const f of [configPath(), chatsPath(), lockPath(), path.join(huddleHome(), 'SKILL.md')]) fs.rmSync(f, { force: true });
  fs.rmSync(path.dirname(logPath()), { recursive: true, force: true });
  console.log(
    'Removed the routine, the skill and Huddle settings. Your entries stay in the shared repo.\n' +
      `The local copy of the repo is still at ${REPO_DIR}; delete it if you like.`,
  );
}

function help() {
  console.log(`Huddle: a shared idea memory for friends' coding agents.

  node huddle.mjs install [--llm claude|codex] [--model NAME] [--name NAME] [--llm-cmd "CMD"] [--no-schedule]
  node huddle.mjs connect [--marker TEXT]      share the current chat
  node huddle.mjs disconnect [--marker TEXT]   stop sharing the current chat
  node huddle.mjs sync [--now]                 share connected chats (the routine runs this)
  node huddle.mjs consult < brief.txt          friends' perspectives for a brief
  node huddle.mjs invite GITHUB_USERNAME       add a friend to the repo and print the message to send them
  node huddle.mjs status
  node huddle.mjs uninstall`);
}

const commands = { install, connect, disconnect, sync, consult, invite, status, uninstall, help };
const { cmd, opts, positional } = parseArgs(process.argv.slice(2));
(commands[cmd] || help)(opts, positional);
