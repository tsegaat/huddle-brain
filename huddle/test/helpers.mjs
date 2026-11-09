// Test helpers: a fake GitHub remote (a bare git repo) and fake friends, each with their own HOME.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const AGENT_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_PID',
  'CODEX_THREAD_ID',
  'CODEX_CI',
  'HUDDLE_HOME',
];

export function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of AGENT_VARS) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

const ID = ['-c', 'user.name=seed', '-c', 'user.email=seed@example.com'];
const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-test-'));
  const bare = path.join(root, 'remote.git');
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(path.join(seed, 'entries'), { recursive: true });
  fs.cpSync(path.join(SOURCE_REPO, 'huddle'), path.join(seed, 'huddle'), { recursive: true });
  fs.copyFileSync(path.join(SOURCE_REPO, 'JOIN.md'), path.join(seed, 'JOIN.md'));
  fs.writeFileSync(path.join(seed, 'entries', 'README.md'), '# entries\n');
  sh('git', ['init', '-q', '-b', 'main'], { cwd: seed });
  sh('git', ['add', '-A'], { cwd: seed });
  sh('git', [...ID, 'commit', '-q', '-m', 'seed'], { cwd: seed });
  sh('git', ['remote', 'add', 'origin', bare], { cwd: seed });
  sh('git', ['push', '-q', 'origin', 'main'], { cwd: seed });
  const world = {
    root,
    bare,
    friend: (name) => makeFriend(world, name),
    remoteFiles: () => sh('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).stdout.split('\n').filter((f) => f.startsWith('entries/')),
    remoteFile: (file) => sh('git', ['--git-dir', bare, 'show', `main:${file}`]).stdout,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  return world;
}

function makeFriend(world, name) {
  const home = path.join(world.root, name);
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const brain = path.join(home, '.huddle', 'brain');
  sh('git', ['clone', '-q', world.bare, brain]);
  const script = path.join(brain, 'huddle', 'huddle.mjs');
  const fakeLlm = path.join(brain, 'huddle', 'test', 'fake-llm.mjs');
  const llmLog = path.join(home, 'llm-calls.log');
  const env = (extra) => baseEnv({ HOME: home, FAKE_LLM_LOG: llmLog, ...extra });
  const claudeDir = path.join(home, '.claude', 'projects', '-tmp-project');

  const claudeLine = (id, m) => {
    const base = { sessionId: id, cwd: '/tmp/project', isSidechain: false, timestamp: iso(m.minutesAgo ?? 30) };
    return m.role === 'user'
      ? { ...base, type: 'user', message: { role: 'user', content: m.text } }
      : { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: m.text }] } };
  };

  return {
    name,
    home,
    brain,
    script,
    run(args, { env: extra, input } = {}) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: env(extra), input, cwd: home });
      return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    },
    runAsync(args, { env: extra } = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [script, ...args], { env: env(extra), cwd: home });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ code, out }));
      });
    },
    install(extra = []) {
      return this.run(['install', '--name', name, '--llm-cmd', `${process.execPath} ${fakeLlm}`, '--no-schedule', ...extra]);
    },
    llmCalls() {
      return fs.existsSync(llmLog) ? fs.readFileSync(llmLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    },
    config() {
      return JSON.parse(fs.readFileSync(path.join(home, '.huddle', 'config.json'), 'utf8'));
    },
    chats() {
      return JSON.parse(fs.readFileSync(path.join(home, '.huddle', 'chats.json'), 'utf8')).chats;
    },
    // A Claude Code chat file, with some noise the reader must skip.
    writeClaudeChat(messages, id = crypto.randomUUID()) {
      fs.mkdirSync(claudeDir, { recursive: true });
      const noise = [
        { type: 'assistant', sessionId: id, timestamp: iso(40), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
        { type: 'user', sessionId: id, timestamp: iso(40), message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOL OUTPUT' }] } },
        { type: 'assistant', sessionId: id, isSidechain: true, timestamp: iso(40), message: { role: 'assistant', content: [{ type: 'text', text: 'SUBAGENT TEXT' }] } },
      ];
      const lines = [...noise, ...messages.map((m) => claudeLine(id, m))];
      fs.writeFileSync(path.join(claudeDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return id;
    },
    appendClaudeChat(id, messages) {
      fs.appendFileSync(path.join(claudeDir, `${id}.jsonl`), messages.map((m) => JSON.stringify(claudeLine(id, m))).join('\n') + '\n');
    },
    // A Codex chat file in the current format (item_completed events).
    writeCodexChat(messages, id = crypto.randomUUID()) {
      const dir = path.join(home, '.codex', 'sessions', '2026', '11', '07');
      fs.mkdirSync(dir, { recursive: true });
      const lines = [
        { timestamp: iso(60), type: 'session_meta', payload: { session_id: id, cwd: '/tmp/project' } },
        { timestamp: iso(60), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
        ...messages.map((m) => ({
          timestamp: iso(m.minutesAgo ?? 30),
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: m.role === 'user' ? { type: 'UserMessage', content: [{ type: 'text', text: m.text }] } : { type: 'AgentMessage', content: [{ type: 'Text', text: m.text }] },
          },
        })),
      ];
      fs.writeFileSync(path.join(dir, `rollout-2026-11-07T10-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return id;
    },
  };
}
