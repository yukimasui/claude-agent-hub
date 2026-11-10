// HTTP の要求の確認と、画像の応答を書き出す処理です。
// server.js から切り出しているのは、HTTP サーバ全体（tmux の操作を含む）を起動せずに単体テストで確かめるためです。
import { IMAGE_TYPES } from './transcript.js';

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ローカル専用のツールなので、DNS rebinding や他のサイトからの CSRF を防ぐため、Host と Origin を確認します
export function checkRequest(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw httpError(403, 'Forbidden host');
  if (req.method !== 'GET') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'application/json が必要です');
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== host) throw httpError(403, 'Forbidden origin');
  }
}

/**
 * 画像 API に固有の確認です（checkRequest の後に行います）。
 * 画像は <img> で読み込めるため、GET でも他のサイトのページに埋め込まれるおそれがあります。
 * ブラウザが付ける Sec-Fetch-Site と Origin を見て、ハブの画面（同じオリジン）からの読み込みと、
 * アドレス欄から直接開いた場合（Sec-Fetch-Site: none）だけを受け付けます。
 * これらのヘッダを付けない curl などのクライアントは、checkRequest の Host の確認だけで受け付けます。
 */
export function checkImageRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw httpError(403, 'Forbidden site');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw httpError(403, 'Forbidden origin');
    }
    if (host !== req.headers.host) throw httpError(403, 'Forbidden origin');
  }
}

/**
 * 画像を返します。Content-Type は呼び出し側で中身から判定した形式に固定し、
 * ブラウザが中身から別の形式（HTML など）と推測しないよう nosniff を付けます。
 * 参照は transcript 上の画像を指し、同じ参照の中身は変わらないので、再描画のたびに読み直さないようブラウザに短時間キャッシュさせます。
 */
export function sendImage(res, img) {
  // 対応する形式以外は、呼び出し側の誤りであっても返しません
  if (!IMAGE_TYPES.has(img?.mime) || !Buffer.isBuffer(img.data)) throw httpError(404, '画像が見つかりません');
  res.writeHead(200, {
    'content-type': img.mime,
    'content-length': img.data.length,
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    'cache-control': 'private, max-age=3600',
  });
  res.end(img.data);
}
