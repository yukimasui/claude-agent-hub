// 会話表示の時刻と、1 往復（ターン）ごとの応答の所要時間の組み立てです。
// 単体テストで確かめられるよう、DOM に触れない関数だけを置き、HTML への書き出しは app.js が行います。
// 時刻の表記はブラウザの地域の時刻で行い、サイドバーの利用上限の表示と同じ書き方（public/usage.js の formatClock）にそろえます。
import { formatClock } from './usage.js';

const pad = (n) => String(n).padStart(2, '0');

/**
 * 会話の項目に添える時刻の表記です。text は画面に出す短い表記（今日なら「14:32」、別の日なら「11/11 14:32」）、
 * title はマウスを乗せたときに出す秒までの時刻（例: 「2026/11/11 14:32:05」）、iso は time 要素の datetime に入れる値です。
 * 「今日」の判定に使う現在時刻は引数で受け取ります（テストで固定するためです）。時刻が読めない項目には null を返します。
 */
export function itemTime(ts, now) {
  // transcript の時刻（ISO 形式の文字列）のほか、turnDurations が返す時刻（ミリ秒）も受け付けます
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const full = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { text: formatClock(t, now), title: full, iso: d.toISOString() };
}

/** 所要時間の表記です。1 分未満は秒だけ、1 時間未満は分と秒、1 時間以上は時間と分にします（例: 「45秒」「3分12秒」「1時間5分」） */
export function formatDuration(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}

// ターンが終わっていない（実行中・回答待ち・圧縮中の）状態です。サブエージェントの状態（running・waiting）にも使います
const BUSY_STATES = new Set(['running', 'waiting', 'compacting']);

/** 状態から、最後のターンがまだ終わっていないかを返します（turnDurations の busy に渡します） */
export function isTurnBusy(state) {
  return BUSY_STATES.has(state);
}

// エージェントの応答に当たる項目です。ターンの終わりの時刻は、この中で最後のものの時刻とします
const RESPONSE_ROLES = new Set(['assistant', 'tool', 'tool_error', 'question', 'plan', 'todos']);
// 応答のうち、ツールの呼び出しに当たる項目です。これが最後の応答なら、エージェントはツールの結果を待っていて、ターンは続いています
const TOOL_ROLES = new Set(['tool', 'tool_error', 'question', 'plan', 'todos']);

/**
 * 新しいターンを始める項目かを返します。
 * - 利用者の発言: ただし処理中に送ってターンの途中で取り込まれた発言（queued）は、そのターンへの追加の指示なので区切りにしません
 * - スラッシュコマンド: スキルのように応答が続くものがあるため区切りにします。/clear や /effort のように応答のないものは、
 *   後ろに応答がないので所要時間は出ません（直前のターンを終わらせる区切りとしてだけ働きます）
 * - バックグラウンドのタスクの完了通知: ターンの終了後に届き、エージェントがそれを受けて作業を始めるため区切りにします。
 *   ただし、続いているターンの途中に届いたもの（midTurn）は、呼び出し側で区切りから外します
 * 会話の圧縮（compact）やコマンドの出力は区切りにしません。自動の圧縮はターンの途中で起きて、その後も同じターンが続くためです
 */
function startsTurn(it) {
  if (it.role === 'user') return !it.queued;
  return it.role === 'system' && (it.kind === 'command' || it.kind === 'notification');
}

/**
 * 完了通知が、続いているターンの途中に届いたものかを返します。途中に届いた通知は区切りにせず、そのターンに含めます。
 * ターンの終わりの目印（turnEnd）がある記録では、ターンが終わると close で cur.start が null になるため、ここには来ません。
 * 目印のない記録では、ターンが終わったかを直前の項目から推し量ります。
 * - 最後の応答がツールの呼び出し: 結果を待っている（または結果を受けて続ける）途中なので、ターンは続いています
 * - 発言や完了通知の後にまだ応答がない: エージェントが応答を作っている途中なので、ターンは続いています。
 *   ただしコマンドで始まったもの（/clear など）は応答がないまま終わるので、続いているとはみなしません
 * - 最後の応答が本文（assistant）: ターンの最後の返答とみなし、通知を新しいターンの始まりにします
 */
