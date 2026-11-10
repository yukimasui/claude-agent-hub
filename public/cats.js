// ドット絵の猫でエージェントの状態を表すにゃ。
// スプライトは文字列で定義して、毛色ごとにオフスクリーン canvas へ焼き込んでから拡大描画するにゃ。
// アニメーションは全体共通の tick から計算するので、DOM を作り直しても動きが途切れないにゃ。
//
// 文字の意味: . 透明 / B 地の色 / S 縞・ポイント / W 白 / K 目 / L 閉じた目などの線 / P 鼻・口 / R 強調(赤) / A アクセント / Z 吹き出し文字

// ---------- 毛色 ----------

export const COATS = {
  orange: { label: '茶トラ', B: '#f0a04b', S: '#c4672a', W: '#fff3e2', K: '#2a1a12', P: '#f78fa7', L: '#5a3215' },
  gray: { label: 'サバトラ', B: '#a9b0bd', S: '#666e7e', W: '#f4f5f7', K: '#16181d', P: '#f2a0b3', L: '#2e323b' },
  cream: { label: 'クリーム', B: '#f1e4c9', S: '#cfae82', W: '#ffffff', K: '#3a2f2a', P: '#f4a0b4', L: '#6e5a44' },
  siamese: { label: 'シャム', B: '#efe2c8', S: '#5e4232', W: '#fbf6ec', K: '#3b82d6', P: '#e58ea2', L: '#3b2a20' },
  black: { label: '黒猫', B: '#4a4f5e', S: '#2f333e', W: '#5d6375', K: '#f2c94c', P: '#d98aa0', L: '#1b1d24' },
  calico: { label: '三毛', B: '#f7f1e6', S: '#e0883a', W: '#ffffff', K: '#2b2420', P: '#f39bb0', L: '#3a2f28' },
};
const COAT_KEYS = Object.keys(COATS);
const FX = { R: '#ff5d6c', A: '#7aa2f7', Z: '#c8d3f5' };

/** id から毛色を決めるにゃ（指定があればそれを使うにゃ） */
export function coatOf(id, preferred) {
  if (preferred && COATS[preferred]) return preferred;
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COAT_KEYS[h % COAT_KEYS.length];
}

// ---------- スプライト ----------

/** 文字列スプライトに差分を当てた新しいスプライトを返すにゃ */
function patch(rows, changes) {
  const g = rows.map((r) => r.split(''));
  for (const [x, y, c] of changes) if (g[y] && x >= 0 && x < g[y].length) g[y][x] = c;
  return g.map((r) => r.join(''));
}

// お座り（正面）14x14
const SIT = [
  '..S.......S...',
  '..BB.....BB...',
  '..BBBSBSBBB...',
  '..BBKBBBKBB...',
  '..BBKBBBKBB...',
  '..BBBWPWBBB...',
  '...BBWWWBB....',
  '...BBWWWBB....',
  '..SBBWWWBBS...',
  '.BSBBWWWBBSB..',
  '.BSBBWWWBBSB..',
  '.BBBBWWWBBBB..',
  '.BBBWWBWWBBB..',
  '..BBWWBWWBB...',
];
// しっぽ（右側で揺れるにゃ）
const TAILS = [
  [[12, 13, 'B'], [13, 12, 'B'], [13, 11, 'B'], [13, 10, 'S'], [12, 9, 'S']],
  [[12, 13, 'B'], [13, 13, 'B'], [13, 12, 'B'], [13, 11, 'S'], [13, 10, 'S']],
  [[12, 13, 'B'], [13, 12, 'B'], [12, 11, 'B'], [12, 10, 'S'], [13, 9, 'S']],
];
const EYES_CLOSED = [[4, 3, 'B'], [8, 3, 'B'], [4, 4, 'L'], [8, 4, 'L']];
// にっこり（目を細めてほっぺがピンク）
const EYES_HAPPY = [...[[4, 3, 'B'], [8, 3, 'B']], [3, 5, 'P'], [9, 5, 'P']];
const MOUTH_OPEN = [[6, 6, 'P'], [6, 7, 'P']];
const PAW_UP = [[7, 12, 'B'], [8, 12, 'B'], [7, 13, 'B'], [8, 13, '.'], [10, 7, 'W'], [11, 7, 'W'], [10, 8, 'W'], [11, 8, 'W'], [11, 6, 'W']];
const PAW_FACE = [[7, 12, 'B'], [8, 12, 'B'], [7, 13, 'B'], [8, 13, '.'], [7, 6, 'W'], [8, 6, 'W'], [7, 7, 'W'], [8, 7, 'W']];

