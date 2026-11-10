// サイドバーのサブエージェントのツリーの組み立て（public/subagents.js）のテストです。DOM を使わないので Node から呼べます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestorsOf, buildTree, subagentCounts, subagentRows } from '../public/subagents.js';

const sub = (id, state, parentId = null) => ({ id, state, parentId });

test('親子関係からツリーを作り、親が見つからないものや循環しているものは最上位に置く', () => {
  const roots = buildTree([sub('a', 'done'), sub('b', 'running', 'a'), sub('c', 'done', 'b'), sub('d', 'done', 'zzz'), sub('x', 'done', 'y'), sub('y', 'done', 'x'), sub('s', 'done', 's')]);
  const shape = (n) => [n.sub.id, n.children.map(shape)];
  assert.deepEqual(roots.map(shape), [
    ['a', [['b', [['c', []]]]]],
    ['d', []],
    ['x', []],
    ['y', []],
    ['s', []],
  ]);
});

test('終わったものは新しい 3 件だけを表示し、作業中のもの（と祖先）は常に表示する', () => {
  const list = [sub('f1', 'done'), sub('f2', 'failed'), sub('f2c', 'done', 'f2'), sub('r1', 'running'), sub('f3', 'done'), sub('w1', 'done'), sub('w1c', 'waiting', 'w1'), sub('f4', 'ended'), sub('f5', 'done')];
  const rows = subagentRows(list);
  // f1・f2（とその子）が隠れ、件数には入れ子も含めます
  assert.deepEqual(rows[0], { type: 'more', hidden: 3, expanded: false });
  assert.deepEqual(
    rows.slice(1).map((r) => [r.sub.id, r.depth, r.last]),
    [
      ['r1', 0, false],
      ['f3', 0, false],
      ['w1', 0, false],
      ['w1c', 1, true],
      ['f4', 0, false],
      ['f5', 0, true],
    ],
  );
  const all = subagentRows(list, { expanded: true });
  assert.deepEqual(all[0], { type: 'more', hidden: 3, expanded: true });
  assert.deepEqual(all.slice(1).map((r) => r.sub.id), ['f1', 'f2', 'f2c', 'r1', 'f3', 'w1', 'w1c', 'f4', 'f5']);
  // 隠すものが無ければ切り替えの行は出しません
  assert.deepEqual(subagentRows([sub('a', 'done')]).map((r) => r.type), ['sub']);
  assert.deepEqual(subagentRows([]), []);
});

test('作業中の件数と祖先を求める', () => {
  const list = [sub('a', 'running'), sub('b', 'waiting', 'a'), sub('c', 'done', 'b'), sub('d', 'done')];
  assert.deepEqual(subagentCounts(list), { active: 2, total: 4 });
  assert.deepEqual(subagentCounts(undefined), { active: 0, total: 0 });
  assert.deepEqual(ancestorsOf(list, 'c').map((s) => s.id), ['b', 'a']);
  assert.deepEqual(ancestorsOf(list, 'a'), []);
  assert.deepEqual(ancestorsOf([sub('x', 'done', 'y'), sub('y', 'done', 'x')], 'x').map((s) => s.id), ['y']);
});
