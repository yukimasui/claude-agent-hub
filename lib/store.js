// エージェント一覧と状態を管理します。
// 状態の正本は hook が追記するイベント JSONL で、ここで状態機械として解釈します
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { AGENTS_FILE, EVENTS_DIR, HUB_HOME, REQUESTS_DIR } from './config.js';
import { describe, kindOf } from './interactions.js';
import { ERROR_PAUSE_NOTE } from './queue.js';

const PERSIST_KEYS = ['id', 'name', 'model', 'cwd', 'permissionMode', 'effort', 'effortSetAt', 'coat', 'windowId', 'paneId', 'sessionId', 'createdAt', 'queue', 'queuePaused', 'queueNote', 'handoff'];
// これらのイベントが来たら、未回答の対話要求はすべて別経路で解決済みとみなします
const CLEAR_ALL_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'SessionStart']);
// 同じツール・同じ入力の要求を解決済みにするイベントです
const TOOL_RESOLVE_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
// 新しい要求が来たら古い要求を置き換えるツールです（再提示されるもの）
const SUPERSEDE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// イベントファイルの作り直しを見分けるために覚えておく、ファイルの先頭のバイト数です。
// hook は各行をミリ秒の時刻（ts）から書き始めるため、この長さがあれば作り直した別のファイルとは内容が食い違います
const HEAD_BYTES = 64;

/** 新しく読み始めるときの読み込み位置です。head はファイルの先頭の内容で、読み進めるにつれて HEAD_BYTES まで伸ばします */
function newCursor(st) {
  return { offset: 0, decoder: new StringDecoder('utf8'), rest: '', dev: st?.dev, ino: st?.ino, head: Buffer.alloc(0) };
}

/** 開いているファイルの先頭が、覚えておいた先頭の内容と一致するかを返します */
function sameHead(fd, head) {
  if (!head.length) return true;
  const buf = Buffer.alloc(head.length);
  return fs.readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.equals(head);
}

function runtime(base) {
  return {
    ...base,
    state: 'starting',
    activity: '起動しています…',
    stateSince: Date.now(),
    lastEventAt: null,
    lastPrompt: null,
    turnStartedAt: null,
    transcriptPath: null,
    // 親の Claude Code のプロセスが起動した時刻です。これより前に記録が止まったサブエージェントは、前のプロセスとともに
    // 止まったものとして「中断」にします。保存はせず、ハブの再起動時はイベント JSONL の SessionStart から復元します
    processStartedAt: base.processStartedAt ?? null,
    currentMode: base.permissionMode || null,
    alive: true,
    pending: [],
    // サブエージェントの一覧です。記録ファイルから server.js が組み立てて設定し、保存はしません
    subagents: [],
    queue: Array.isArray(base.queue) ? base.queue : [],
    queuePaused: !!base.queuePaused,
    queueNote: base.queueNote || '',
    // 「引き継いでリセット」の段階と結果です（server.js が進めます）。サーバの再起動後も途中から判定し直せるよう保存します
    handoff: base.handoff || null,
    // 現在のコンテキスト量（トークン数）です。transcript から server.js が求めて設定し、保存はしません
    contextTokens: null,
  };
}

function setState(a, state, ts) {
  if (a.state !== state) {
    a.state = state;
    a.stateSince = ts;
  }
}

/** クライアントに送る形です（対話要求の中身は別 API で取ります） */
export function publicAgent(a) {
  const { pending, ...rest } = a;
  return {
    ...rest,
    pending: pending.map((p) => ({ reqId: p.reqId, kind: p.kind, label: p.label, createdAt: p.createdAt, tool: p.tool, subagentId: p.subagentId || null })),
  };
}

