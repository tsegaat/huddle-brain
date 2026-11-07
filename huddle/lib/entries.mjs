// Entries: one markdown file per shared chat, at entries/<person>/<YYYY-MM-DD>-<slug>.md
import fs from 'node:fs';
import path from 'node:path';

export function parseEntry(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: String(text) };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (kv[1] === 'tags') {
      value = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else value = value.replace(/^["']|["']$/g, '');
    data[kv[1]] = value;
  }
  return { data, body: m[2] };
}

// The model sometimes wraps its answer in a code fence or adds a line before it.
export function cleanModelEntry(raw) {
  let t = String(raw).replace(/\r\n/g, '\n').trim();
  const fenced = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fenced) t = fenced[1].trim();
  const start = t.indexOf('---\n');
  if (start > 0) t = t.slice(start);
  return t;
}

export function validateEntry(text) {
  const { data, body } = parseEntry(text);
  if (!data.goal) return { ok: false, reason: 'no goal line' };
  if (!/^## Decisions/m.test(body)) return { ok: false, reason: 'no Decisions section' };
  return { ok: true, goal: data.goal, tags: Array.isArray(data.tags) ? data.tags : [] };
}

// Rebuild the header ourselves so author, dates and chat id never depend on the model.
export function buildEntry(modelText, { author, date, updated, chat }) {
  const { data, body } = parseEntry(modelText);
  const tags = (Array.isArray(data.tags) ? data.tags : []).map((t) => t.toLowerCase()).slice(0, 6);
  const goal = String(data.goal).replace(/\s+/g, ' ').trim();
  const header = [
    '---',
    `author: ${author}`,
    `date: ${date}`,
    `updated: ${updated}`,
    `goal: ${goal}`,
    `tags: [${tags.join(', ')}]`,
    `chat: ${chat}`,
    '---',
  ].join('\n');
  return `${header}\n\n${body.trim()}\n`;
}

export function slugify(text, maxWords = 7) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join('-')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'chat';
}

export const safeName = (name) => slugify(name, 4) || 'friend';

// All entries in the repo: entries/<person>/*.md (README files are skipped).
export function listEntries(repoDir) {
  const root = path.join(repoDir, 'entries');
  const out = [];
  let people = [];
  try {
    people = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const person of people) {
    const dir = path.join(root, person.name);
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.md') || /^readme/i.test(name)) continue;
      const file = path.join(dir, name);
      const text = fs.readFileSync(file, 'utf8');
      const { data } = parseEntry(text);
      if (!data.goal) continue;
      out.push({
        author: data.author || person.name,
        folder: person.name,
        date: data.updated || data.date || '',
        goal: data.goal,
        tags: Array.isArray(data.tags) ? data.tags : [],
        file: path.relative(repoDir, file).split(path.sep).join('/'),
        text,
      });
    }
  }
  return out;
}