function sit(tail = 0, ...mods) {
  return patch(SIT, [...TAILS[tail], ...mods.flat()]);
}

// 歩き（右向き）20x13。体の上半分は共通で、脚だけ差し替えるにゃ
const WALK_BODY = [
  '............S.....S.',
  '............BB...BB.',
  '............BBSBSBB.',
  '............BKBBBKB.',
  '............BBWPWBB.',
  '.S...........BWWWB..',
  '.B..BBBBBBBBBBBBB...',
  '..BBBSBBSBBSBBBBB...',
  '...BBSBBSBBSBBBBB...',
  '...BBBBBBBBBBBBBB...',
  '....BBBBWWWWWBBB....',
];
const WALK_LEGS = [
  ['...BB..SS..SS..BB...', '..BB....SSSS....BB..'],
  ['....BBSS....SSBB....', '....BBSS....SSBB....'],
  ['...SS..BB..BB..SS...', '..SS....BBBB....SS..'],
  ['....SSBB....BBSS....', '....SSBB....BBSS....'],
];
const WALK = WALK_LEGS.map((legs) => [...WALK_BODY, ...legs]);

// 丸まって寝る 18x9
const SLEEP = [
  '..................',
  '...........S...S..',
  '...........BB.BB..',
  '.....BBSBBSBBBBBB.',
  '...BBBBSBBSBBBBBBB',
  '..BBBBBSBBSBLLBLLB',
  '.BBBBBBBBBBBBBWPWB',
  '.BSSSSSSSSSSSBBBB.',
  '..BBBBBBBBBBBBBB..',
];
const SLEEP_BREATH = patch(SLEEP, [[6, 2, 'B'], [7, 2, 'B'], [8, 2, 'B'], [9, 2, 'B']]);

// 吹き出し・記号
const GLYPHS = {
  bang: ['RR', 'RR', 'RR', 'RR', '..', 'RR'],
  note: ['..AA', '..A.', '..A.', 'AAA.', 'AA..'],
  z: ['ZZZZ', '...Z', '..Z.', '.Z..', 'ZZZZ'],
  zs: ['ZZZ', '..Z', '.Z.', 'Z..', 'ZZZ'],
  dot: ['A'],
};

// ---------- 描画キャッシュ ----------

const cache = new Map();

function bake(rows, coatKey, gray) {
  const key = `${coatKey}|${gray ? 1 : 0}|${rows.join('/')}`;
  let c = cache.get(key);
  if (c) return c;
  const pal = { ...COATS[coatKey], ...FX };
  c = document.createElement('canvas');
  c.width = Math.max(...rows.map((r) => r.length));
  c.height = rows.length;
  const ctx = c.getContext('2d');
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || !pal[ch]) continue;
      ctx.fillStyle = gray && ch !== 'Z' ? toGray(pal[ch]) : pal[ch];
      ctx.fillRect(x, y, 1, 1);
    }
  });
  cache.set(key, c);
  return c;
}

function toGray(hex) {
  const n = parseInt(hex.slice(1), 16);
  const v = Math.round(((n >> 16) & 255) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11);
  const d = Math.round(v * 0.55 + 30);
  return `rgb(${d},${d},${d + 6})`;
}

// ---------- 気分（状態 → アニメーション） ----------

const SLEEPY_AFTER_MS = 5 * 60 * 1000;

