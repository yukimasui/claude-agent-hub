// public/triage.js のテストです。提案の抽出と返信文の組み立ては DOM を使わないので Node から呼べます
// （localStorage や描画を扱う関数は対象外です）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardDetailHtml, composeReply, extractListItems, findOpenProposals, neighborId, parseProposals, viewerHtml } from '../public/triage.js';

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

test('閉じの無いブロックは提案として扱わない', () => {
  assert.equal(parseProposals('前置き\n```proposals\n{"items":[{"title":"A"}]}'), null);
});

test('複数のブロックがあれば、項目を取り出せる最初のブロックを使う', () => {
  // 書き損じたブロックの後に書き直したブロックが続く応答でも、仕分けボードを出せるようにします
  const text = `${block('{"items":[]}')}\n${block('{"title":"訂正版","items":[{"title":"A"}]}')}\n${block('[{"title":"B"}]')}`;
  assert.deepEqual(parseProposals(text), { title: '訂正版', items: [{ id: '1', title: 'A', detail: '' }] });
});

test('findOpenProposals は最後の利用者の発言より後で、項目を取り出せる最も新しい応答を返す', () => {
  const older = { role: 'assistant', text: block('[{"title":"古い"}]') };
  const newer = { role: 'assistant', text: block('[{"title":"新しい"}]') };
  const empty = { role: 'assistant', text: block('{"items":[]}') };
  const tool = { role: 'tool', name: 'Read', text: block('[{"title":"ツール"}]') };
  assert.equal(findOpenProposals([{ role: 'user', text: '調べて' }, older, newer, empty, tool]), newer);
  assert.equal(findOpenProposals([older, { role: 'user', text: '古い案で' }, empty]), null);
  assert.equal(findOpenProposals([{ role: 'user', text: '調べて' }, empty]), null);
  assert.equal(findOpenProposals([]), null);
});

test('ブロックの外にある箇条書きは提案として扱わない', () => {
  // 情報提供のための箇条書きを判断項目にしないため、仕分けはブロックがある応答だけを対象にする
  assert.equal(parseProposals('方法は次のとおりです。\n- FTP で送る\n- 共有フォルダを使う\n1. 申請する\n2. 手入力する'), null);
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

// ---------- 拡大表示 ----------

const viewerItems = [
  { id: '1', title: 'README を短くする', detail: '', decision: 'ok', note: '' },
  { id: '2', title: '**手順**を追加', detail: '理由:\n- 初めての人が迷う\n- `npm run dev` を載せる', decision: 'none', note: '' },
  { id: '3', title: '図を入れる', detail: '<script>alert(1)</script>', decision: 'change', note: '図は 1 枚に<b>' },
];

test('neighborId は提案に書かれた順で前後の id を返し、端や不明な id では null を返す', () => {
  // 判断で列が変わっても、元の並びで順に読み進められるようにします
  assert.equal(neighborId(viewerItems, '2', 1), '3');
  assert.equal(neighborId(viewerItems, '2', -1), '1');
  assert.equal(neighborId(viewerItems, '1', -1), null);
  assert.equal(neighborId(viewerItems, '3', 1), null);
  assert.equal(neighborId(viewerItems, '9', 1), null);
  assert.equal(neighborId(viewerItems, null, 1), null);
});

test('viewerHtml は補足を Markdown として描画し、位置と判断済みの件数を表示する', () => {
  const html = viewerHtml(viewerItems, '2');
  assert.match(html, /data-id="2" data-decision="none"/);
  assert.match(html, /提案 2 \/ 3/);
  assert.match(html, /3件中 2件を判断済み/);
  // 見出しのインライン装飾と、補足の箇条書き・コードが HTML になる
  assert.match(html, /<strong>手順<\/strong>を追加/);
  assert.match(html, /<ul><li>初めての人が迷う<\/li><li><code>npm run dev<\/code> を載せる<\/li><\/ul>/);
  // 中ほどの提案では前後どちらにも移動できる
  assert.doesNotMatch(html, /data-nav="-?1"[^>]*disabled/);
  // 未判断の提案では修正内容の入力欄を出さず、未判断のボタンだけが押された状態になる
  assert.doesNotMatch(html, /tri-note/);
  assert.match(html, /data-to="none" aria-pressed="true"/);
  assert.match(html, /data-to="ok" aria-pressed="false"/);
});

test('viewerHtml は「修正して実施」の提案に修正内容の入力欄を出し、内容をエスケープする', () => {
  const html = viewerHtml(viewerItems, '3');
  assert.match(html, /<textarea class="tri-note tv-note"[^>]*>図は 1 枚に&lt;b&gt;<\/textarea>/);
  assert.match(html, /data-to="change" aria-pressed="true"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // 最後の提案では「次へ」を押せない
  assert.match(html, /data-nav="1"[^>]*disabled/);
  assert.doesNotMatch(html, /data-nav="-1"[^>]*disabled/);
});

test('viewerHtml は補足の無い提案にその旨を表示し、見つからない id では空文字を返す', () => {
  const html = viewerHtml(viewerItems, '1');
  assert.match(html, /補足の説明はありません/);
  assert.match(html, /data-nav="-1"[^>]*disabled/);
  assert.equal(viewerHtml(viewerItems, '9'), '');
});

// ---------- カードの補足 ----------

test('cardDetailHtml は補足の箇条書きを Markdown として描画し、記号「- 」を本文に残さない', () => {
  const html = cardDetailHtml('理由: 読み手が迷う\n- 手順を足す\n- **短く**する');
  assert.equal(html, '<div class="tri-detail md"><p>理由: 読み手が迷う</p><ul><li>手順を足す</li><li><strong>短く</strong>する</li></ul></div>');
  assert.doesNotMatch(html, /- 手順/);
});

test('cardDetailHtml は改行を保ち、補足の HTML をエスケープし、補足が無ければ空文字を返す', () => {
  assert.equal(cardDetailHtml('一行目\n二行目'), '<div class="tri-detail md"><p>一行目<br>二行目</p></div>');
  assert.equal(cardDetailHtml('<script>alert(1)</script>'), '<div class="tri-detail md"><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></div>');
  assert.equal(cardDetailHtml(''), '');
});
