import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildEntry, cleanModelEntry, listEntries, parseEntry, slugify, validateEntry } from '../lib/entries.mjs';
import { redact } from '../lib/redact.mjs';
import { cronLine, launchdPlist } from '../lib/schedule.mjs';
import { findAgentBin, which } from '../lib/sys.mjs';
import { findChatFile, readMessages } from '../lib/transcripts.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-unit-'));
const writeLines = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

// ---------- redaction ----------

test('redact removes common secrets', () => {
  const secrets = {
    anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
    openai: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    github: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    githubPat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    aws: 'AKIAIOSFODNN7EXAMPLE',
    slack: 'xoxb-123456789012-abcdefghij',
    google: 'AIzaSyA-1234567890abcdefghijklmnopqrstu',
    stripe: 'sk_live_51HabcdefGHIJKLmnop',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  };
  for (const [name, secret] of Object.entries(secrets)) {
    const out = redact(`here is my ${name} key ${secret} ok`);
    assert.ok(!out.includes(secret), `${name} leaked: ${out}`);
    assert.match(out, /\[redacted/);
  }
  const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(block), '[redacted private key]');
  assert.equal(redact('Authorization: Bearer abcdef0123456789abcdef'), 'Authorization: Bearer [redacted]');
  assert.equal(redact('postgres://admin:s3cretpass@db.example.com/app'), 'postgres://admin:[redacted]@db.example.com/app');
  assert.equal(redact('password=hunter2024'), 'password=[redacted]');
  assert.equal(redact('API_KEY: "abc123def456"'), 'API_KEY: [redacted]');
  assert.equal(redact('mail me at jane.doe@example.com'), 'mail me at [email]');
});

test('redact leaves normal prose alone', () => {
  const prose = [
    'password: required for every account',
    'auth is handled by Supabase',
    'the task-force decided to use sk-learn later',
    'We picked weekly streaks because daily ones punish one missed day.',
    'token budget matters more than we thought',
  ];
  for (const line of prose) assert.equal(redact(line), line);
});

// ---------- entries ----------

test('cleanModelEntry strips fences and preambles', () => {
  const entry = '---\ngoal: Ship it\n---\n\n## Decisions\n1. **x**';
  assert.equal(cleanModelEntry('```markdown\n' + entry + '\n```'), entry);
  assert.equal(cleanModelEntry('Here is the entry:\n' + entry), entry);
  assert.equal(cleanModelEntry(entry.replace(/\n/g, '\r\n')), entry);
});

test('validateEntry and buildEntry', () => {
  assert.equal(validateEntry('no header').ok, false);
  assert.equal(validateEntry('---\ngoal: x\n---\nno decisions').ok, false);
  const model = '---\ngoal:   Keep   people coming back\ntags: [Habits, "Motivation"]\nauthor: wrong\n---\n\n## Goal\nx\n\n## Decisions\n1. **Weekly streaks**\n';
  const v = validateEntry(model);
  assert.equal(v.ok, true);
  assert.equal(v.goal, 'Keep   people coming back');
  const built = buildEntry(model, { author: 'alice', date: '2026-11-01', updated: '2026-11-07', chat: 'abc' });
  const { data, body } = parseEntry(built);
  assert.equal(data.author, 'alice');
  assert.equal(data.goal, 'Keep people coming back');
  assert.deepEqual(data.tags, ['habits', 'motivation']);
  assert.equal(data.date, '2026-11-01');
  assert.equal(data.updated, '2026-11-07');
  assert.match(body, /## Decisions/);
});

test('slugify', () => {
  assert.equal(slugify('Get people to open my habit app every day without nagging'), 'get-people-to-open-my-habit-app');
  assert.equal(slugify('!!!'), 'chat');
  assert.equal(slugify("Bob's API: v2 / launch"), 'bob-s-api-v2-launch');
});

test('listEntries reads entries/<person>/*.md and skips READMEs and files without a goal', () => {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, 'entries', 'alice'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'entries', 'README.md'), '# hi');
  fs.writeFileSync(path.join(repo, 'entries', 'alice', 'README.md'), '---\ngoal: no\n---');
  fs.writeFileSync(path.join(repo, 'entries', 'alice', 'notes.md'), 'no header');
  fs.writeFileSync(path.join(repo, 'entries', 'alice', '2026-11-01-a.md'), '---\nauthor: alice\ndate: 2026-11-01\ngoal: Goal A\ntags: [x]\n---\n## Decisions\n');
  const list = listEntries(repo);
  assert.equal(list.length, 1);
  assert.equal(list[0].goal, 'Goal A');
  assert.equal(list[0].file, 'entries/alice/2026-11-01-a.md');
  assert.equal(list[0].folder, 'alice');
});

// ---------- chat files ----------

test('reads a Claude Code chat: user and assistant text only', () => {
  const home = tmp();
  const id = crypto.randomUUID();
  const file = path.join(home, '.claude', 'projects', '-p', `${id}.jsonl`);
  writeLines(file, [
    { type: 'user', timestamp: '2026-11-07T10:00:00Z', message: { role: 'user', content: 'Help me plan <system-reminder>secret stuff</system-reminder>the app' } },
    { type: 'assistant', timestamp: '2026-11-07T10:00:01Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
    { type: 'assistant', timestamp: '2026-11-07T10:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Part one.' }] } },
    { type: 'assistant', timestamp: '2026-11-07T10:00:03Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', timestamp: '2026-11-07T10:00:04Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] } },
    { type: 'assistant', timestamp: '2026-11-07T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Part two.' }] } },
    { type: 'assistant', isSidechain: true, timestamp: '2026-11-07T10:00:06Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } },
    { type: 'user', isMeta: true, timestamp: '2026-11-07T10:00:07Z', message: { role: 'user', content: 'meta' } },
    { type: 'user', timestamp: '2026-11-07T10:00:08Z', message: { role: 'user', content: '<command-message>huddle</command-message>\n<command-name>/huddle</command-name>\n<command-args>connect</command-args>' } },
    { type: 'user', timestamp: '2026-11-07T10:00:09Z', message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout>' } },
    { type: 'summary', summary: 'x' },
  ]);
  fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":"half writ');
  const msgs = readMessages(file, 'claude');
  assert.deepEqual(
    msgs.map((m) => [m.role, m.text]),
    [
      ['user', 'Help me plan the app'],
      ['assistant', 'Part one.\nPart two.'],
      ['user', '/huddle connect'],
    ],
  );
  assert.equal(msgs[1].ts, '2026-11-07T10:00:05Z');
});

