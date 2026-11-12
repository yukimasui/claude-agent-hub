// lib/panes.js のテストです。tmux のペインがどのエージェントのものかの判定を、tmux を起動せずに確かめます。
// tmux のサーバーが終了した後に作ったエージェントが、終了済みのエージェントと同じペイン ID・ウィンドウ ID を割り当てられる場合（Issue #97）を中心にしています。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANE_FORMAT, agentIdFromEnviron, paneTargetBlockReason, parsePanes, resolvePanes, windowTargetBlockReason } from '../lib/panes.js';

/** ペインの一覧（listPanes が返す形）を作ります。owner は確かめた持ち主で、null は分からないことを表します */
const panesOf = (...list) => new Map(list.map(({ paneId, dead = false, windowId, owner = null }) => [paneId, { dead, windowId, owner }]));
/** ペイン ID・ウィンドウ ID を持つエージェントを作ります */
const agent = (id, fields = {}) => ({ id, paneId: '%2', windowId: '@2', createdAt: 1, processStartedAt: null, ...fields });

// 本番で起きた例です。「技術論文」は tmux のサーバーの終了前、「3Dアニメーションキット」は終了後に作られ、どちらも @2 / %2 を持っています
const OLD = agent('adf467bc5', { createdAt: 1000, processStartedAt: 2000 });
const NEW = agent('a8208aa14', { createdAt: 5000, processStartedAt: 5100 });

test('ペインに付けたエージェント ID と一致するエージェントだけがペインを持ち、もう一方は別のエージェントのペインを指しているとみなす', () => {
  const panes = panesOf({ paneId: '%2', windowId: '@2', owner: 'a8208aa14' });
  const r = resolvePanes([OLD, NEW], panes);
  assert.deepEqual(r.get('a8208aa14'), { pane: panes.get('%2'), foreign: false });
  assert.deepEqual(r.get('adf467bc5'), { pane: null, foreign: true });
});

test('持ち主が古いエージェントと分かれば、作成や起動が新しいエージェントのほうが持ち主にならない', () => {
  // ペイン ID だけで判断して新しいほうを選ぶと、持ち主を確かめた結果と食い違うためです
  const panes = panesOf({ paneId: '%2', windowId: '@2', owner: 'adf467bc5' });
  const r = resolvePanes([OLD, NEW], panes);
  assert.equal(r.get('adf467bc5').pane, panes.get('%2'));
  assert.deepEqual(r.get('a8208aa14'), { pane: null, foreign: true });
});

test('持ち主が分からないペインを複数のエージェントが指していれば、ペインを後から割り当てられたほうを持ち主とする', () => {
  // エージェント ID を付けるしくみより前に作ったウィンドウで、プロセスが終了して環境変数も読めない場合です。tmux の ID は 1 つのサーバーの中で使い回されないため、後の割り当てが今のペインです
  const panes = panesOf({ paneId: '%2', windowId: '@2', dead: true, owner: null });
  const r = resolvePanes([OLD, NEW], panes);
  assert.equal(r.get('a8208aa14').pane, panes.get('%2'));
  assert.deepEqual(r.get('adf467bc5'), { pane: null, foreign: true });
  // processStartedAt がないときは作成時刻で比べます
  const r2 = resolvePanes([{ ...OLD, processStartedAt: null }, { ...NEW, processStartedAt: null }], panes);
  assert.equal(r2.get('a8208aa14').pane, panes.get('%2'));
  assert.equal(r2.get('adf467bc5').pane, null);
});

test('同じペインを指すエージェントが 2 つあっても、生きていると判定されるのは 1 つだけになる', () => {
  for (const owner of ['a8208aa14', 'adf467bc5', null]) {
    const panes = panesOf({ paneId: '%2', windowId: '@2', owner });
    const r = resolvePanes([OLD, NEW], panes);
    const alive = [OLD, NEW].filter((a) => r.get(a.id).pane && !r.get(a.id).pane.dead);
    assert.equal(alive.length, 1, `owner=${owner}`);
  }
});

test('持ち主が分からないペインを 1 つのエージェントだけが指していれば、そのエージェントのものとする', () => {
  // 環境変数を読めない環境（/proc がないなど）でも、重なりがなければ ID だけで判定していたときと同じ結果にします
  const panes = panesOf({ paneId: '%2', windowId: '@2', owner: null });
  const r = resolvePanes([OLD], panes);
  assert.deepEqual(r.get('adf467bc5'), { pane: panes.get('%2'), foreign: false });
});