function midTurn(cur, items) {
  if (cur.start == null) return false;
  if (cur.end) return TOOL_ROLES.has(items[cur.end.index].role);
  return cur.startKind !== 'command';
}

/**
 * ターンごとの所要時間を求めます。返り値は「所要時間を表示する位置（ターンの最後の項目の添字）→ 所要時間」の Map です。
 * 所要時間は { ms, interrupted, from, to } で、from はターンを始めた項目の時刻、to は最後の応答（中断したターンでは中断）の時刻です。
 *
 * - ターンの終わりの目印（turnEnd。lib/transcript.js が Claude Code の turn_duration の行から付けます）があれば、そこでターンを終えます。
 *   サブエージェントからの報告のように画面に出さない入力で始まったターンは始まりの項目がないため、目印がないと
 *   直前のターンの続きとして所要時間に含まれてしまうためです。目印のある最後のターンは、busy でも終わったものとして出します。
 *   目印は Claude Code の版によっては書かれないため、ない場合は次のターンの始まりの手前までを 1 つのターンとします
 * - 中断したターン（「中断されました」の項目）は、中断までの時間を interrupted: true で返します
 * - busy（エージェントが実行中・回答待ちなど、ターンが終わっていない状態）のときは、最後のターンの所要時間を出しません。
 *   途中までの時間が完了したターンの所要時間に見えないようにするためです（経過時間はステータス行に出ています）
 * - 表示範囲の先頭でターンの始まりが欠けている場合は、本当の所要時間が分からないので出しません
 * - 応答のないターン（/clear などのコマンドだけのもの）は出しません
 *
 * 処理中に送った発言（queued）は送信した時刻の位置に並んでいるため（lib/transcript.js の insertByTime）、
 * 所要時間には影響しません。ターンの始まりは送信した時刻の項目、終わりは応答の項目の時刻で決まります。
 * AskUserQuestion などで利用者の回答を待った時間も、ターンの所要時間に含まれます。
 */
export function turnDurations(items, { busy = false } = {}) {
  const out = new Map();
  // start は今のターンを始めた項目の時刻（始まりが分からないときは null）、startKind はその項目の種類、
  // end は今のターンの最後の応答 { index, t } です
  const cur = { start: null, startKind: null, end: null };
  const close = (interrupted) => {
    const { start, end } = cur;
    if (start != null && end && end.t >= start) out.set(end.index, { ms: end.t - start, interrupted, from: start, to: end.t });
    cur.start = null;
    cur.startKind = null;
    cur.end = null;
  };
  for (const [i, it] of items.entries()) {
    const t = Date.parse(it.ts);
    if (startsTurn(it) && !(it.kind === 'notification' && midTurn(cur, items))) {
      close(false);
      cur.start = Number.isFinite(t) ? t : null;
      cur.startKind = it.kind || it.role;
    } else if (cur.start != null && Number.isFinite(t)) {
      if (it.role === 'system' && it.kind === 'interrupt') {
        cur.end = { index: i, t };
        close(true);
      } else if (RESPONSE_ROLES.has(it.role)) cur.end = { index: i, t };
    }
    // 始まりの分からないターンの終わりの目印でも区切ります。これより後の応答を、次の始まりの分からないターンに含めないためです
    if (it.turnEnd) close(false);
  }
  if (!busy) close(false);
  return out;
}

/** 所要時間の表記です（例: 「応答 3分12秒」、中断したターンは「中断まで 3分12秒」） */
export function turnLabel(d) {
  return `${d.interrupted ? '中断まで' : '応答'} ${formatDuration(d.ms)}`;
}

/** 所要時間の説明（マウスを乗せたときの表示）です。どこからどこまでを測ったかを秒までの時刻で示します */
export function turnTitle(d) {
  const from = itemTime(d.from)?.title;
  const to = itemTime(d.to)?.title;
  return `ターンの始まり（${from}）から${d.interrupted ? '中断' : '最後の応答'}（${to}）まで`;
}
