// Ask a model a question through a coding agent's command-line tool.
// Uses the login the person already has (Claude Code or Codex), so no API keys are needed.
// Any other tool works too with --llm-cmd: a program that reads the prompt on stdin and prints the answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentBin, run } from './sys.mjs';

// Session variables from the agent we're running inside. A nested run must not think it is that session.
const SESSION_VARS = [
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
];

export function cleanEnv() {
  const env = { ...process.env };
  for (const key of SESSION_VARS) delete env[key];
  return env;
}

export function llmCommand(llm, outFile) {
  const model = llm.model ? [llm.kind === 'codex' ? '-m' : '--model', llm.model] : [];
  if (llm.kind === 'claude') {
    return { cmd: llm.bin, args: ['-p', '--tools', '', '--no-session-persistence', ...model] };
  }
  if (llm.kind === 'codex') {
    return {
      cmd: llm.bin,
      args: ['exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '-s', 'read-only', '-o', outFile, ...model, '-'],
    };
  }
  return { cmd: llm.bin, args: llm.args || [] };
}

export function askModel(llm, prompt, { timeoutMs = 300_000 } = {}) {
  // The saved path can go stale (an app update moves the bundled binary), so look again if it's gone.
  if ((llm.kind === 'claude' || llm.kind === 'codex') && !fs.existsSync(llm.bin)) {
    llm = { ...llm, bin: findAgentBin(llm.kind) || llm.bin };
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-'));
  const outFile = path.join(work, 'answer.txt');
  try {
    const { cmd, args } = llmCommand(llm, outFile);
    const r = run(cmd, args, { input: prompt, timeoutMs, env: cleanEnv(), cwd: work });
    let answer = r.out;
    if (llm.kind === 'codex') {
      try {
        answer = fs.readFileSync(outFile, 'utf8').trim();
      } catch {
        answer = '';
      }
    }
    if (!r.ok || !answer) {
      const why = (r.err || r.out || 'no answer').split('\n').slice(-4).join(' ').slice(0, 400);
      throw new Error(`${llm.kind} did not answer: ${why}`);
    }
    return answer;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
