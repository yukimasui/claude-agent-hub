// E2E シナリオと画面確認スクリプトで共有する処理です。
// 稼働中のハブ（既定は開発用ハブ）の HTTP API を叩いて、実際の Claude Code を操作します。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB_URL = (process.env.HUB_URL || 'http://localhost:4400').replace(/\/+$/, '');
export const KEEP = process.env.E2E_KEEP === '1';
export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(method, p, body) {
  const r = await fetch(HUB_URL + p, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${method} ${p}: ${r.status} ${j.error || r.statusText}`), { status: r.status, code: j.code });
  return j;
}

export const getAgent = (id) => api('GET', `/api/agents/${id}`);
export const pendingOf = async (id) => (await api('GET', `/api/agents/${id}/pending`)).items;
export const transcriptOf = async (id) => (await api('GET', `/api/agents/${id}/transcript`)).items;
export const respond = (id, body) => api('POST', `/api/agents/${id}/respond`, body);
export const send = (id, text) => api('POST', `/api/agents/${id}/send`, { text });
export const queue = (id, body) => api('POST', `/api/agents/${id}/queue`, body);

/** 状態の要約を 1 行で返します（ログ用） */
export const brief = (a) =>
  `state=${a.state} mode=${a.currentMode} activity=${a.activity} queue=${a.queue.length}${a.queuePaused ? `(一時停止: ${a.queueNote})` : ''} pending=${JSON.stringify(a.pending.map((p) => [p.kind, p.label]))}`;

export async function waitFor(id, pred, label, timeout = 120000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await getAgent(id);
    if (pred(last)) return last;
    await sleep(400);
  }
  throw new Error(`待機がタイムアウトしました: ${label}（${last ? brief(last) : '状態不明'}）`);
}

// ---------- 接続先の確認 ----------

const PROD_HOME = path.join(os.homedir(), '.agent-hub');

/** 接続先が本番のハブでないことを確かめます。E2E はエージェントの作成・削除を伴うためです */
export async function preflight() {
  let info;
  try {
    info = await api('GET', '/api/info');
  } catch (e) {
    throw new Error(`ハブ（${HUB_URL}）に接続できません: ${e.cause?.code || e.message}\n開発用ハブを \`npm run dev\` で起動するか、HUB_URL で接続先を指定してください。`);
  }
  if (path.resolve(info.hubHome) === PROD_HOME || info.tmuxSession === 'agent-hub') {
    throw new Error(`接続先（${HUB_URL}）は本番のハブ（データ置き場 ${info.hubHome}、tmux セッション ${info.tmuxSession}）のため実行しません。開発用ハブを使ってください。`);
  }
  return info;
}

// ---------- 作業ディレクトリ ----------

let workdir = null;
let ownsWorkdir = false;

/**
 * 実行ごとの作業ディレクトリを作ります。
 * E2E_WORKDIR を指定すると、その下に作ります（信頼済みのディレクトリを指定すれば信頼確認を省けます）。
 * シナリオに必要な権限だけを .claude/settings.local.json で許可し、利用者の設定には手を加えません。
 */
export function getWorkdir() {
  if (workdir) return workdir;
  const base = process.env.E2E_WORKDIR ? path.resolve(process.env.E2E_WORKDIR) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  workdir = fs.mkdtempSync(path.join(base, 'agent-hub-e2e-'));
  ownsWorkdir = true;
  fs.mkdirSync(path.join(workdir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(workdir, '.claude', 'settings.local.json'),
    JSON.stringify(
      {
        // queue シナリオの待ち時間用の sleep と、elicitation シナリオの MCP ツールだけを確認なしで許可します
        permissions: { allow: ['Bash(sleep:*)', 'mcp__elicit__ask_profile'] },
        // elicitation シナリオで置く .mcp.json を、承認ダイアログなしで読み込ませます
        enableAllProjectMcpServers: true,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(workdir, 'README.md'), '# E2E 用の作業ディレクトリ\n\nAgent Hub の E2E シナリオが一時的に使うディレクトリです。\n');
  return workdir;
}

// ---------- エージェントの作成と後片付け ----------

const created = [];

/**
 * エージェントを作成し、起動直後の信頼確認ダイアログに応答します。
 * 新しいディレクトリでは Claude Code が「このフォルダを信頼するか」を確認し、その間は hook が届かず
 * 状態が「起動中」のままになるため、画面を見て「信頼する」を選びます。
 */
export async function createAgent(body) {
  const a = await api('POST', '/api/agents', { model: process.env.E2E_MODEL || 'haiku', cwd: getWorkdir(), ...body });
  created.push(a.id);
  log(`エージェントを作成しました: ${a.id} (${a.name})`);
  await acceptTrustDialog(a.id);
  return a;
}

async function acceptTrustDialog(id, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const a = await getAgent(id);
    if (a.state !== 'starting') return;
    if (!a.alive) throw new Error(`エージェントが起動直後に終了しました: ${a.activity}`);
    const { text } = await api('GET', `/api/agents/${id}/screen`);
    if (/trust/i.test(text)) {
      // 作業ディレクトリの設定で権限を事前に許可していると、既定の選択肢が「No, exit」になるため、
      // カーソル（❯）が「Yes」の行に来るまで移動してから確定します
      const cursor = text.split('\n').find((l) => l.includes('❯')) || '';
      if (/\byes\b/i.test(cursor)) {
        log('信頼確認ダイアログで「信頼する」を選びます');
        await api('POST', `/api/agents/${id}/keys`, { key: 'Enter' });
        await sleep(2000);
      } else {
        await api('POST', `/api/agents/${id}/keys`, { key: 'Down' });
        await sleep(500);
      }
      continue;
    }
    await sleep(500);
  }
  throw new Error('エージェントが起動中のまま進みません（ターミナルタブで画面を確認してください）');
}

/** 作成したエージェントと作業ディレクトリを片付けます。E2E_KEEP=1 なら残して場所を表示します */
export async function cleanup() {
  if (KEEP) {
    if (created.length) log(`E2E_KEEP=1 のためエージェントを残します: ${created.join(', ')}`);
    if (workdir) log(`作業ディレクトリ: ${workdir}`);
    return;
  }
  for (const id of created.splice(0)) {
    await api('DELETE', `/api/agents/${id}`).catch((e) => log(`削除に失敗しました: ${id}: ${e.message}`));
  }
  if (workdir && ownsWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
}

// ---------- 判定 ----------

const failures = [];

export function log(msg) {
  console.log(`  ${msg}`);
}

/** 条件を確かめて結果を表示します。失敗しても続行し、最後にまとめて終了コードに反映します */
export function check(ok, msg, detail) {
  console.log(`  ${ok ? '✔' : '✖'} ${msg}${!ok && detail !== undefined ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(msg);
  return ok;
}

/** Claude の応答に左右され、ハブの不具合とは言い切れない確認です。失敗しても終了コードには反映しません */
export function soft(ok, msg, detail) {
  console.log(`  ${ok ? '✔' : '△'} ${msg}${!ok ? '（Claude の応答次第のため参考扱い）' : ''}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`);
  return ok;
}

export const failed = () => failures.length;

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