test('reads Codex chats in the current and older formats', () => {
  const home = tmp();
  const now = [
    { timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] } },
    { timestamp: 't1', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Fix the bug' }] } } },
    { timestamp: 't2', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Done.' }], phase: 'final_answer' } } },
    { timestamp: 't2', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange' } } },
  ];
  const a = path.join(home, 'a.jsonl');
  writeLines(a, now);
  assert.deepEqual(readMessages(a, 'codex').map((m) => [m.role, m.text]), [['user', 'Fix the bug'], ['assistant', 'Done.']]);

  const older = [
    { timestamp: 't1', type: 'event_msg', payload: { type: 'user_message', message: 'Plan it' } },
    { timestamp: 't2', type: 'event_msg', payload: { type: 'agent_message', message: 'Planned.' } },
  ];
  const b = path.join(home, 'b.jsonl');
  writeLines(b, older);
  assert.deepEqual(readMessages(b, 'codex').map((m) => m.text), ['Plan it', 'Planned.']);

  const oldest = [
    { timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] } },
  ];
  const c = path.join(home, 'c.jsonl');
  writeLines(c, oldest);
  assert.deepEqual(readMessages(c, 'codex').map((m) => m.text), ['Hello', 'Hi']);
});

test('findChatFile uses the session id variables and the marker', () => {
  const home = tmp();
  const claudeId = crypto.randomUUID();
  const codexId = crypto.randomUUID();
  const claudeFile = path.join(home, '.claude', 'projects', '-p', `${claudeId}.jsonl`);
  const codexFile = path.join(home, '.codex', 'sessions', '2026', '11', '07', `rollout-2026-11-07T10-00-00-${codexId}.jsonl`);
  writeLines(claudeFile, [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  writeLines(codexFile, [{ type: 'event_msg', payload: { type: 'user_message', message: 'run huddle connect --marker huddle-ab12cd34' } }]);

  assert.equal(findChatFile({ home, env: { CLAUDE_CODE_SESSION_ID: claudeId } }).file, claudeFile);
  const codex = findChatFile({ home, env: { CODEX_THREAD_ID: codexId } });
  assert.equal(codex.kind, 'codex');
  assert.equal(codex.id, codexId);
  // Codex started from inside Claude Code has both variables: the marker decides.
  const nested = findChatFile({ home, env: { CLAUDE_CODE_SESSION_ID: claudeId, CODEX_THREAD_ID: codexId }, marker: 'huddle-ab12cd34' });
  assert.equal(nested.file, codexFile);
  // No variables at all: a recent file containing the marker is found.
  assert.equal(findChatFile({ home, env: {}, marker: 'huddle-ab12cd34' }).file, codexFile);
  assert.equal(findChatFile({ home, env: {}, marker: 'huddle-nowhere' }), null);
  assert.equal(findChatFile({ home, env: { CLAUDE_CODE_SESSION_ID: 'missing' } }), null);
});

// ---------- schedule ----------

test('launchd plist and cron line', () => {
  const opts = { nodeBin: '/opt/node', script: '/h/.huddle/brain/huddle/huddle.mjs', env: { PATH: '/a:/b', HOME: '/h & co' }, everyMinutes: 30, logFile: '/h/.huddle/logs/sync.log' };
  const plist = launchdPlist(opts);
  assert.match(plist, /<string>com\.huddle\.sync<\/string>/);
  assert.match(plist, /<integer>1800<\/integer>/);
  assert.match(plist, /<string>\/opt\/node<\/string>\s*<string>\/h\/\.huddle\/brain\/huddle\/huddle\.mjs<\/string>\s*<string>sync<\/string>/);
  assert.match(plist, /\/h &amp; co/);
  const cron = cronLine(opts);
  assert.match(cron, /^\*\/30 \* \* \* \* PATH="\/a:\/b" HOME="\/h & co" "\/opt\/node" ".*huddle\.mjs" sync >> ".*sync\.log" 2>&1 # huddle-sync$/);
});

// ---------- finding the agent command ----------

test('findAgentBin falls back to the newest Claude desktop app binary', (t) => {
  const home = tmp();
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, EXEC: process.env.CLAUDE_CODE_EXECPATH };
  process.env.HOME = home;
  process.env.PATH = path.join(home, 'empty');
  delete process.env.CLAUDE_CODE_EXECPATH;
  t.after(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.EXEC) process.env.CLAUDE_CODE_EXECPATH = saved.EXEC;
  });
  if (which('claude')) return t.skip('a system-wide claude is installed');
  assert.equal(findAgentBin('claude'), null);
  const make = (version) => {
    const file = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code', version, 'abc', 'claude.app', 'Contents', 'MacOS', 'claude');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    return file;
  };
  make('2.1.9');
  const newest = make('2.1.10');
  assert.equal(findAgentBin('claude'), newest);
  assert.equal(findAgentBin('codex'), null);
});
