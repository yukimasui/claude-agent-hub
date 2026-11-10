// public/md.js のテストです。ブラウザ用のモジュールですが、renderMarkdown / inline / esc は DOM を使わないので Node から呼べます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, inline, renderMarkdown, retryingLoader } from '../public/md.js';

const LINK = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

test('esc は HTML の特殊文字をすべて置き換える', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('本文中の HTML はエスケープして段落にする', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script> & "x"'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>');
});

test('インライン装飾とコード（コード内は装飾しない）', () => {
  assert.equal(
    inline('**太字** と *斜体* と `**code** <b>` と ~~消し~~'),
    '<strong>太字</strong> と <em>斜体</em> と <code>**code** &lt;b&gt;</code> と <del>消し</del>',
  );
});

test('リンクは http(s) だけを有効にする', () => {
  assert.equal(
    inline('[リンク](https://example.com) と [悪い](javascript:alert(1)) と https://a.example/x'),
    `${LINK('https://example.com', 'リンク')} と [悪い](javascript:alert(1)) と ${LINK('https://a.example/x', 'https://a.example/x')}`,
  );
});

test('見出し・引用・水平線・段落の改行', () => {
  assert.equal(renderMarkdown('## 見出し ##'), '<h2 class="md-h">見出し</h2>');
  assert.equal(
    renderMarkdown('> 引用\n> 2 行目\n\n---\n段落1\n段落1続き\n# 見出し'),
    '<blockquote><p>引用<br>2 行目</p></blockquote><hr><p>段落1<br>段落1続き</p><h1 class="md-h">見出し</h1>',
  );
});

test('入れ子のリスト・タスク・番号の開始値・継続行', () => {
  assert.equal(
    renderMarkdown('- a\n  - b\n- [x] 済\n- [ ] 未'),
    '<ul><li>a<ul><li>b</li></ul></li><li class="task"><input type="checkbox" disabled checked> 済</li><li class="task"><input type="checkbox" disabled> 未</li></ul>',
  );
  assert.equal(renderMarkdown('3. 三\n4. 四'), '<ol start="3"><li>三</li><li>四</li></ol>');
  assert.equal(renderMarkdown('- a\n  続き\n- b'), '<ul><li>a<br>続き</li><li>b</li></ul>');
});

test('表は配置を反映し、エスケープされた | をセル内に残す', () => {
  assert.equal(
    renderMarkdown('| 左 | 中 | 右 |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| a \\| b |'),
    '<div class="table-wrap"><table><thead><tr><th>左</th><th style="text-align:center">中</th><th style="text-align:right">右</th></tr></thead>' +
      '<tbody><tr><td>1</td><td style="text-align:center">2</td><td style="text-align:right">3</td></tr>' +
      '<tr><td>a | b</td><td style="text-align:center"></td><td style="text-align:right"></td></tr></tbody></table></div>',
  );
});

test('コードブロックは中身をエスケープし、mermaid は図にする枠で包む', () => {
  assert.equal(renderMarkdown('```js\nconst a = "<x>";\n```'), '<pre class="code" data-lang="js">const a = &quot;&lt;x&gt;&quot;;</pre>');
  assert.equal(renderMarkdown('```mermaid\ngraph TD; A-->B\n```'), '<div class="mermaid-block"><pre class="code" data-lang="mermaid">graph TD; A--&gt;B</pre></div>');
});

test('proposals ブロックは提案の一覧として表示し、JSON が壊れていればコードのまま表示する', () => {
  assert.equal(
    renderMarkdown('```proposals\n{"title":"改善案","items":[{"id":"1","title":"**短く**","detail":"説明"}]}\n```'),
    '<div class="proposals-block"><div class="pb-head">改善案</div><ol><li><b><strong>短く</strong></b><div class="pb-detail md"><p>説明</p></div></li></ol></div>',
  );
  assert.equal(renderMarkdown('```proposals\n壊れた\n```'), '<pre class="code" data-lang="proposals">壊れた</pre>');
});

test('proposals ブロックの補足は Markdown として描画し、改行と箇条書きを保つ', () => {
  // 補足を 1 行のインライン要素にすると、改行が失われ「- 」も本文に混ざって詰まって見えるため
  const detail = '理由: 読み手が迷う\n変更: 次の 2 点\n- 手順を足す\n- `npm test` を載せる';
  const html = renderMarkdown('```proposals\n' + JSON.stringify({ items: [{ title: 'A', detail }] }) + '\n```');
  assert.match(
    html,
    /<div class="pb-detail md"><p>理由: 読み手が迷う<br>変更: 次の 2 点<\/p><ul><li>手順を足す<\/li><li><code>npm test<\/code> を載せる<\/li><\/ul><\/div>/,
  );
});

test('補足にコードブロックを含む proposals ブロックも崩れずに表示する', () => {
  // JSON の文字列の中の区切りは行頭に来ないため、ブロックの終わりとはみなしません
  const detail = '例:\n```bash\nnpm test\n```\nを追記する';
  const json = { title: '改善案', items: [{ title: 'A', detail }, { title: 'B' }] };
  for (const body of [JSON.stringify(json), JSON.stringify(json, null, 2)]) {
    const html = renderMarkdown('前置き\n```proposals\n' + body + '\n```\n後書き');
    assert.match(html, /^<p>前置き<\/p><div class="proposals-block"><div class="pb-head">改善案<\/div><ol>/);
    assert.match(html, /<div class="pb-detail md"><p>例:<\/p><pre class="code" data-lang="bash">npm test<\/pre><p>を追記する<\/p><\/div>/);
    assert.match(html, /<li><b>B<\/b><\/li><\/ol><\/div><p>後書き<\/p>$/);
  }
});

test('proposals ブロックの補足は HTML として解釈しない', () => {
  const html = renderMarkdown('```proposals\n' + JSON.stringify({ items: [{ title: 'A', detail: '<img src=x onerror=alert(1)>\n- <b>太字</b>' }] }) + '\n```');
  assert.doesNotMatch(html, /<img|<b>太字/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<li>&lt;b&gt;太字&lt;\/b&gt;<\/li>/);
});

test('retryingLoader は失敗した読み込みを保持せず、間隔を空けて再試行する', async () => {
  let t = 0;
  let calls = 0;
  let fail = true;
  const load = retryingLoader(
    async () => {
      calls++;
      if (fail) throw new Error('読み込み失敗');
      return 'ok';
    },
    { retryAfterMs: 10_000, now: () => t },
  );
  await assert.rejects(load());
  assert.equal(calls, 1);
  // 失敗の直後は、描画のたびに要求を繰り返さないよう、読み込まずに失敗を返します
  t = 5_000;
  await assert.rejects(load());
  assert.equal(calls, 1);
  // 間隔を空けた後は再試行し、成功した結果はその後も使い回します
  t = 10_000;
  fail = false;
  assert.equal(await load(), 'ok');
  assert.equal(calls, 2);
  assert.equal(await load(), 'ok');
  assert.equal(calls, 2);
});

test('retryingLoader は読み込み中の要求を 1 つにまとめる', async () => {
  let calls = 0;
  let release;
  const load = retryingLoader(() => {
    calls++;
    return new Promise((r) => (release = r));
  });
  const a = load();
  const b = load();
  // 読み込みは次のマイクロタスクで始まるため、始まるのを待ってから完了させます
  await new Promise((r) => setImmediate(r));
  release('ok');
  assert.deepEqual(await Promise.all([a, b]), ['ok', 'ok']);
  assert.equal(calls, 1);
});