export function moodOf({ state, activity, since }) {
  const idleFor = since ? Date.now() - Number(since) : 0;
  switch (state) {
    case 'ended':
      return 'dead-sleep';
    case 'starting':
      return 'yawn';
    case 'waiting':
      return 'alert';
    case 'compacting':
      return 'groom';
    case 'running':
      return String(activity || '').startsWith('思考中') ? 'think' : 'walk';
    case 'done':
      return idleFor > SLEEPY_AFTER_MS ? 'sleep' : idleFor < 60 * 1000 ? 'happy' : 'sit';
    case 'idle':
      return idleFor > SLEEPY_AFTER_MS ? 'sleep' : 'sit';
    default:
      return 'sit';
  }
}

/** 気分と tick から描画命令の列を作るにゃ。座標はスプライト空間（1 = 1 ドット） */
function scene(mood, t, w, h) {
  const ops = [];
  const sitX = 3;
  const sitY = h - 14;
  const blink = t % 28 === 0 || t % 28 === 1;
  const tail = [0, 1, 2, 1][Math.floor(t / 3) % 4];

  switch (mood) {
    case 'walk': {
      const frame = WALK[t % 4];
      const bob = t % 2 ? -1 : 0;
      if (w > 30) {
        // 横長の帯では左右に往復するにゃ
        const span = w - 20;
        const p = t % (span * 2);
        const x = p < span ? p : span * 2 - p;
        ops.push({ rows: frame, x, y: h - 13 + bob, flip: p >= span });
      } else ops.push({ rows: frame, x: Math.floor((w - 20) / 2), y: h - 13 + bob });
      break;
    }
    case 'think': {
      ops.push({ rows: sit(tail, blink ? EYES_CLOSED : []), x: sitX, y: sitY });
      const n = Math.floor(t / 4) % 4; // 0..3 個の点
      for (let i = 0; i < n; i++) ops.push({ rows: GLYPHS.dot, x: sitX + 13 + i * 2, y: sitY + 1 - i });
      break;
    }
    case 'alert': {
      const up = Math.floor(t / 3) % 2 === 0;
      ops.push({ rows: sit(tail, up ? PAW_UP : []), x: sitX, y: sitY });
      if (Math.floor(t / 4) % 2 === 0) ops.push({ rows: GLYPHS.bang, x: sitX + 15, y: Math.max(0, sitY - 1) });
      break;
    }
    case 'happy': {
      ops.push({ rows: sit([0, 1, 2, 1, 0, 2][t % 6], EYES_HAPPY), x: sitX, y: sitY });
      const float = Math.floor(t / 3) % 4;
      ops.push({ rows: GLYPHS.note, x: sitX + 15, y: Math.max(0, sitY + 2 - float) });
      break;
    }
    case 'yawn': {
      const phase = Math.floor(t / 6) % 3;
      ops.push({ rows: sit(1, phase === 1 ? [EYES_CLOSED, MOUTH_OPEN] : blink ? EYES_CLOSED : []), x: sitX, y: sitY });
      break;
    }
    case 'groom': {
      const lick = Math.floor(t / 2) % 2 === 0;
      ops.push({ rows: sit(tail, EYES_CLOSED, lick ? PAW_FACE : []), x: sitX, y: sitY });
      break;
    }
    case 'sleep':
    case 'dead-sleep': {
      const breath = Math.floor(t / 8) % 2 === 0;
      ops.push({ rows: breath ? SLEEP_BREATH : SLEEP, x: Math.floor((Math.min(w, 24) - 18) / 2), y: h - 9, gray: mood === 'dead-sleep' });
      if (mood === 'sleep' || Math.floor(t / 16) % 3 === 0) {
        const k = Math.floor(t / 4) % 6;
        const zx = Math.min(w, 24) - 5;
        if (k < 4) ops.push({ rows: GLYPHS.zs, x: zx - 4, y: Math.max(0, 3 - Math.floor(k / 2)) });
        if (k >= 2) ops.push({ rows: GLYPHS.z, x: zx, y: Math.max(0, 2 - Math.floor((k - 2) / 2)) });
      }
      break;
    }
    default:
      ops.push({ rows: sit(Math.floor(t / 6) % 2, blink ? EYES_CLOSED : []), x: sitX, y: sitY });
  }
  return ops;
}

