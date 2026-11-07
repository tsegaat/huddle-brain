// Find the chat file for "this chat" and read its user/assistant messages.
// Supports Claude Code (~/.claude/projects) and Codex (~/.codex/sessions).
import fs from 'node:fs';
import path from 'node:path';

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export const chatRoots = (home) => ({
  claude: path.join(home, '.claude', 'projects'),
  codex: path.join(home, '.codex', 'sessions'),
});

function walkJsonl(dir, depth, out = []) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory() && depth > 0) walkJsonl(full, depth - 1, out);
    else if (item.isFile() && item.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

function tailContains(file, needle, bytes = 4 * 1024 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').includes(needle);
  } catch {
    return false;
  }
}

function describe(file, roots) {
  const kind = file.startsWith(roots.codex) ? 'codex' : 'claude';
  const m = file.match(UUID);
  return { kind, id: m ? m[1] : path.basename(file, '.jsonl'), file };
}

// Which chat is "this chat"? Agents set a session id in the environment of the commands they run
// (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID). The marker is a random string the agent put in its
// own command, so it is already written in this chat's file; it settles any doubt.
export function findChatFile({ home, env = process.env, marker, now = Date.now() }) {
  const roots = chatRoots(home);
  const candidates = [];
  if (env.CLAUDE_CODE_SESSION_ID) {
    const name = `${env.CLAUDE_CODE_SESSION_ID}.jsonl`;
    const hit = walkJsonl(roots.claude, 1).find((f) => path.basename(f) === name);
    if (hit) candidates.push(describe(hit, roots));
  }
  if (env.CODEX_THREAD_ID) {
    const hit = walkJsonl(roots.codex, 4).find((f) => f.endsWith(`${env.CODEX_THREAD_ID}.jsonl`));
    if (hit) candidates.push(describe(hit, roots));
  }
  if (marker) {
    const exact = candidates.find((c) => tailContains(c.file, marker));
    if (exact) return exact;
    const recent = [...walkJsonl(roots.claude, 1), ...walkJsonl(roots.codex, 4)]
      .filter((f) => now - mtime(f) < 2 * 60 * 60 * 1000)
      .sort((a, b) => mtime(b) - mtime(a));
    const found = recent.find((f) => tailContains(f, marker));
    if (found) return describe(found, roots);
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => mtime(b.file) - mtime(a.file))[0];
}

function* jsonLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // a half-written last line; skip it
    }
  }
}

const textOf = (blocks) =>
  Array.isArray(blocks)
    ? blocks
        .filter((b) => b && typeof b.text === 'string' && /^(text|input_text|output_text)$/i.test(b.type || 'text'))
        .map((b) => b.text)
        .join('\n')
    : typeof blocks === 'string'
      ? blocks
      : '';

function cleanClaudeUser(text) {
  if (/<local-command-stdout>|<local-command-stderr>/.test(text)) return '';
  const name = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${name[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
}

function readClaude(file) {
  const out = [];
  for (const o of jsonLines(file)) {
    if (o.isSidechain || o.isMeta || !o.message) continue;
    if (o.type === 'user' && o.message.role === 'user') {
      const text = cleanClaudeUser(textOf(o.message.content));
      if (text) out.push({ role: 'user', text, ts: o.timestamp || '' });
    } else if (o.type === 'assistant' && o.message.role === 'assistant') {
      const text = textOf(o.message.content).trim();
      if (text) out.push({ role: 'assistant', text, ts: o.timestamp || '' });
    }
  }
  return out;
}

function readCodex(file) {
  const items = [];
  const events = [];
  const responses = [];
  for (const o of jsonLines(file)) {
    const p = o.payload || {};
    const ts = o.timestamp || '';
    if (o.type === 'event_msg' && p.type === 'item_completed' && p.item) {
      const role = p.item.type === 'UserMessage' ? 'user' : p.item.type === 'AgentMessage' ? 'assistant' : null;
      const text = role ? textOf(p.item.content).trim() : '';
      if (text) items.push({ role, text, ts });
    } else if (o.type === 'event_msg' && (p.type === 'user_message' || p.type === 'agent_message')) {
      const text = String(p.message || '').trim();
      if (text) events.push({ role: p.type === 'user_message' ? 'user' : 'assistant', text, ts });
    } else if (o.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = textOf(p.content).trim();
      // Codex injects context (environment, AGENTS.md, plugin lists) as user messages that start with a tag.
      if (text && !(p.role === 'user' && /^(<[a-z_]+>|# AGENTS\.md)/i.test(text))) responses.push({ role: p.role, text, ts });
    }
  }
  return items.length ? items : events.length ? events : responses;
}

// Returns [{ role: 'user' | 'assistant', text, ts }], with back-to-back assistant pieces joined.
export function readMessages(file, kind) {
  const raw = kind === 'codex' ? readCodex(file) : readClaude(file);
  const merged = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'assistant' && m.role === 'assistant') {
      last.text += `\n${m.text}`;
      last.ts = m.ts || last.ts;
    } else merged.push({ ...m });
  }
  return merged;
}
