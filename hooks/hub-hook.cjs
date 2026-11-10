#!/usr/bin/env node
'use strict';
// Agent Hub 用の Claude Code hook にゃ。
// - 通常イベント: 最小限に整形して JSONL に追記するだけにゃ
// - 対話イベント（PermissionRequest / Elicitation）: 要求内容を書き出し、ブラウザからの回答を待って返すにゃ
//   PermissionRequest は TUI のダイアログと並行して動くので、ターミナルで先に答えても問題ないにゃ
// 状態の解釈はサーバ側でやるから、ここは「絶対にエージェントの邪魔をしない」ことを最優先にするにゃ

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const agentId = process.env.AGENT_HUB_AGENT;
const home = process.env.AGENT_HUB_HOME;

// ハブ経由で起動したセッション以外は何もしないにゃ
if (!agentId || !home || !/^[A-Za-z0-9_-]+$/.test(agentId)) process.exit(0);

const INTERACTIVE = new Set(['PermissionRequest', 'Elicitation']);
const POLL_MS = 250;
const MAX_WAIT_MS = Number(process.env.AGENT_HUB_HOOK_WAIT_MS || 3500 * 1000);
const HEARTBEAT_STALE_MS = 20000;

function appendEvent(ev) {
  const dir = path.join(home, 'events');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, agentId + '.jsonl'), JSON.stringify(ev) + '\n');
}

function inputHash(input) {
  if (input == null) return undefined;
  return crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function serverAlive() {
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
    return Date.now() - hb.ts < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let input, ev;
  try {
    const { summarize, shorten } = require('./summarize.cjs');
    input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    ev = {
      ts: Date.now(),
      event: input.hook_event_name,
      session_id: input.session_id,
      transcript_path: input.transcript_path,
      cwd: input.cwd,
      pane: process.env.TMUX_PANE || null,
    };
    if (input.tool_name) ev.tool = input.tool_name;
    if (input.tool_input) {
      ev.tool_summary = summarize(input.tool_name, input.tool_input);
      ev.input_hash = inputHash(input.tool_input);
    }
    if (input.tool_use_id) ev.tool_use_id = input.tool_use_id;
    if (input.message) ev.message = shorten(String(input.message), 500);
    if (input.notification_type) ev.notification_type = input.notification_type;
    if (input.prompt) ev.prompt = shorten(String(input.prompt), 500);
    if (input.source) ev.source = input.source;
    if (input.reason) ev.reason = shorten(String(input.reason), 300);
    if (input.permission_mode) ev.permission_mode = input.permission_mode;
    if (input.mcp_server_name) ev.mcp_server = input.mcp_server_name;
    if (input.error) ev.error = shorten(String(input.error), 300);
    // サブエージェントの中で発生したイベントには agent_id が付きます（親のイベントには付きません）
    if (input.agent_id) ev.agent_id = String(input.agent_id).slice(0, 64);
    if (input.agent_type) ev.agent_type = shorten(String(input.agent_type), 80);
  } catch {
    process.exit(0);
  }

  if (INTERACTIVE.has(ev.event) && serverAlive()) {
    try {
      return interact(input, ev);
    } catch {
      // 対話モードの準備に失敗したら通常記録だけして TUI に任せるにゃ
    }
  }
  try {
    appendEvent(ev);
  } catch {}
  // 必ず 0 で抜けるにゃ（PreToolUse で 2 を返すとツール実行がブロックされるにゃ）
  process.exit(0);
});

/** ブラウザからの回答を待つにゃ。回答が来なければ何も出力せず抜けて TUI に任せるにゃ */
function interact(input, ev) {
  const reqId = `${agentId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const reqFile = path.join(home, 'requests', `${reqId}.json`);
  const resFile = path.join(home, 'responses', `${reqId}.json`);
  const parentPid = process.ppid;

  writeJsonAtomic(reqFile, {
    reqId,
    event: ev.event,
    hookPid: process.pid,
    createdAt: ev.ts,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    input_hash: ev.input_hash,
    permission_suggestions: input.permission_suggestions,
    permission_mode: input.permission_mode,
    mcp_server_name: input.mcp_server_name,
    message: input.message,
    mode: input.mode,
    url: input.url,
    elicitation_id: input.elicitation_id,
    requested_schema: input.requested_schema,
  });
  appendEvent({ ...ev, reqId });

  let finished = false;
  const finish = (result, output) => {
    if (finished) return;
    finished = true;
    try {
      appendEvent({ ts: Date.now(), event: 'InteractionDone', reqId, result });
    } catch {}
    try {
      fs.rmSync(reqFile, { force: true });
    } catch {}
    if (output) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  };

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => finish('aborted'));
  const deadline = Date.now() + MAX_WAIT_MS;
  let n = 0;

  const tick = () => {
    n++;
    let res = null;
    try {
      res = JSON.parse(fs.readFileSync(resFile, 'utf8'));
      fs.rmSync(resFile, { force: true });
    } catch {}
    if (res) return finish(res.result || 'answered', res.output || null);
    // Claude Code 本体が居なくなったら終わるにゃ
    try {
      process.kill(parentPid, 0);
    } catch {
      return finish('aborted');
    }
    if (Date.now() > deadline) return finish('timeout');
    // ハブが止まったら待つ意味がないので TUI に任せるにゃ（約 5 秒ごとに確認）
    if (n % 20 === 0 && !serverAlive()) return finish('server-gone');
    setTimeout(tick, POLL_MS);
  };
  tick();
}