// ---------- 描画ループ ----------

const live = new Set();
let tick = 0;

// アニメーションのオン / オフは画面の切り替えで決め、ブラウザに保存します。
// OS の「動きを減らす」設定（prefers-reduced-motion）に従うと、状態の変化が分かりにくい静止画になるため、
// 既定では従わずにアニメーションさせます。
const ANIMATION_KEY = 'hub.catAnimation';
let animate = true;
try {
  animate = localStorage.getItem(ANIMATION_KEY) !== 'off';
} catch {
  // ストレージが使えない環境では既定（オン）のままにします
}

export function catAnimationEnabled() {
  return animate;
}

/** アニメーションのオン / オフを切り替えて保存し、表示中の猫をすぐに描き直します */
export function setCatAnimation(on) {
  animate = !!on;
  try {
    localStorage.setItem(ANIMATION_KEY, animate ? 'on' : 'off');
  } catch {
    // 保存できなくても、この画面では切り替えを反映します
  }
  for (const c of live) if (c.isConnected) render(c);
}

function render(canvas) {
  const ctx = canvas.getContext('2d');
  const w = Number(canvas.dataset.w) || 24;
  const h = Number(canvas.dataset.h) || 16;
  const scale = canvas.width / w;
  const mood = moodOf({ state: canvas.dataset.state, activity: canvas.dataset.activity, since: canvas.dataset.since });
  const coat = coatOf(canvas.dataset.seed, canvas.dataset.coat);
  const t = animate ? tick : 0;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  for (const op of scene(mood, t, w, h)) {
    const img = bake(op.rows, coat, op.gray || mood === 'dead-sleep');
    ctx.save();
    if (op.flip) {
      ctx.translate((op.x + img.width) * scale, op.y * scale);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, img.width * scale, img.height * scale);
    } else {
      ctx.drawImage(img, op.x * scale, op.y * scale, img.width * scale, img.height * scale);
    }
    ctx.restore();
  }
  canvas.title = MOOD_LABEL[mood] || '';
}

const MOOD_LABEL = {
  walk: 'お仕事中',
  think: '考え中',
  alert: '呼んでいます',
  happy: 'できました',
  sit: 'おすわり',
  yawn: '起きたところ',
  groom: '毛づくろい中',
  sleep: 'お昼寝中',
  'dead-sleep': 'おやすみ',
};

/** 猫を描く canvas の HTML を返すにゃ */
export function catCanvas({ seed, coat, state, activity, since, w = 24, h = 16, scale = 2, cls = '' }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<canvas class="cat ${cls}" width="${w * scale}" height="${h * scale}" style="width:${w * scale}px;height:${h * scale}px" data-w="${w}" data-h="${h}" data-seed="${esc(seed)}" data-coat="${esc(coat || '')}" data-state="${esc(state)}" data-activity="${esc(activity)}" data-since="${esc(since || '')}"></canvas>`;
}

/** 新しく DOM に入った猫 canvas を登録して即座に描くにゃ */
export function mountCats(root = document) {
  for (const c of root.querySelectorAll('canvas.cat')) {
    if (!live.has(c)) live.add(c);
    render(c);
  }
}

/** 既存の canvas の状態だけ更新するにゃ（DOM を作り直さずに済むにゃ） */
export function updateCat(canvas, { seed, coat, state, activity, since }) {
  Object.assign(canvas.dataset, { seed, coat: coat || '', state, activity: activity || '', since: since || '' });
  live.add(canvas);
  render(canvas);
}

setInterval(() => {
  tick++;
  if (document.hidden) return;
  for (const c of live) {
    if (!c.isConnected) live.delete(c);
    else render(c);
  }
}, 140);
