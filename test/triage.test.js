// public/triage.js のテストです。提案の抽出と返信文の組み立ては DOM を使わないので Node から呼べます
// （localStorage や描画を扱う関数は対象外です）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeReply, extractListItems, parseProposals } from '../public/triage.js';

const block = (body) => `前置きの説明\n\`\`\`proposals\n${body}\n\`\`\`\n後書き`;

test('proposals ブロックの JSON から見出しと項目を取り出す', () => {
  const r = parseProposals(block('{"title":"改善案","items":[{"id":1,"title":" A "},{"title":""},{"summary":"B","description":"説明"}]}'));
  // id は文字列にそろえ、タイトルが空の項目は捨てる。id が無い項目は位置から番号を振る
  assert.deepEqual(r, {
    title: '改善案',
    items: [
      { id: '1', title: 'A', detail: '' },
      { id: '3', title: 'B', detail: '説明' },
    ],
  });
});

test('配列だけの JSON は既定の見出しを使う', () => {
  assert.deepEqual(parseProposals(block('[{"text":"X"}]')), { title: '提案', items: [{ id: '1', title: 'X', detail: '' }] });
});

test('JSON として読めないブロックは箇条書きとして読む', () => {
  assert.deepEqual(parseProposals(block('1. 一\n2. 二')), {
    title: '提案',
    items: [
      { id: '1', title: '一', detail: '' },
      { id: '2', title: '二', detail: '' },
    ],
  });
});

test('ブロックが無い、または項目が無ければ null を返す', () => {
  assert.equal(parseProposals('提案はありません'), null);
  assert.equal(parseProposals(block('{"items":[]}')), null);
  assert.equal(parseProposals(null), null);
});

test('extractListItems はトップレベルの項目を取り出し、字下げした行を補足にまとめる', () => {
  const text = '説明\n1. 一つ目\n   補足\n   - 詳細\n2) 二つ目\n```\n- コード内は対象外\n```\n- 箇条\n* 箇条2\n';
  assert.deepEqual(extractListItems(text), [
    { id: '1', title: '一つ目', detail: '補足\n・詳細' },
    { id: '2', title: '二つ目', detail: '' },
    { id: '3', title: '箇条', detail: '' },
    { id: '4', title: '箇条2', detail: '' },
  ]);
});

test('composeReply は判断ごとに項目をまとめ、最後に指示を添える', () => {
  const text = composeReply({
    comment: ' 全体的に短めで ',
    items: [
      { id: '1', title: 'A', decision: 'ok' },
      { id: '2', title: 'B', decision: 'ng' },
      { id: '3', title: 'C', decision: 'change', note: ' 短く ' },
      { id: '4', title: 'D', decision: 'change', note: '' },
      { id: '5', title: 'E', decision: 'none' },
    ],
  });
  assert.equal(
    text,
    [
      '提案への判断です。',
      '【採用】\n- 1. A',
      '【修正して実施】\n- 3. C\n  → 指示: 短く\n- 4. D\n  → 指示: （修正内容は相談したい）',
      '【却下】\n- 2. B',
      '【保留（今回は判断しない）】\n- 5. E',
      '補足: 全体的に短めで',
      '採用・修正の項目を進めてください。却下の項目は対応不要です。保留の項目には手を付けないでください。',
    ].join('\n\n'),
  );
});

test('composeReply は該当の無い節と補足を省く', () => {
  assert.equal(composeReply({ items: [{ id: '1', title: 'A', decision: 'ng' }] }), '提案への判断です。\n\n【却下】\n- 1. A\n\n却下の項目は対応不要です。');
});