test('ハブのエージェントではないペイン（持ち主が空）は、指しているエージェントのものにしない', () => {
  // 利用者が tmux のセッションに手で開いたウィンドウが、終了済みのエージェントと同じ ID を得た場合です
  const panes = panesOf({ paneId: '%2', windowId: '@2', owner: '' });
  assert.deepEqual(resolvePanes([OLD], panes).get('adf467bc5'), { pane: null, foreign: true });
});

test('ウィンドウ ID だけが別のエージェントのものと重なっても、別のエージェントのウィンドウを指しているとみなす', () => {
  // ウィンドウ ID とペイン ID は別々に数えられるため、ウィンドウ ID だけが重なることもあります。そのまま残すと「削除」が別のウィンドウを閉じます
  const a = agent('adf467bc5', { paneId: '%2', windowId: '@2' });
  const b = agent('a8208aa14', { paneId: '%3', windowId: '@2', createdAt: 5000 });
  const panes = panesOf({ paneId: '%3', windowId: '@2', owner: 'a8208aa14' });
  const r = resolvePanes([a, b], panes);
  assert.deepEqual(r.get('adf467bc5'), { pane: null, foreign: true });
  assert.equal(r.get('a8208aa14').pane, panes.get('%3'));
});

test('ペインもウィンドウも見つからなければ、ペインを持たず、別のエージェントのものを指してもいないとする', () => {
  // tmux の一覧の取得に一時的に失敗した場合も空になるため、ID を消す判断には使いません
  assert.deepEqual(resolvePanes([OLD], new Map()).get('adf467bc5'), { pane: null, foreign: false });
  // ペイン ID・ウィンドウ ID を持たないエージェントも同じです
  const r = resolvePanes([agent('a1', { paneId: null, windowId: null })], panesOf({ paneId: '%2', windowId: '@2', owner: 'a2' }));
  assert.deepEqual(r.get('a1'), { pane: null, foreign: false });
});

test('持ち主が分からず、だれも指していないペインと同じウィンドウ ID は、別のエージェントのものとはみなさない', () => {
  // 判断の材料がないまま ID を消すと、ウィンドウを操作できなくなるためです
  const a = agent('a1', { paneId: '%9', windowId: '@2' });
  assert.deepEqual(resolvePanes([a], panesOf({ paneId: '%3', windowId: '@2', owner: null })).get('a1'), { pane: null, foreign: false });
});

test('プロセスの環境変数から AGENT_HUB_AGENT の値を取り出す', () => {
  const env = (...vars) => Buffer.from(vars.map((v) => v + '\0').join(''));
  assert.equal(agentIdFromEnviron(env('PATH=/usr/bin', 'AGENT_HUB_AGENT=a8208aa14', 'TMUX_PANE=%2')), 'a8208aa14');
  assert.equal(agentIdFromEnviron(env('PATH=/usr/bin', 'XAGENT_HUB_AGENT=a1')), '');
  assert.equal(agentIdFromEnviron(Buffer.alloc(0)), '');
});

test('ペインの一覧は、付けたエージェント ID を優先し、なければ動いているプロセスの環境変数から持ち主を求める', () => {
  const reads = [];
  const readEnviron = (pid) => {
    reads.push(pid);
    if (pid === '200') return Buffer.from('AGENT_HUB_AGENT=a8208aa14\0');
    if (pid === '300') return Buffer.from('PATH=/usr/bin\0');
    return null; // 読めないプロセスです
  };
  const out = [
    ['%1', '0', '@1', '100', 'a1'].join('\t'),
    ['%2', '0', '@2', '200', ''].join('\t'),
    ['%3', '0', '@3', '300', ''].join('\t'),
    ['%4', '0', '@4', '400', ''].join('\t'),
    // 終了したペインの PID は別のプロセスに使い回されているおそれがあるため、環境変数を読みません
    ['%5', '1', '@5', '500', ''].join('\t'),
    ['%6', '1', '@6', '600', 'a6'].join('\t'),
    '',
  ].join('\n');
  const panes = parsePanes(out, readEnviron);
  assert.deepEqual(Object.fromEntries(panes), {
    '%1': { dead: false, windowId: '@1', owner: 'a1' },
    '%2': { dead: false, windowId: '@2', owner: 'a8208aa14' },
    '%3': { dead: false, windowId: '@3', owner: '' },
    '%4': { dead: false, windowId: '@4', owner: null },
    '%5': { dead: true, windowId: '@5', owner: null },
    '%6': { dead: true, windowId: '@6', owner: 'a6' },
  });
  assert.deepEqual(reads, ['200', '300', '400']);
  // 一覧の書式は、parsePanes が読む列の順に合わせています
  assert.equal(PANE_FORMAT.split('\t').length, 5);
});