export class Store extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();
    this.cursors = new Map();
  }

  init() {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
    } catch {
      // 初回起動です
    }
    for (const a of list) {
      this.agents.set(a.id, runtime(a));
      this.ingest(a.id, true);
    }
  }

  save() {
    fs.mkdirSync(HUB_HOME, { recursive: true });
    const data = [...this.agents.values()].map((a) => Object.fromEntries(PERSIST_KEYS.map((k) => [k, a[k]])));
    const tmp = AGENTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, AGENTS_FILE);
  }

  get(id) {
    return this.agents.get(id);
  }

  list() {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  add(base) {
    const a = runtime(base);
    this.agents.set(a.id, a);
    this.cursors.set(a.id, newCursor());
    this.save();
    this.changed(a.id);
    return a;
  }

  remove(id) {
    const a = this.agents.get(id);
    if (a) this.dropPending(a, () => true, 'cancelled');
    this.agents.delete(id);
    this.cursors.delete(id);
    fs.rmSync(this.eventsFile(id), { force: true });
    this.save();
    this.changed(id);
  }

  patch(id, fields) {
    const a = this.agents.get(id);
    if (!a) return;
    Object.assign(a, fields);
    if (Object.keys(fields).some((k) => PERSIST_KEYS.includes(k))) this.save();
    this.changed(id);
  }

  eventsFile(id) {
    return path.join(EVENTS_DIR, `${id}.jsonl`);
  }

  findPending(reqId) {
    for (const a of this.agents.values()) {
      const p = a.pending.find((x) => x.reqId === reqId);
      if (p) return { agent: a, pending: p };
    }
    return null;
  }

  /**
   * 条件に合う対話要求を取り下げます。
   * hook がまだ待っているかもしれないので 'cancel' を発行してサーバに後始末させます
   */
  dropPending(a, pred, reason) {
    const keep = [];
    for (const p of a.pending) {
      if (pred(p)) this.emit('cancel', p.reqId, reason);
      else keep.push(p);
    }
    const changed = keep.length !== a.pending.length;
    a.pending = keep;
    if (changed) this.refreshWaiting(a);
    return changed;
  }

  /** 要求が残っていれば「要対応」、無くなったら元の状態に戻します */
  refreshWaiting(a, ts = Date.now()) {
    if (a.pending.length) {
      setState(a, 'waiting', ts);
      a.activity = a.pending[0].label + (a.pending.length > 1 ? ` ほか${a.pending.length - 1}件` : '');
    } else if (a.state === 'waiting') {
      setState(a, 'running', ts);
      a.activity = '処理中…';
    }
  }

  loadRequest(reqId) {
    try {
      return JSON.parse(fs.readFileSync(path.join(REQUESTS_DIR, `${reqId}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  /** hook イベント 1 件を状態に反映します */
  applyEvent(a, ev) {
    const ts = ev.ts || Date.now();
    a.lastEventAt = ts;
    if (ev.session_id) a.sessionId = ev.session_id;
    // サブエージェント内のイベント（agent_id 付き）で親の transcript の場所を置き換えないよう、親のイベントからだけ取ります
    if (ev.transcript_path && !ev.agent_id) a.transcriptPath = ev.transcript_path;
    if (ev.pane) a.paneId = ev.pane;
    if (ev.permission_mode) a.currentMode = ev.permission_mode;
    const tool = ev.tool ? `${ev.tool}${ev.tool_summary ? ': ' + ev.tool_summary : ''}` : '';

    if (CLEAR_ALL_EVENTS.has(ev.event)) this.dropPending(a, () => true, 'superseded');
    if (TOOL_RESOLVE_EVENTS.has(ev.event) && ev.tool) {
      const same = a.pending.filter((p) => p.tool === ev.tool);
      const exact = same.find((p) => p.inputHash && p.inputHash === ev.input_hash);
      const target = exact || same[0];
      if (target) this.dropPending(a, (p) => p === target, 'resolved-elsewhere');
    }

    switch (ev.event) {
      case 'SessionStart':
        setState(a, 'idle', ts);
        a.alive = true;
        a.activity = '入力待ち';
        // compact や clear の SessionStart はプロセスが続いたまま届くので、起動時刻には使いません
        if ((ev.source === 'startup' || ev.source === 'resume') && !ev.agent_id) a.processStartedAt = ts;
        break;
      case 'UserPromptSubmit':
        setState(a, 'running', ts);
        a.lastPrompt = ev.prompt ?? a.lastPrompt;
        a.turnStartedAt = ts;
        a.activity = '思考中…';
        break;
      case 'PreToolUse':
        if (!a.pending.length) {
          setState(a, 'running', ts);
          a.activity = tool;
        }
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        if (!a.pending.length) setState(a, 'running', ts);
        break;
      case 'SubagentStart':
      case 'SubagentStop':
        // バックグラウンドのサブエージェントは Stop の後にも終わるので、状態は変えません
        // （サブエージェント自身の状態は記録ファイルから組み立て、これらのイベントは画面を更新するきっかけにだけ使います）
        break;
      case 'PermissionRequest':
      case 'Elicitation': {
        const req = ev.reqId ? this.loadRequest(ev.reqId) : null;
        if (req) {
          if (SUPERSEDE_TOOLS.has(req.tool_name)) this.dropPending(a, (p) => p.tool === req.tool_name, 'superseded');
          a.pending.push({
            reqId: req.reqId,
            kind: kindOf(req),
            label: describe(req),
            tool: req.tool_name || null,
            inputHash: req.input_hash,
            hookPid: req.hookPid,
            createdAt: req.createdAt,
            // サブエージェントのツール呼び出しによる要求は、一覧でそのサブエージェントを「要対応」にするために覚えておきます
            subagentId: ev.agent_id || null,
          });
          this.refreshWaiting(a, ts);
        } else {
          // ハブが回答できない要求（サーバ停止中など）は TUI で答えてもらいます
          setState(a, 'waiting', ts);
          a.activity = ev.event === 'Elicitation' ? `入力要求: ${ev.mcp_server || 'MCP'}` : `許可待ち: ${tool}`;
        }
        break;
      }
      case 'InteractionDone':
        this.dropPending(a, (p) => p.reqId === ev.reqId, null);
        break;
      case 'Notification': {
        const type = ev.notification_type || '';
        if (type === 'permission_prompt' || type.startsWith('elicitation_dialog') || (!type && /permission/i.test(ev.message || ''))) {
          if (!a.pending.length) {
            setState(a, 'waiting', ts);
            if (!a.activity.startsWith('許可待ち')) a.activity = ev.message || '許可待ち';
          }
        } else if (type === 'idle_prompt' && a.state !== 'waiting') {
          setState(a, 'done', ts);
        }
        break;
      }
      case 'Stop':
        setState(a, 'done', ts);
        a.activity = '応答完了';
        break;
      case 'StopFailure':
        // エラーで止まったらキューは自動で進めません
        if (a.queue.length && !a.queuePaused) {
          a.queuePaused = true;
          a.queueNote = ERROR_PAUSE_NOTE;
        }
        setState(a, 'done', ts);
        a.activity = `エラーで停止しました${ev.error ? `: ${ev.error}` : ''}`;
        break;
      case 'PreCompact':
        setState(a, 'compacting', ts);
        a.activity = 'コンテキストを圧縮しています…';
        break;
      case 'PostCompact':
        if (a.state === 'compacting') {
          setState(a, 'running', ts);
          a.activity = '圧縮が完了しました';
        }
        break;
      case 'SessionEnd':
        // ハブが動いているプロセスを起動し直したとき（エフォートの変更など）は、終了させた前のプロセスの SessionEnd が
        // 「起動中」にした後で届きます。新しいプロセスの起動を待っている間なので「終了」にはしません。
        // 新しいプロセスが起動できずに終わった場合は、ペインの確認（server.js の reconcile）で「終了」になります
        if (a.state === 'starting') break;
        setState(a, 'ended', ts);
        a.activity = `セッション終了${ev.reason ? ` (${ev.reason})` : ''}`;
        break;
    }
  }

  /** イベントファイルの追記分だけ読んで反映します */
  ingest(id, silent = false) {
    const a = this.agents.get(id);
    if (!a) return;
    // 先に開いてから fstat で調べ、同じファイル記述子から読みます。パスで stat してから開くと、その間に
    // ファイルが作り直された場合に、古いファイルのサイズで新しいファイルを読んでしまうためです。
    // 開いた後にファイルやフォルダが消されても、記述子からは消される前の内容を読めます。
    // 呼び出し元は fs.watch のコールバックと setInterval で、例外が出るとサーバが落ちるため、
    // 開けなかった場合や読めなかった場合は読み込み位置を進めずに戻り、次の読み込みでやり直します
    let fd;
    try {
      fd = fs.openSync(this.eventsFile(id), 'r');
    } catch {
      return;
    }
    let cur;
    let buf;
    let bytesRead;
    try {
      const st = fs.fstatSync(fd);
      cur = this.cursors.get(id);
      // 作り直されたファイルは、inode が変わったことで判定します。作り直したファイルが前回の読み込み位置より
      // 長くなっていても、先頭から読み直すためです。ただし消した直後に作ったファイルは同じ inode 番号を
      // 再利用することがあるため、前回の読み込み位置より短くなったことと、先頭の内容が読み込み済みの内容と
      // 食い違うことでも判定します。先頭の比較は、追記分を読むとき（サイズが伸びたとき）だけ、同じ記述子から
      // HEAD_BYTES までを読んで行います。変化のないときの定期的な読み込みでは余分に読まず、追記のたびに
      // ファイル全体を読み直すこともしないためです
      const recreated =
        !cur || cur.dev !== st.dev || cur.ino !== st.ino || st.size < cur.offset || (st.size > cur.offset && !sameHead(fd, cur.head));
      if (recreated) {
        cur = newCursor(st);
        this.cursors.set(id, cur);
      }
      if (st.size === cur.offset) return;
      buf = Buffer.alloc(st.size - cur.offset);
      bytesRead = fs.readSync(fd, buf, 0, buf.length, cur.offset);
    } catch {
      return;
    } finally {
      fs.closeSync(fd);
    }
    // 先頭の内容は、読み込み位置が HEAD_BYTES に届くまで、読んだ分を足して伸ばします（head の長さは常に読み込み位置と HEAD_BYTES の小さいほうです）
    if (cur.offset < HEAD_BYTES) cur.head = Buffer.concat([cur.head, buf.subarray(0, Math.min(bytesRead, HEAD_BYTES - cur.offset))]);
    // 調べた後に同じファイルが短く切り詰められた場合は、調べたサイズまで進めると続きを読み飛ばすため、実際に読めた分だけ進めます
    cur.offset += bytesRead;
    const lines = (cur.rest + cur.decoder.write(buf.subarray(0, bytesRead))).split('\n');
    cur.rest = lines.pop();

    const prevSession = a.sessionId;
    const prevPaused = a.queuePaused;
    let n = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // 壊れた行は読み飛ばします
      }
      this.applyEvent(a, ev);
      n++;
    }
    if (a.sessionId !== prevSession || a.queuePaused !== prevPaused) this.save();
    if (n && !silent) this.changed(id);
  }

  changed(id) {
    this.emit('change', id);
  }
}
