'use strict';
// ツール入力を一行に要約します（hook とサーバの両方から使います）

const KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'];

function summarize(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return shorten(v.replace(/\s+/g, ' ').trim(), 120);
  }
  try {
    return shorten(JSON.stringify(input), 120);
  } catch {
    return '';
  }
}

function shorten(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { summarize, shorten };
