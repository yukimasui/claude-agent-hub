// 利用上限（5 時間の枠と週の枠）の使用率の表示の組み立てです。
// 単体テストで確かめられるよう、DOM に触れない関数だけを置き、HTML への書き出しは app.js が行います。
// 時刻の表記はブラウザの地域の時刻（Date の getHours など）で行います。

// 受け取ってからこの時間が過ぎた値は「古い値」として薄く表示します。
// 値はハブのエージェントが応答したときにだけ届くため、ハブの外（claude.ai やほかの端末）での利用分は、次に届くまで反映されないためです
export const USAGE_STALE_MS = 15 * 60 * 1000;

export const USAGE_WINDOWS = [
  { key: 'fiveHour', label: '5時間', name: '5 時間の枠' },
  { key: 'sevenDay', label: '週', name: '週の枠' },
];

// この使用率以上で、バーの色を注意・警告の色に変えます
const WARN_AT = 70;
const HIGH_AT = 90;

/** 使用率の段階です（色分けに使います） */
export function usageLevel(pct) {
  if (pct >= HIGH_AT) return 'high';
  if (pct >= WARN_AT) return 'warn';
  return 'ok';
}

/** 残り時間の表記です（例: 「2時間13分」「3日4時間」「1分未満」） */
export function formatRemaining(ms) {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return '1分未満';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return h ? `${d}日${h}時間` : `${d}日`;
  if (h) return m ? `${h}時間${m}分` : `${h}時間`;
  return `${m}分`;
}

const pad = (n) => String(n).padStart(2, '0');
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 時刻の表記です。今日なら時刻だけ、それ以外は日付も付けます（例: 「15:00」「11/15 9:00」） */
export function formatClock(ts, now) {
  const d = new Date(ts);
  const time = `${d.getHours()}:${pad(d.getMinutes())}`;
  return sameDay(d, new Date(now)) ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** 受け取ってからの経過の表記です（例: 「たった今」「3分前」「2時間前」） */
export function formatAgo(ts, now) {
  const min = Math.floor(Math.max(0, now - ts) / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  if (min < 1440) return `${Math.floor(min / 60)}時間前`;
  return `${Math.floor(min / 1440)}日前`;
}

/**
 * 枠ごとの表示内容を返します。usage はサーバから届く { fiveHour, sevenDay }（値のない枠は null）です。
 * - status が 'ok': 使用率のバーを出します。percent は表記用に丸めた値、width はバーの幅（0〜100 に収めた値）です
 * - status が 'unknown': その枠の値を受け取っていません
 * - status が 'reset': リセットの時刻を過ぎています。使用率は戻っているはずですが、新しい値が届くまでは分からないため、バーを出しません
 * stale は、受け取ってから USAGE_STALE_MS を過ぎているかです。
 */
export function usageRows(usage, now) {
  return USAGE_WINDOWS.map(({ key, label, name }) => {
    const w = usage?.[key];
    if (!w) return { key, label, status: 'unknown', text: '不明', title: `${name}の使用率はまだ受け取っていません` };
    const received = `受け取り: ${formatClock(w.receivedAt, now)}（${formatAgo(w.receivedAt, now)}）`;
    const stale = now - w.receivedAt > USAGE_STALE_MS;
    if (now >= w.resetsAt) {
      return {
        key, label, status: 'reset', stale, text: 'リセット済み',
        reset: `${formatClock(w.resetsAt, now)} にリセット`,
        title: `${name}は ${formatClock(w.resetsAt, now)} にリセットされました。新しい使用率はエージェントが次に応答したときに届きます\n${received}`,
      };
    }
    const percent = Math.round(w.usedPercentage);
    const width = Math.min(100, Math.max(0, w.usedPercentage));
    const reset = `${formatClock(w.resetsAt, now)} にリセット（あと${formatRemaining(w.resetsAt - now)}）`;
    return {
      key, label, status: 'ok', stale, percent, width, level: usageLevel(w.usedPercentage), text: `${percent}%`, reset,
      title: `${name}: ${percent}% 使用\n${reset}\n${received}${stale ? '\n受け取ってから時間がたっています。ハブの外での利用分は反映されていない場合があります' : ''}`,
    };
  });
}

/** 受け取った時刻の表記です（2 つの枠のうち新しいほう）。値がなければ空文字です */
export function usageReceivedLabel(usage, now) {
  const times = USAGE_WINDOWS.map(({ key }) => usage?.[key]?.receivedAt).filter((t) => typeof t === 'number');
  if (!times.length) return '';
  return `受け取り: ${formatAgo(Math.max(...times), now)}`;
}
