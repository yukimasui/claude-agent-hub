// フォルダの監視（fs.watch）を、止まっても張り直しながら続ける処理です。
// server.js から切り出しているのは、サーバ全体（tmux の操作を含む）を起動せずに単体テストで確かめるためです。
import fs from 'node:fs';

// 監視を始めたときのフォルダと同じものかを見分けるための値です（消して作り直された場合は別のものになります）
function dirId(dir) {
  const st = fs.statSync(dir);
  return `${st.dev}:${st.ino}`;
}

/**
 * dir を fs.watch で監視し、変更の通知（種類とファイル名）を onChange に渡します。
 *
 * 監視は、フォルダが消された、監視の上限に達したなどの理由で止まることがあります。
 * - 監視中の error を受けないと、処理されない error としてサーバ全体が落ちます（すべてのエージェントの監視が止まります）。
 *   そこで error を受けて記録し、retryMs 後に張り直します
 * - Linux ではフォルダを消しても error にならず、監視が黙って止まります。
 *   そこで rename の通知のたびに、フォルダが監視を始めたときと同じものかを確かめ、違えば張り直します
 * - 張り直せない間（フォルダがまだない、上限に達したままなど）は、同じ間隔で試し続けます。
 *   同じ記録が繰り返し出ないよう、記録は止まったときと再開したときだけにします
 *
 * 監視が止まっている間の変更は通知されないため、呼び出し側は定期的な読み直しと組み合わせて使います。
 * watch はテストで差し替えるための引数です。
 */
export function watchDir(dir, onChange, { retryMs = 2000, log = console.error, watch = fs.watch } = {}) {
  let watcher = null;
  let id = null;
  let timer = null;
  let closed = false;
  // 止まっている間は true にし、張り直しの失敗を毎回記録しないようにします
  let stopped = false;

  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(start, retryMs);
    // 張り直しの待ち時間だけでプロセスが終了できなくならないようにします
    timer.unref?.();
  };

  const stop = (w, reason) => {
    if (watcher !== w) return;
    watcher = null;
    try {
      w.close();
    } catch {
      // すでに閉じている場合などは、そのまま張り直します
    }
    if (!stopped) log(`フォルダの監視が止まりました（${reason}）。${retryMs} ミリ秒ごとに張り直しを試みます: ${dir}`);
    stopped = true;
    schedule();
  };

  const sameDir = () => {
    try {
      return dirId(dir) === id;
    } catch {
      return false;
    }
  };

  function start() {
    timer = null;
    if (closed) return;
    let w;
    try {
      id = dirId(dir);
      w = watch(dir, (type, fname) => {
        if (watcher !== w) return;
        onChange(type, fname);
        if (type === 'rename' && !sameDir()) stop(w, 'フォルダが削除または移動されました');
      });
    } catch (e) {
      // 監視を始められない場合（フォルダがない、監視の上限に達したなど）も、落ちずに後で試し直します
      if (!stopped) log(`フォルダの監視を開始できませんでした（${e.code || e.message}）。${retryMs} ミリ秒ごとに試み直します: ${dir}`);
      stopped = true;
      schedule();
      return;
    }
    watcher = w;
    w.on('error', (e) => stop(w, e.code || e.message));
    if (stopped) log(`フォルダの監視を再開しました: ${dir}`);
    stopped = false;
  }

  start();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      const w = watcher;
      watcher = null;
      w?.close();
    },
  };
}