test('操作の直前に確かめたペインが別のエージェントのもの（またはハブのものではない）なら、操作しない理由を返す', () => {
  // 生存確認（2 秒ごと）の間にペインの ID が重なった場合に、送信や画面の取得が別のエージェントに効くのを防ぐためです
  const block = (pane) => paneTargetBlockReason('a1', pane, '送信しませんでした');
  assert.equal(block({ dead: false, windowId: '@2', owner: 'a1' }), null);
  assert.match(block({ dead: false, windowId: '@2', owner: 'a2' }), /別のエージェント.*送信しませんでした/);
  assert.match(block({ dead: false, windowId: '@2', owner: '' }), /別のエージェント.*送信しませんでした/);
  // 理由の後半は、操作ごとに渡した文になります
  assert.match(paneTargetBlockReason('a1', { dead: false, windowId: '@2', owner: 'a2' }, '画面を取得しませんでした'), /画面を取得しませんでした$/);
});

test('操作の直前にペインの持ち主を確かめられなければ、操作を止めない', () => {
  // オプションを付ける前に作ったペインで /proc を読めない環境や、ペインを確かめられなかった場合（tmux の失敗など）です。
  // 判断の材料がないのに止めると、正当な操作までできなくなるため、これまでどおり操作します（持ち主の判定は生存確認に任せます）
  assert.equal(paneTargetBlockReason('a1', { dead: false, windowId: '@2', owner: null }, '送信しませんでした'), null);
  assert.equal(paneTargetBlockReason('a1', undefined, '送信しませんでした'), null);
});

/** ウィンドウ内のペインの一覧（parsePanes の値の並び）を、持ち主だけから作ります */
const windowOf = (...owners) => owners.map((owner) => ({ dead: false, windowId: '@2', owner }));

test('ウィンドウ内に別のエージェントのペインがあれば、ウィンドウを操作しない理由を返す', () => {
  // 削除はウィンドウごと閉じるため、別のエージェントのペインが 1 つでもあれば、その作業を失わせないよう止めます
  const block = (panes) => windowTargetBlockReason('a1', panes, 'ウィンドウを閉じませんでした');
  assert.match(block(windowOf('a2')), /別のエージェント.*ウィンドウを閉じませんでした$/);
  assert.match(block(windowOf('a1', 'a2')), /別のエージェント/);
  // 持ち主が分からないペインがあっても、別のエージェントのペインがあれば止めます
  assert.match(block(windowOf(null, 'a2')), /別のエージェント/);
});

test('ウィンドウ内にハブのものではないペインしかなければ、ウィンドウを操作しない理由を返す', () => {
  // tmux のサーバーが変わって、ウィンドウ ID が利用者の作ったウィンドウに割り当てられた場合です
  assert.match(windowTargetBlockReason('a1', windowOf(''), 'tmux で表示しませんでした'), /ハブのものではない.*tmux で表示しませんでした$/);
  assert.match(windowTargetBlockReason('a1', windowOf('', null), 'tmux で表示しませんでした'), /ハブのもの/);
});

test('ウィンドウ内にそのエージェントのペインがあれば、利用者が分割したペインがあってもウィンドウを操作する', () => {
  // ハブが作ったウィンドウを利用者が分割すると、分割したペインにはエージェント ID がなく、ハブのものではないペインに見えます。
  // それを理由に止めると、自分のウィンドウを閉じたり前面に出したりできなくなるため、自分のペインがあれば操作します
  assert.equal(windowTargetBlockReason('a1', windowOf('a1'), 'ウィンドウを閉じませんでした'), null);
  assert.equal(windowTargetBlockReason('a1', windowOf('a1', ''), 'ウィンドウを閉じませんでした'), null);
  assert.equal(windowTargetBlockReason('a1', windowOf('a1', null), 'ウィンドウを閉じませんでした'), null);
});

test('ウィンドウ内のペインの持ち主を確かめられなければ、ウィンドウの操作を止めない', () => {
  // 送信と同じく、判断の材料がないのに止めると正当な削除や表示までできなくなるためです
  assert.equal(windowTargetBlockReason('a1', windowOf(null), 'ウィンドウを閉じませんでした'), null);
  assert.equal(windowTargetBlockReason('a1', windowOf(null, null), 'ウィンドウを閉じませんでした'), null);
  assert.equal(windowTargetBlockReason('a1', [], 'ウィンドウを閉じませんでした'), null);
  assert.equal(windowTargetBlockReason('a1', undefined, 'ウィンドウを閉じませんでした'), null);
});
