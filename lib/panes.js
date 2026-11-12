// tmux のペインがどのエージェントのものかを判定します。
// tmux のサーバーが終了すると（WSL の再起動など）、次のサーバーはペイン ID・ウィンドウ ID を最初から数え直すため、
// 終了済みのエージェントが覚えている ID が、後から作ったエージェントのペインに割り当てられることがあります（Issue #97）。
// ID があるかどうかだけで生存を判定すると、終了済みのエージェントが「生きている」ことになり、送信や削除も別のエージェントに効いてしまいます。
// そこで、ペインに付けたエージェント ID（@hub_agent）か、ペインのプロセスの環境変数 AGENT_HUB_AGENT で持ち主を確かめます。
// tmux の操作やファイルの読み出しは呼び出し側が行い、ここでは結果だけから判断します。

/** ペインに付けるエージェント ID のオプション名です */
export const OWNER_OPTION = '@hub_agent';

/** list-panes の書式です。値に空白が入っても列がずれないよう、タブで区切ります */
export const PANE_FORMAT = ['#{pane_id}', '#{pane_dead}', '#{window_id}', '#{pane_pid}', `#{${OWNER_OPTION}}`].join('\t');

/** /proc/<pid>/environ の内容（NUL 区切り）から AGENT_HUB_AGENT の値を返します。なければ空文字です */
export function agentIdFromEnviron(buf) {
  for (const entry of buf.toString('utf8').split('\0')) {
    if (entry.startsWith('AGENT_HUB_AGENT=')) return entry.slice('AGENT_HUB_AGENT='.length);
  }
  return '';
}

/**
 * PANE_FORMAT で取った list-panes の出力を Map<paneId, {dead, windowId, owner}> にします。
 * owner はペインの持ち主のエージェント ID です。空文字はハブのエージェントのものではないこと、null は分からないことを表します。
 * - ペインに付けたエージェント ID があれば、それを使います（ハブが作成・起動し直したときに付けます）
 * - なければ（エージェント ID を付けるしくみより前に作ったウィンドウ）、動いているペインのプロセスの環境変数から求めます。ハブはペインのプロセスに -e で
 *   AGENT_HUB_AGENT を渡して起動するため、プロセスが読めればその値（なければ空文字）が持ち主です
 * - 終了したペインの PID は別のプロセスに使い回されているおそれがあるため、環境変数を読まず、持ち主を分からないものとします
 * readEnviron(pid) は環境変数の内容（Buffer）を返し、読めなければ null を返す関数です（lib/tmux.js の readEnviron。内容が空の場合も null です）
 */
export function parsePanes(out, readEnviron) {
  const map = new Map();
  for (const line of out.split('\n')) {
    const [paneId, dead, windowId, pid, option] = line.trim().split('\t');
    if (!paneId) continue;
    const isDead = dead === '1';
    let owner = option || null;
    if (!owner && !isDead && pid) {
      const env = readEnviron(pid);
      if (env) owner = agentIdFromEnviron(env);
    }
    map.set(paneId, { dead: isDead, windowId, owner });
  }
  return map;
}

/** ペインを割り当てられた時刻の目安です。起動し直すたびに更新される processStartedAt を優先し、なければ作成時刻を使います */
const assignedAt = (a) => a.processStartedAt ?? a.createdAt ?? 0;

/**
 * 各エージェントが今そのペインを持っているかを判定し、Map<agentId, {pane, foreign}> で返します。
 * - pane: そのエージェントのペイン（parsePanes の値）。持っていなければ null です
 * - foreign: 覚えているペイン ID かウィンドウ ID が、今は別のエージェント（またはハブのものではないウィンドウ）に使われていることを表します。
 *   この場合、呼び出し側は ID を消して、削除・画面の取得・ステータス行の更新などが別のウィンドウに効かないようにします
 * ペインの持ち主は次のように決めます。
 * - 持ち主が分かるペインは、そのエージェントだけのものです
 * - 持ち主が分からないペインは、指しているエージェントのうち、ペインを後から割り当てられたものの持ち主とします。
 *   tmux の ID は 1 つのサーバーの中では使い回されないため、同じ ID を複数のエージェントが覚えていれば、後の割り当てが今のペインです。
 *   指しているエージェントが 1 つだけなら、ID だけで判定していたときと同じく、そのエージェントのものになります
 * これにより、同じペイン ID を覚えているエージェントが複数あっても、ペインを持つのは多くても 1 つになります
 */
