// public/images.js のテストです。会話表示のサムネイルの HTML を作る処理は DOM を使わないので Node から呼べます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageUrl, thumbsHtml } from '../public/images.js';

test('imageUrl はエージェント ID と参照をパスとしてエスケープする', () => {
  assert.equal(imageUrl('a1', 'toolu_01.0'), '/api/agents/a1/images/toolu_01.0');
  assert.equal(imageUrl('a/1', '../x?y'), '/api/agents/a%2F1/images/..%2Fx%3Fy');
});

test('thumbsHtml は画像 API を指すサムネイルを作り、属性をエスケープする', () => {
  const html = thumbsHtml('a1', [
    { ref: 'toolu_01.0', mime: 'image/png', width: 662, height: 936 },
    { ref: 'u-1.0', mime: 'image/"x"<' },
  ]);
  assert.equal(
    html,
    '<div class="thumbs">' +
      '<button type="button" class="thumb" data-src="/api/agents/a1/images/toolu_01.0" title="画像（image/png 662×936）を拡大表示">' +
      '<img src="/api/agents/a1/images/toolu_01.0" alt="画像（image/png 662×936）" loading="lazy" decoding="async"></button>' +
      '<button type="button" class="thumb" data-src="/api/agents/a1/images/u-1.0" title="画像（image/&quot;x&quot;&lt;）を拡大表示">' +
      '<img src="/api/agents/a1/images/u-1.0" alt="画像（image/&quot;x&quot;&lt;）" loading="lazy" decoding="async"></button>' +
      '</div>',
  );
});

test('thumbsHtml は画像がなければ空文字を返す', () => {
  assert.equal(thumbsHtml('a1', undefined), '');
  assert.equal(thumbsHtml('a1', []), '');
  assert.equal(thumbsHtml(null, [{ ref: 'x.0', mime: 'image/png' }]), '');
});
