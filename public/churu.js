// ちゅーるモードです。サイドバーの下の隅に隠したちゅーるを一覧の猫までドラッグすると、猫がなめ、離すと喜びます。
// しぐさ（気分の上書き）はエージェント ID ごとにこのモジュールの Map に持ちます。
// 一覧は状態が変わるたびに innerHTML から描き直されるため、canvas の dataset に持たせると描き直しのたびに消えてしまうためです。
// cats.js は描画のたびに gestureOf() でしぐさを問い合わせます。このモジュールから cats.js は読み込みません（循環を避けるため）。
// 単体テストで確かめられるよう、読み込んだだけでは DOM に触れません（DOM を扱うのは drawChuru と mountChuru だけです）。

// ちゅーるの先端がこの距離（px）以内に入った猫だけがなめます
export const NEAR_PX = 24;
// 食べた後に喜んでいる時間です
export const DELIGHT_MS = 3500;
// 食べられたちゅーるが隠し場所に戻るまでの時間です
export const RESPAWN_MS = 4000;
// 猫から離れた場所で離したときに、元の場所へ戻る動きの時間です（style.css の .churu.returning とそろえます）
const RETURN_MS = 250;

// ---------- しぐさ ----------

const gestures = new Map();

/** 点から矩形までの距離です（矩形の中なら 0） */
export function distanceToRect(point, rect) {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

/** cats（{ id, rect } の列）のうち、point からしきい値以内でいちばん近い猫の id を返します。なければ null です */
export function nearestCat(point, cats, threshold = NEAR_PX) {
  let best = null;
  let bestDist = Infinity;
  for (const { id, rect } of cats) {
    const d = distanceToRect(point, rect);
    if (d <= threshold && d < bestDist) {
      best = id;
      bestDist = d;
    }
  }
  return best;
}

/** しぐさが now の時点でまだ続いていればその気分を、時間切れかしぐさがなければ null を返します */
export function activeGesture(entry, now) {
  return entry && now < entry.until ? entry.mood : null;
}

/** エージェントの猫に、until（ミリ秒の時刻）までのしぐさを設定します。ドラッグ中のように終わりが決まらないときは Infinity を渡します */
export function setGesture(id, mood, until) {
  gestures.set(String(id), { mood, until });
}

/** しぐさを取り消します。mood を渡したときは、そのしぐさのときだけ取り消します（後から設定した別のしぐさを消さないため） */
export function clearGesture(id, mood) {
  const key = String(id);
  if (!mood || gestures.get(key)?.mood === mood) gestures.delete(key);
}

/** 今のしぐさの気分を返します。時間切れのしぐさは消して null を返し、元の状態の表示に戻します */
export function gestureOf(id, now = Date.now()) {
  const key = String(id);
  const entry = gestures.get(key);
  const mood = activeGesture(entry, now);
  if (entry && !mood) gestures.delete(key);
  return mood;
}

// ---------- ちゅーるの絵 ----------

// 文字の意味: . 透明 / O 縁取り / W 袋の地 / R 帯 / Y ラベル / P 中身（先端からのぞくペースト）
// 縁取りを濃い茶色、地を明るいクリーム色にして、暗い背景でも明るい背景でも形が分かるようにしています
const CHURU = [
  '..PP..',
  '..OO..',
  '.OWWO.',
  '.OWWO.',
  'OWWWWO',
  'ORRRRO',
  'ORWWRO',
  'ORRRRO',
  'OWWWWO',
  'OYYYYO',
  'OYWWYO',
  'OYYYYO',
  'OWWWWO',
  'OWWWWO',
  'OOOOOO',
  'O.OO.O',
];
const CHURU_PAL = { O: '#6b4a32', W: '#fbf4e4', R: '#ff5d6c', Y: '#e0af68', P: '#d98a4e' };

/** canvas にちゅーるのドット絵を描きます（1 ドット = canvas の 1 画素。拡大は CSS で行います） */
export function drawChuru(canvas) {
  canvas.width = CHURU[0].length;
  canvas.height = CHURU.length;
  const ctx = canvas.getContext('2d');
  CHURU.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = CHURU_PAL[row[x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

// ---------- ドラッグ ----------

/**
 * ちゅーるの要素（canvas）をドラッグできるようにします。
 * listRoot の中の data-treats を持つ猫 canvas（一覧の猫）だけを相手にします。
 * pointer イベントを使うのは、マウスとタッチを同じ処理で扱えるようにするためです。
 */
export function mountChuru(el, listRoot) {
  drawChuru(el);
  let drag = null;
  let suppressClickUntil = 0;

  const tip = () => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top };
  };
  const cats = () =>
    [...listRoot.querySelectorAll('canvas.cat[data-treats]')].map((c) => ({ id: c.dataset.seed, rect: c.getBoundingClientRect() }));
  const place = (e) => {
    el.style.left = `${e.clientX - drag.dx}px`;
    el.style.top = `${e.clientY - drag.dy}px`;
  };
  // なめる猫を切り替えます。前の猫のなめるしぐさは取り消し、離れたらやめるようにします
  const lickTarget = (id) => {
    if (drag.target === id) return;
    if (drag.target) clearGesture(drag.target, 'lick');
    drag.target = id;
    if (id) setGesture(id, 'lick', Infinity);
  };
  const reset = () => {
    el.classList.remove('dragging', 'returning');
    el.style.left = '';
    el.style.top = '';
  };
  const finish = (fedId) => {
    const { home } = drag;
    lickTarget(null);
    drag = null;
    // ドラッグの終わりに続くクリックが一覧の項目に届き、エージェントの選択が変わらないようにします。
    // ポインタを捕捉していれば通常はちゅーる自身に届きますが、ブラウザによる違いに備えて少しの間だけ止めます
    suppressClickUntil = performance.now() + 400;
    if (fedId) {
      setGesture(fedId, 'delight', Date.now() + DELIGHT_MS);
      reset();
      el.classList.add('eaten');
      setTimeout(() => el.classList.remove('eaten'), RESPAWN_MS);
      return;
    }
    el.classList.add('returning');
    el.style.left = `${home.left}px`;
    el.style.top = `${home.top}px`;
    setTimeout(reset, RETURN_MS);
  };

  el.addEventListener('pointerdown', (e) => {
    if (drag || e.button !== 0 || el.classList.contains('eaten') || el.classList.contains('returning')) return;
    // 既定の動作（テキストの選択や画像のドラッグ）を止めます
    e.preventDefault();
    const home = el.getBoundingClientRect();
    drag = { pointerId: e.pointerId, dx: e.clientX - home.left, dy: e.clientY - home.top, home, target: null };
    // ポインタを捕捉して、ちゅーるの外へ速く動かしても move / up を受け取れるようにします
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    place(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    place(e);
    lickTarget(nearestCat(tip(), cats()));
  });
  el.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    place(e);
    finish(nearestCat(tip(), cats()));
  });
  // 中断されたとき（タッチがスクロールに変わった、ウィンドウが切り替わったなど）は、食べずに元の場所へ戻します
  const cancel = (e) => {
    if (drag && e.pointerId === drag.pointerId) finish(null);
  };
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('lostpointercapture', cancel);
  window.addEventListener(
    'click',
    (e) => {
      if (performance.now() >= suppressClickUntil) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}