export function resolvePanes(agents, panes) {
  // ペインごとの持ち主です。持ち主が分からず、指しているエージェントもいなければ null のままにします
  const claimants = new Map();
  for (const a of agents) {
    if (!a.paneId || !panes.has(a.paneId)) continue;
    const prev = claimants.get(a.paneId);
    if (!prev || assignedAt(a) > assignedAt(prev)) claimants.set(a.paneId, a);
  }
  const ownerOf = (paneId, pane) => (pane.owner != null ? pane.owner : claimants.get(paneId)?.id ?? null);

  const result = new Map();
  for (const a of agents) {
    const p = a.paneId ? panes.get(a.paneId) : undefined;
    if (p && ownerOf(a.paneId, p) === a.id) {
      result.set(a.id, { pane: p, foreign: false });
      continue;
    }
    // 持ち主が分からないまま（null）のペインは、判断の材料がないため別のもの扱いにしません
    let foreign = false;
    for (const [paneId, q] of panes) {
      if (paneId !== a.paneId && (!a.windowId || q.windowId !== a.windowId)) continue;
      const owner = ownerOf(paneId, q);
      if (owner != null && owner !== a.id) foreign = true;
    }
    result.set(a.id, { pane: null, foreign });
  }
  return result;
}

/** 持ち主が別のエージェントかハブのものではないために操作を止めたときの、エージェントがこの先どうなるかの説明です */
export const FOREIGN_HINT = '数秒で状態が「終了」に更新されます。再起動すると新しいウィンドウで起動します';

/** 操作を止めた理由の文です。outcome は「送信しませんでした」のように、止めた操作を表す文です */
const foreignReason = (target, outcome) => `このエージェントの${target}は、別のエージェント（またはハブのものではないウィンドウ）に使われているため、${outcome}`;

/**
 * 送信（文字の貼り付けやキーの送信）や画面の取得の直前に確かめたペインが、そのエージェントのものでなければ、操作しない理由を返します（操作してよければ null）。
 * pane は parsePanes の値で、ペインを確かめられなかったときは undefined です。outcome は理由の後半に入れる、止めた操作を表す文です。
 * 生存確認は 2 秒ごとのため、その間に tmux のサーバーが変わってペイン ID が別のエージェントのペインに割り当てられると、
 * 送信が別のエージェントに届いたり、別のエージェントの画面を表示したりするおそれがあります。それを防ぐため、操作のたびに持ち主を確かめます。
 * - 持ち主がそのエージェントなら操作します
 * - 持ち主が別のエージェントか、ハブのものではない（空文字）なら操作しません
 * - 持ち主が分からない（null。オプションを付ける前に作ったペインで /proc を読めない場合など）か、ペインを確かめられなかったときは操作します。
 *   判断の材料がないのに止めると正当な操作までできなくなるためで、持ち主の判定は生存確認（resolvePanes）に任せます
 */
export function paneTargetBlockReason(agentId, pane, outcome) {
  if (!pane || pane.owner == null || pane.owner === agentId) return null;
  return foreignReason('ペイン', outcome);
}

/**
 * 削除・「tmux で表示」・ステータス行の更新の直前に確かめたウィンドウが、そのエージェントのものでなければ、操作しない理由を返します（操作してよければ null）。
 * これらはウィンドウ ID で操作するため、ウィンドウ内のペインの持ち主で判定します。panes はウィンドウ内のペイン（parsePanes の値）の並びで、
 * ウィンドウを確かめられなかったときは undefined です。考え方はペインの判定（paneTargetBlockReason）にそろえ、次のように決めます。
 * - 別のエージェントのペインが 1 つでもあれば操作しません。ウィンドウを閉じると、そのエージェントの作業が失われるためです
 * - そうでなく、そのエージェントのペインがあれば操作します。ハブが作ったウィンドウを利用者が分割した場合、分割したペインは
 *   ハブのものではないペイン（空文字）に見えますが、それを理由に止めると自分のウィンドウを閉じられなくなるためです
 * - そうでなく、ハブのものではないペインがあれば操作しません（ウィンドウ ID が利用者の作ったウィンドウに割り当てられた場合です）
 * - 持ち主が分かるペインがない（分からないものだけか、確かめられなかった）ときは、送信と同じく正当な操作を止めないよう操作します
 */
export function windowTargetBlockReason(agentId, panes, outcome) {
  const owners = [...(panes ?? [])].map((p) => p.owner).filter((o) => o != null);
  if (owners.some((o) => o && o !== agentId)) return foreignReason('ウィンドウ', outcome);
  if (owners.includes(agentId)) return null;
  return owners.length ? foreignReason('ウィンドウ', outcome) : null;
}
