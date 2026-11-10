// 会話表示に画像のサムネイルを出すための処理です。
// 会話の項目には画像の参照（ref・MIME タイプ・寸法）だけが入っているので、画像本体は画像 API から読み込みます。
// テストできるよう DOM には触れず、HTML の文字列を返します（クリック時の拡大表示は app.js で行います）。
import { esc } from './md.js';

export function imageUrl(agentId, ref) {
  return `/api/agents/${encodeURIComponent(agentId)}/images/${encodeURIComponent(ref)}`;
}

/** 画像の参照の配列からサムネイルの HTML を作ります。画像がなければ空文字を返します */
export function thumbsHtml(agentId, images) {
  if (!agentId || !Array.isArray(images) || !images.length) return '';
  const thumbs = images.map((im) => {
    const url = imageUrl(agentId, im.ref);
    const size = im.width && im.height ? ` ${im.width}×${im.height}` : '';
    const label = `画像（${im.mime}${size}）`;
    return `<button type="button" class="thumb" data-src="${esc(url)}" title="${esc(label)}を拡大表示"><img src="${esc(url)}" alt="${esc(label)}" loading="lazy" decoding="async"></button>`;
  });
  return `<div class="thumbs">${thumbs.join('')}</div>`;
}
