#!/usr/bin/env node
// Elicitation の検証用の最小 MCP サーバ（stdio）です。E2E シナリオ elicitation から使います。
// ツール ask_profile が呼ばれると、クライアント（Claude Code）に elicitation/create でフォーム入力を求め、
// 返ってきた結果をそのままツールの結果として返します。
import readline from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// サーバから送った要求（elicitation/create）への応答を待つためのものです
const waiting = new Map();
let seq = 0;

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: '名前', description: 'ニックネームで構いません' },
    age: { type: 'integer', title: '年齢', minimum: 0, maximum: 150 },
    color: { type: 'string', title: '好きな色', enum: ['red', 'blue'], enumNames: ['赤', '青'] },
    agree: { type: 'boolean', title: '規約に同意する', default: false },
  },
  required: ['name'],
};

function elicit(params) {
  const id = `e${++seq}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
  });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id != null && !m.method && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
    return;
  }
  if (m.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'elicit-test', version: '0.0.1' } },
    });
  } else if (m.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: { tools: [{ name: 'ask_profile', description: 'ユーザーにプロフィールの入力を求めます', inputSchema: { type: 'object', properties: {} } }] },
    });
  } else if (m.method === 'tools/call') {
    const res = await elicit({ message: 'プロフィールを入力してください。', requestedSchema: PROFILE_SCHEMA });
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `elicitation result: ${JSON.stringify(res.result ?? res.error)}` }] } });
  } else if (m.id != null) {
    // 未対応の要求にも空の結果を返し、クライアントを待たせないようにします
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
