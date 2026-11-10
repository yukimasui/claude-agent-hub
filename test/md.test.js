// public/md.js のテストです。ブラウザ用のモジュールですが、renderMarkdown / inline / esc は DOM を使わないので Node から呼べます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, inline, renderMarkdown } from '../public/md.js';

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
    '<div class="proposals-block"><div class="pb-head">改善案</div><ol><li><b><strong>短く</strong></b><div class="muted">説明</div></li></ol></div>',
  );
  assert.equal(renderMarkdown('```proposals\n壊れた\n```'), '<pre class="code" data-lang="proposals">壊れた</pre>');
});
