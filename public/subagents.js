// サイドバーのサブエージェントのツリー表示を組み立てる処理です。
// テストできるよう DOM には触れず、表示する行の配列を返します（HTML にするのは app.js です）。

export const SUB_STATE_LABEL = {
  running: '実行中',
  waiting: '要対応',
  done: '完了',
  failed: '失敗',
  ended: '中断',
};

// 作業中とみなす状態です。作業中のサブエージェント（と、その祖先）は常に表示します
const ACTIVE_STATES = new Set(['running', 'waiting']);

// 終わったサブエージェントを、親ごとに新しいものから何件まで表示するかです。
// エージェントが多くのサブエージェントを起動すると一覧が長くなりすぎるため、古いものは「さらに表示」にまとめます
export const KEEP_FINISHED = 3;

/**
 * 親子関係（parentId）からツリーを作り、最上位のノードの配列を返します。
 * 親が一覧に無いもの（記録の欠けなど）や、親子関係が循環しているものは最上位に置き、表示から漏れないようにします。
 */
export function buildTree(subagents) {
  const nodes = new Map();
  for (const sub of subagents || []) if (sub?.id && !nodes.has(sub.id)) nodes.set(sub.id, { sub, children: [] });
  const parentOf = (n) => (n.sub.parentId && n.sub.parentId !== n.sub.id ? nodes.get(n.sub.parentId) : null);
  const cyclic = (n) => {
    const seen = new Set([n]);
    for (let p = parentOf(n); p; p = parentOf(p)) {
      if (seen.has(p)) return true;
      seen.add(p);
    }
    return false;
  };
  const roots = [];
  for (const n of nodes.values()) {
    const p = parentOf(n);
    if (p && !cyclic(n)) p.children.push(n);
    else roots.push(n);
  }
  return roots;
}

const isActive = (n) => ACTIVE_STATES.has(n.sub.state) || n.children.some(isActive);
const countNodes = (n) => 1 + n.children.reduce((s, c) => s + countNodes(c), 0);

/**
 * 表示する行を上から順に返します。
 * - { type: 'sub', sub, depth, last }: サブエージェントの行。depth は入れ子の深さ（最上位が 0）、last は兄弟の中で最後か
 * - { type: 'more', hidden, expanded }: 古い完了分の表示を切り替える行。hidden は隠しているサブエージェントの数（入れ子を含む）
 * 作業中のものは常に表示し、終わった最上位のサブエージェントは新しいものから keep 件だけを表示します（expanded ならすべて）。
 */
export function subagentRows(subagents, { expanded = false, keep = KEEP_FINISHED } = {}) {
  const roots = buildTree(subagents);
  const finished = roots.filter((n) => !isActive(n));
  const overflow = finished.slice(0, Math.max(0, finished.length - keep));
  const hiddenSet = expanded ? new Set() : new Set(overflow);
  const rows = [];
  if (overflow.length) rows.push({ type: 'more', hidden: overflow.reduce((s, n) => s + countNodes(n), 0), expanded });
  const walk = (list, depth) => {
    list.forEach((n, i) => {
      rows.push({ type: 'sub', sub: n.sub, depth, last: i === list.length - 1 });
      walk(n.children, depth + 1);
    });
  };
  walk(
    roots.filter((n) => !hiddenSet.has(n)),
    0,
  );
  return rows;
}

/** 親エージェントの行に添える件数です（作業中の数と全体の数） */
export function subagentCounts(subagents) {
  const list = subagents || [];
  return { active: list.filter((s) => ACTIVE_STATES.has(s.state)).length, total: list.length };
}

/** 一覧からサブエージェントの祖先を親に近い順に返します（詳細画面の「親」の表示に使います） */
export function ancestorsOf(subagents, id) {
  const byId = new Map((subagents || []).map((s) => [s.id, s]));
  const out = [];
  const seen = new Set([id]);
  for (let p = byId.get(byId.get(id)?.parentId); p && !seen.has(p.id); p = byId.get(p.parentId)) {
    seen.add(p.id);
    out.push(p);
  }
  return out;
}
