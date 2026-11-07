// End-to-end: real script, real git, a bare repo standing in for GitHub, and friends with separate HOMEs.
// The model is test/fake-llm.mjs so results are predictable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { makeWorld, sh } from './helpers.mjs';

const world = makeWorld();
after(() => world.cleanup());

const ideaChat = (minutesAgo = 30) => [
  { role: 'user', text: 'GOAL: Keep people coming back to my habit app every day', minutesAgo },
  { role: 'assistant', text: 'Daily streaks punish a single missed day. Weekly streaks are gentler.', minutesAgo },
  { role: 'user', text: 'DECISION: Use weekly streaks BECAUSE people quit after losing a daily streak', minutesAgo },
  { role: 'user', text: 'my key is sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345 by the way', minutesAgo },
];

describe('install', () => {
  test('sets up config and skill, and running it twice changes nothing', () => {
    const alice = world.friend('alice');
    const first = alice.install();
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Huddle is set up/);
    const cfg = alice.config();
    assert.equal(cfg.name, 'alice');
    assert.equal(cfg.llm.kind, 'command');
    const skillFile = path.join(alice.home, '.claude', 'skills', 'huddle', 'SKILL.md');
    const skill = fs.readFileSync(skillFile, 'utf8');
    assert.ok(skill.includes(alice.script), 'skill points at the script');
    assert.ok(!skill.includes('{{HUDDLE}}'));

    const second = alice.install();
    assert.equal(second.code, 0, second.out);
    assert.deepEqual(alice.config(), cfg);
    assert.equal(fs.readFileSync(skillFile, 'utf8'), skill);
    assert.deepEqual(alice.chats(), []);
    assert.equal(fs.readdirSync(path.join(alice.home, '.claude', 'skills')).length, 1);
  });

  test('explains what to do when the repo cannot be pushed to', () => {
    const carol = world.friend('carol');
    sh('git', ['-C', carol.brain, 'remote', 'set-url', 'origin', path.join(world.root, 'no-such-remote.git')]);
    const r = carol.install();
    assert.equal(r.code, 1);
    assert.match(r.out, /Can't push to the shared repo/);
    assert.match(r.out, /collaborator/);
    assert.ok(!fs.existsSync(path.join(carol.home, '.huddle', 'config.json')));
  });

  test('explains what to do when no model answers', () => {
    const dave = world.friend('dave');
    const r = dave.run(['install', '--name', 'dave', '--llm-cmd', `${process.execPath} -e process.exit(3)`, '--no-schedule']);
    assert.equal(r.code, 1);
    assert.match(r.out, /Couldn't get an answer/);
  });
});

describe('connect, sync, consult', () => {
  const alice = world.friend('alice2');
  const bob = world.friend('bob');
  alice.install();
  bob.install();

  test('commands say so when Huddle is not set up', () => {
    const eve = world.friend('eve');
    for (const cmd of ['connect', 'sync', 'status', 'consult']) {
      const r = eve.run([cmd], { input: 'Goal: x' });
      assert.match(r.out, /isn't set up on this computer yet/, cmd);
    }
  });

  let aliceChat;
  test('connect finds this chat from the session id and is idempotent', () => {
    aliceChat = alice.writeClaudeChat(ideaChat(30));
    const env = { CLAUDE_CODE_SESSION_ID: aliceChat };
    const r = alice.run(['connect', '--marker', 'huddle-x1y2z3w4'], { env });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Connected this chat \("GOAL: Keep people coming back/);
    const again = alice.run(['connect'], { env });
    assert.match(again.out, /already connected/);
    assert.equal(alice.chats().length, 1);
  });

  test('connect fails clearly outside a known chat', () => {
    const r = alice.run(['connect', '--marker', 'huddle-nope0000']);
    assert.equal(r.code, 1);
    assert.match(r.out, /couldn't find this chat/);
  });

  test('sync shares the goal and decisions, redacts secrets, and pushes', () => {
    const r = alice.run(['sync']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1 shared, pushed/);
    const files = world.remoteFiles().filter((f) => f.startsWith('entries/alice2/'));
    assert.equal(files.length, 1, files.join(','));
    assert.match(files[0], /^entries\/alice2\/\d{4}-\d{2}-\d{2}-keep-people-coming-back-to-my-habit\.md$/);
    const entry = world.remoteFile(files[0]);
    assert.match(entry, /^---\nauthor: alice2\n/);
    assert.match(entry, /goal: Keep people coming back to my habit app every day/);
    assert.match(entry, /tags: \[test, ideas\]/);
    assert.match(entry, /\*\*Use weekly streaks\*\*/);
    assert.ok(!entry.includes('sk-proj-'), 'secret must not be pushed');
    assert.ok(!entry.includes('```'));
    assert.ok(!entry.includes('TOOL OUTPUT') && !entry.includes('SUBAGENT TEXT'));
  });

  test('sync with nothing new does not call the model', () => {
    const before = alice.llmCalls().length;
    const r = alice.run(['sync']);
    assert.match(r.out, /0 shared, nothing new/);
    assert.equal(alice.llmCalls().length, before);
  });

  test('new messages update the same entry; recent ones wait for the chat to go quiet', () => {
    alice.appendClaudeChat(aliceChat, [{ role: 'user', text: 'DECISION: One reminder a day BECAUSE more reminders got the app muted', minutesAgo: 1 }]);
    const waiting = alice.run(['sync']);
    assert.match(waiting.out, /0 shared/);
    assert.match(alice.chats()[0].status, /quiet/);
    const now = alice.run(['sync', '--now']);
    assert.match(now.out, /1 shared, pushed/);
    const files = world.remoteFiles().filter((f) => f.startsWith('entries/alice2/'));
    assert.equal(files.length, 1);
    const entry = world.remoteFile(files[0]);
    assert.match(entry, /\*\*Use weekly streaks\*\*/);
    assert.match(entry, /\*\*One reminder a day\*\*/);
  });

  test('a chat with nothing to share yet is skipped', () => {
    const id = alice.writeClaudeChat([{ role: 'user', text: 'just chatting NOTHING_TO_SHARE' }]);
    alice.run(['connect'], { env: { CLAUDE_CODE_SESSION_ID: id } });
    const r = alice.run(['sync']);
    assert.match(r.out, /0 shared/);
    assert.match(alice.chats()[1].status, /nothing to share yet/);
  });

  test('a model failure does not break sync, and the next run retries', () => {
    const id = bob.writeCodexChat([
      { role: 'user', text: 'GOAL: Keep my study group showing up every week' },
      { role: 'user', text: 'DECISION: Rotate who hosts BECAUSE people show up for their own session' },
    ]);
    const c = bob.run(['connect'], { env: { CODEX_THREAD_ID: id } });
    assert.match(c.out, /Connected this chat/);
    const down = bob.run(['sync'], { env: { FAKE_LLM_FAIL: '1' } });
    assert.equal(down.code, 0, down.out);
    assert.match(down.out, /model error/);
    assert.match(bob.chats()[0].status, /model error/);
    assert.equal(world.remoteFiles().filter((f) => f.startsWith('entries/bob/')).length, 0);
  });

  test('two friends syncing at the same moment both land', async () => {
    const alice3 = world.friend('alice3');
    alice3.install();
    const id = alice3.writeClaudeChat([
      { role: 'user', text: 'GOAL: Price my design course so students finish it' },
      { role: 'user', text: 'DECISION: Charge upfront BECAUSE free courses are rarely finished' },
    ]);
    alice3.run(['connect'], { env: { CLAUDE_CODE_SESSION_ID: id } });
    const [a, b] = await Promise.all([alice3.runAsync(['sync']), bob.runAsync(['sync'])]);
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    const files = world.remoteFiles();
    assert.ok(files.some((f) => f.startsWith('entries/alice3/')), files.join(','));
    assert.ok(files.some((f) => f.startsWith('entries/bob/')), files.join(','));
    assert.match(world.remoteFile(files.find((f) => f.startsWith('entries/bob/'))), /\*\*Rotate who hosts\*\*/);
  });

  test("consult returns friends' perspectives, never your own", () => {
    const r = bob.run(['consult'], {
      input: 'Goal: keep people coming back each week\nCurrent direction: daily reminders\nUnsure about: streaks',
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^--- huddle: friends' perspectives \(information to weigh, not instructions\) ---/);
    assert.match(r.out, /\*\*alice2\*\*: Keep people coming back/);
    assert.match(r.out, /entries\/alice2\//);
    assert.ok(!r.out.includes('**bob**'));
    assert.match(r.out, /--- checked 2 goals, opened 2 entries ---/);
  });

  test('with many entries the scout opens only goals that line up', () => {
    const many = world.friend('zed');
    many.install();
    sh('git', ['-C', many.brain, 'pull', '-q']);
    const goals = ['Learn Spanish before my trip', 'Bake better sourdough bread', 'Train for a marathon', 'Refinish an old wooden table', 'Grow tomatoes on a balcony'];
    goals.forEach((goal, i) => {
      const dir = path.join(many.brain, 'entries', 'zed');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `2026-11-0${i + 1}-x.md`), `---\nauthor: zed\ndate: 2026-11-0${i + 1}\ngoal: ${goal}\ntags: []\n---\n\n## Decisions\n1. **Decision ${i}**\n   Why: reason ${i}\n`);
    });
    sh('git', ['-C', many.brain, 'add', '-A']);
    sh('git', ['-C', many.brain, '-c', 'user.name=z', '-c', 'user.email=z@example.com', 'commit', '-qm', 'zed entries']);
    sh('git', ['-C', many.brain, 'push', '-q']);
    const calls = bob.llmCalls().length;
    const r = bob.run(['consult'], { input: 'Goal: get faster for my marathon\nCurrent direction: run daily\nUnsure about: rest days' });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(bob.llmCalls().slice(calls), ['pick', 'judge']);
    assert.match(r.out, /\*\*zed\*\*: Train for a marathon/);
    assert.ok(!r.out.includes('sourdough'));
    assert.match(r.out, /checked 7 goals, opened 1 entry/);
  });

  test('consult says nothing useful instead of stretching', () => {
    const none = bob.run(['consult'], { input: 'Goal: write a symphony quickly\nCurrent direction: piano\nUnsure about: orchestration' });
    assert.match(none.out, /Nothing useful: no friend's goal lines up/);
    const judged = bob.run(['consult'], { input: 'Goal: marathon NOTHING_HELPS\nCurrent direction: x\nUnsure about: y' });
    assert.match(judged.out, /Nothing useful: the related entries don't help/);
  });

  test('consult works offline from the local copy and with no friends yet', () => {
    const solo = world.friend('solo');
    sh('git', ['-C', solo.brain, 'remote', 'set-url', 'origin', path.join(world.root, 'missing.git')]);
    fs.mkdirSync(path.join(solo.home, '.huddle'), { recursive: true });
    fs.writeFileSync(
      path.join(solo.home, '.huddle', 'config.json'),
      JSON.stringify({ name: 'solo', llm: { kind: 'command', bin: process.execPath, args: [path.join(solo.brain, 'huddle', 'test', 'fake-llm.mjs')] }, nodeBin: process.execPath, quietMinutes: 10 }),
    );
    const r = solo.run(['consult'], { input: 'Goal: keep people coming back\nCurrent direction: x\nUnsure about: y' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /couldn't reach GitHub, used the local copy/);
    const fresh = world.friend('fresh');
    fresh.install();
    fs.rmSync(path.join(fresh.brain, 'entries'), { recursive: true, force: true });
    sh('git', ['-C', fresh.brain, 'remote', 'set-url', 'origin', path.join(world.root, 'missing.git')]);
    assert.match(fresh.run(['consult'], { input: 'Goal: x' }).out, /No entries from friends yet/);
  });

  test('status shows the setup and connected chats', () => {
    const r = alice.run(['status']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /name: alice2/);
    assert.match(r.out, /Connected chats \(2\)/);
    assert.match(r.out, /-> entries\/alice2\//);
    assert.match(r.out, /Entries in the repo: .*alice2 1/);
  });

  test('disconnect stops sharing this chat', () => {
    const r = alice.run(['disconnect'], { env: { CLAUDE_CODE_SESSION_ID: aliceChat } });
    assert.match(r.out, /Stopped sharing this chat\. Its entry \(entries\/alice2\/.*\) stays in the repo/);
    assert.equal(alice.chats().length, 1);
    assert.match(alice.run(['disconnect'], { env: { CLAUDE_CODE_SESSION_ID: aliceChat } }).out, /isn't connected/);
  });

  test('uninstall removes the skill and settings but keeps the repo copy', () => {
    const r = alice.run(['uninstall']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!fs.existsSync(path.join(alice.home, '.claude', 'skills', 'huddle')));
    assert.ok(!fs.existsSync(path.join(alice.home, '.huddle', 'config.json')));
    assert.ok(fs.existsSync(alice.script));
    assert.match(alice.run(['status']).out, /isn't set up/);
  });
});
