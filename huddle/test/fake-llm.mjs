#!/usr/bin/env node
// A stand-in model for tests: reads the prompt on stdin and answers predictably.
//   chat lines "GOAL: ..." and "DECISION: x BECAUSE y" become the entry; "NOTHING_TO_SHARE" -> SKIP
//   pick: chooses goals that share a word (5+ letters) with the brief
//   judge: reports the first decision of each entry; "NOTHING_HELPS" in the brief -> NOTHING USEFUL
import fs from 'node:fs';

const prompt = fs.readFileSync(0, 'utf8');
const kind = /Reply with exactly the word OK/.test(prompt)
  ? 'ok'
  : /You write one entry/.test(prompt)
    ? 'summarize'
    : /you only choose which entries/.test(prompt)
      ? 'pick'
      : /Find the decisions in them/.test(prompt)
        ? 'judge'
        : 'unknown';
if (process.env.FAKE_LLM_LOG) fs.appendFileSync(process.env.FAKE_LLM_LOG, `${kind}\n`);
if (process.env.FAKE_LLM_FAIL) {
  process.stderr.write('fake model is down\n');
  process.exit(1);
}

const between = (text, a, b) => {
  const i = text.indexOf(a);
  const j = text.indexOf(b, i + a.length);
  return i >= 0 && j > i ? text.slice(i + a.length, j) : '';
};
const words = (t) => new Set((t.toLowerCase().match(/[a-z]{5,}/g) || []).filter((w) => !['their', 'about', 'which'].includes(w)));

if (kind === 'ok') {
  console.log('OK');
} else if (kind === 'summarize') {
  const chat = between(prompt, '<chat>', '</chat>');
  const existing = between(prompt, '<entry>', '</entry>');
  if (chat.includes('NOTHING_TO_SHARE')) {
    console.log('SKIP');
    process.exit(0);
  }
  const goal = (chat.match(/GOAL: (.*)/) || existing.match(/^goal: (.*)$/m) || [])[1];
  const old = [...existing.matchAll(/\*\*(.+?)\*\*\n\s+Why: (.*)/g)].map((m) => [m[1], m[2]]);
  const fresh = [...chat.matchAll(/DECISION: (.*?) BECAUSE (.*)/g)].map((m) => [m[1], m[2].trim()]);
  const decisions = [...old, ...fresh.filter(([d]) => !old.some(([o]) => o === d))];
  if (!goal || !decisions.length) {
    console.log('SKIP');
    process.exit(0);
  }
  const leak = (chat.match(/sk-[A-Za-z0-9_-]{20,}/) || [])[0];
  const body = decisions
    .map(([d, why], i) => `${i + 1}. **${d}**\n   Why: ${why}\n   Instead of: nothing else was considered`)
    .join('\n');
  console.log(
    '```markdown\n---\n' +
      `goal: ${goal.trim()}\ntags: [Test, ideas]\nauthor: someone-else\n---\n\n## Goal\n${goal.trim()}\n\n## Decisions\n${body}\n\n` +
      `## Still open\n- ${leak ? `key used: ${leak}` : 'nothing open'}\n` +
      '```',
  );
} else if (kind === 'pick') {
  const brief = words(between(prompt, '<brief>', '</brief>'));
  const picks = [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(([, , goal]) => [...words(goal)].some((w) => brief.has(w))).map((m) => m[1]);
  console.log(`PICK: ${picks.length ? picks.join(', ') : 'NONE'}`);
} else if (kind === 'judge') {
  if (between(prompt, '<brief>', '</brief>').includes('NOTHING_HELPS')) {
    console.log('NOTHING USEFUL');
    process.exit(0);
  }
  const blocks = prompt.split(/^=== /m).slice(1);
  const out = blocks.slice(0, 3).map((block, i) => {
    const file = block.split('\n')[0].trim();
    const author = (block.match(/^author: (.*)$/m) || [])[1];
    const goal = (block.match(/^goal: (.*)$/m) || [])[1];
    const [, decision, why] = block.match(/\*\*(.+?)\*\*\n\s+Why: (.*)/) || [];
    return `${i + 1}. **${author}**: ${goal} (${file})\n   They decided: ${decision}, because ${why}\n   Why it matters for you: it applies to your goal.`;
  });
  console.log(out.join('\n\n'));
} else {
  console.log('unknown prompt');
}
