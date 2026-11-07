// Remove things that look like secrets or private contact details.
// Runs on chat text before it goes to the model, and again on the entry before it is pushed.

const RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, '[redacted key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted key]'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{10,}/g, '[redacted key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted token]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  // https://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  // password=hunter22, api_key: "abc123..." (value must contain a digit, so plain words are left alone)
  [
    /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z_]*["']?\s*[:=]\s*)(["']?)(?=[^\s"',;]*\d)[^\s"',;]{8,}\2/gi,
    '$1[redacted]',
  ],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '[email]'],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
