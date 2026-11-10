// HTTP の要求の確認と、画像・静的ファイルの応答を書き出す処理です。
// server.js から切り出しているのは、HTTP サーバ全体（tmux の操作を含む）を起動せずに単体テストで確かめるためです。
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_TYPES } from './transcript.js';

// 画像 API のパス（/api/agents/<エージェント ID>/images/<参照>）です。
// 参照はツール呼び出し ID などを含むため、ほかの API とは別の形式にしています。
// サーバとテストが同じパターンで判定するよう、ここで 1 か所だけ定義します。
export const IMAGE_PATH_RE = /^\/api\/agents\/([\w-]+)\/images\/([\w.-]{1,200})$/;

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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/**
 * 静的ファイルの ETag を、ファイルのサイズと更新時刻から作ります。
 * 中身のハッシュを使わないのは、同梱の mermaid（約 3.3MB）のような大きなファイルを要求のたびに読まずに済ませるためです。
 * 中身から計算した値ではないので、弱い ETag（W/）にしています。
 * 更新時刻はマイクロ秒まで含め、保存が同じ秒（またはミリ秒）に重なっても変更を見分けられるようにしています。
 */
export function staticEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs * 1000).toString(16)}"`;
}

/**
 * 条件付き要求（If-None-Match）が、手元の ETag と一致するかを判定します。
 * 一致すれば、ブラウザのキャッシュがそのまま使えるので 304 を返せます。
 * If-None-Match の比較は弱い比較（W/ の有無を区別しない）で行い、複数の値の列挙と `*` にも対応します（RFC 9110 の 13.1.2）。
 * If-Modified-Since は見ません。秒単位の比較になり、同じ秒の中の変更を見落とすおそれがあるためです。
 */
export function isNotModified(headers, etag) {
  const inm = headers['if-none-match'];
  if (!inm) return false;
  const opaque = (tag) => tag.trim().replace(/^W\//, '');
  return inm.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === opaque(etag));
}

/**
 * publicDir の下のファイルを返します。publicDir の外を指すパスや、ファイルでないものは 404 にします。
 * cache-control は no-cache（使う前に毎回再検証する）のままにし、public/ を編集したらブラウザの再読み込みですぐ反映されるようにしています。
 * そのうえで ETag を付け、変更のないファイルは 304 で本体を送らずに済ませます。
 */
export function serveStatic(req, res, publicDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDir, rel);
  let stat = null;
  if (file.startsWith(publicDir + path.sep)) {
    try {
      stat = fs.statSync(file);
    } catch {
      // 存在しないファイルは、下で 404 にします
    }
  }
  if (!stat?.isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  const etag = staticEtag(stat);
  if (isNotModified(req.headers, etag)) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' }).end();
    return;
  }
  res.writeHead(200, {
    'content-type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`,
    'cache-control': 'no-cache',
    etag,
  });
  fs.createReadStream(file).pipe(res);
}
