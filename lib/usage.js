// 利用上限の使用率の記録（<AGENT_HUB_HOME>/usage.json）の読み込みです。
// 記録は hooks/statusline.cjs が、Claude Code からステータスラインに渡される rate_limits を基に書きます。
// 書き込みはエージェントの応答のたびに起こりうるため、サーバは更新時刻が変わったときだけ読み直します。
import fs from 'node:fs';

// 5 時間の枠・週の枠と、Claude apps ゲートウェイの利用額の上限（spendLimit）です
const WINDOW_KEYS = ['fiveHour', 'sevenDay', 'spendLimit'];
const SPEND_PERIODS = ['daily', 'weekly', 'monthly'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 利用額の上限の、利用額（usedUsd・limitUsd）と期間（period）を取り出します。
 * 利用額は 2 つがそろっているときだけ、期間は既知の値のときだけ残し、欠けた値や未知の形の値を表示しないようにします
 */
function normalizeSpend(w) {
  const out = {};
  if (isNum(w.usedUsd) && isNum(w.limitUsd) && w.usedUsd >= 0 && w.limitUsd >= 0) Object.assign(out, { usedUsd: w.usedUsd, limitUsd: w.limitUsd });
  if (SPEND_PERIODS.includes(w.period)) out.period = w.period;
  return out;
}

function normalizeWindow(w, key) {
  if (!w || typeof w !== 'object') return null;
  const { usedPercentage, resetsAt, receivedAt, agentId } = w;
  if (![usedPercentage, resetsAt, receivedAt].every(isNum)) return null;
  return { usedPercentage, resetsAt, receivedAt, ...(typeof agentId === 'string' ? { agentId } : {}), ...(key === 'spendLimit' ? normalizeSpend(w) : {}) };
}

/**
 * 記録の内容を画面に配る形（{ fiveHour, sevenDay, spendLimit }。値のない枠は null）にします。
 * どの枠も読めない場合は null を返し、画面では「不明」と表示します。記録が壊れていても、誤った値のバーを出さないためです。
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = Object.fromEntries(WINDOW_KEYS.map((k) => [k, normalizeWindow(raw[k], k)]));
  return WINDOW_KEYS.some((k) => out[k]) ? out : null;
}

/**
 * 記録ファイルを読む関数を作ります。refresh() はファイル（i ノード・更新時刻・大きさ）が前回と変わったときだけ読み直し、内容が変わったかを返します。
 * current() は最後に読んだ内容（記録がなければ null）です。
 */
export function usageReader(file) {
  let stamp = null;
  let usage = null;
  return {
    current: () => usage,
    refresh() {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        st = null;
      }
      const nextStamp = st ? `${st.ino}:${st.mtimeMs}:${st.size}` : 'none';
      if (nextStamp === stamp) return false;
      let next = null;
      if (st) {
        try {
          next = normalizeUsage(JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch {
          // 読めない場合は前の内容を残し、次の確認で読み直します。書き込みは名前の付け替えで行うため、通常は途中の内容は見えません
          return false;
        }
      }
      stamp = nextStamp;
      const changed = JSON.stringify(next) !== JSON.stringify(usage);
      usage = next;
      return changed;
    },
  };
}
