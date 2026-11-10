// E2E の作業ディレクトリの用意・整理・ロックを行う処理です。
// Claude Code は起動した作業ディレクトリごとに信頼の記録（~/.claude.json）とトランスクリプトの置き場
// （~/.claude/projects/<変換したパス>/）を作るため、実行のたびに同じパスを使い回して記録が増えないようにします。
// 同じディレクトリの中身を消して使い回すので、利用者のディレクトリを誤って消さないための確認と、
// 同時実行で互いの生成ファイルを消し合わないためのロックをここにまとめています。
// Claude を起動せずに単体テストできるよう、パスや PID は引数で受け取ります。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** e2e 自身が置く目印のファイル名です。これがあるディレクトリだけ中身を消してよいと判断します */
export const MARKER = '.agent-hub-e2e';
const MARKER_TEXT = 'Agent Hub E2E workdir\n\nAgent Hub の E2E シナリオが作業ディレクトリとして使うディレクトリです。\n実行のたびに、このファイルとロックファイル以外の中身を消して作り直します。\n';

/** 実行中の E2E の PID を書くロックファイルの名前です */
export const LOCK = '.agent-hub-e2e.lock';

/** E2E_WORKDIR を指定したときに、その下に作るサブディレクトリの名前です */
export const USER_SUBDIR = 'agent-hub-e2e';

/**
 * 作業ディレクトリのパスを決めます。
 * 既定はリポジトリの外の固定パス（~/.agent-hub-dev/e2e-work）です。worktree ごとに変わらないため、
 * どの worktree から実行しても信頼の記録は 1 件で済みます。
 * E2E_WORKDIR を指定した場合は、指定先の中身を直接消さないよう、その下の固定名のサブディレクトリを使います。
 */
export function resolveWorkdir(env = process.env, home = os.homedir()) {
  if (env.E2E_WORKDIR) return path.join(path.resolve(env.E2E_WORKDIR), USER_SUBDIR);
  return path.join(home, '.agent-hub-dev', 'e2e-work');
}

/**
 * プロセスが生きているかを返します。
 * 別の利用者のプロセスで EPERM になる場合も生きているとみなします（ロックを誤って取り直さないため）。
 * 0 や負の値は process.kill ではプロセスグループを指すため、正の整数以外は死んでいるとみなします。
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 中身を消してよいディレクトリかを判定します。
 * 存在しない・空・目印がある、のいずれかの場合だけ使ってよいとし、それ以外は理由を返します。
 * シンボリックリンクは辿った先が利用者の大事なディレクトリである可能性があるため使いません。
 */
export function inspectWorkdir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, state: 'missing' };
    throw e;
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'シンボリックリンクです' };
  if (!st.isDirectory()) return { ok: false, reason: 'ディレクトリではありません' };
  if (hasMarker(dir)) return { ok: true, state: 'marked' };
  if (fs.readdirSync(dir).length === 0) return { ok: true, state: 'empty' };
  return { ok: false, reason: `E2E の目印（${MARKER}）がなく、空でもありません` };
}

function hasMarker(dir) {
  const p = path.join(dir, MARKER);
  try {
    // 同じ名前のファイルがたまたまあるだけの場合と区別するため、中身の先頭行まで確かめます
    return fs.lstatSync(p).isFile() && fs.readFileSync(p, 'utf8').startsWith(MARKER_TEXT.split('\n')[0]);
  } catch {
    return false;
  }
}

// ---------- ロック ----------

function readLock(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { pid: Number(j.pid), startedAt: j.startedAt };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    // 壊れたロックファイルは持ち主を判別できないため、死んだプロセスのものとして扱います
    return { pid: NaN };
  }
}

/**
 * 死んだプロセスのロックを取り除きます。
 * 先に別のプロセスが取り直していた場合に、その新しいロックを消してしまわないよう、
 * いったん別名に移してから中身を確かめ、生きているプロセスのものだったら元に戻します。
 */
function removeStaleLock(lockPath, pid, isAlive) {
  const grabbed = `${lockPath}.stale-${pid}`;
  try {
    fs.renameSync(lockPath, grabbed);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const holder = readLock(grabbed);
  if (holder && holder.pid !== pid && isAlive(holder.pid)) {
    try {
      fs.linkSync(grabbed, lockPath);
    } catch {
      // 戻す前に別のロックが作られていれば、そちらを優先します
    }
  }
  fs.rmSync(grabbed, { force: true });
}

/**
 * 作業ディレクトリのロックを取ります。生きている別のプロセスが持っている場合は例外を投げます。
 * 中身を書き終えたロックファイルを link で置くことで、書きかけのロックを他のプロセスが読むことを防ぎます
 * （link は置き先が既にあると失敗するため、取得の判定も同時に行えます）。
 */
export function acquireLock(dir, { pid = process.pid, isAlive = isPidAlive } = {}) {
  const lockPath = path.join(dir, LOCK);
  const tmp = `${lockPath}.tmp-${pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, startedAt: new Date().toISOString() }) + '\n');
  try {
    for (let i = 0; i < 5; i++) {
      try {
        fs.linkSync(tmp, lockPath);
        return lockPath;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const holder = readLock(lockPath);
      if (!holder) continue;
      if (holder.pid !== pid && isAlive(holder.pid)) {
        throw new Error(
          `作業ディレクトリ ${dir} は別の E2E（PID ${holder.pid}${holder.startedAt ? `、${holder.startedAt} 開始` : ''}）が使用中です。` +
            '終了を待つか、同時に実行する場合は E2E_WORKDIR で別の場所を指定してください。' +
            `（そのプロセスが E2E でないことが確かな場合は ${lockPath} を削除してください）`,
        );
      }
      // 持ち主が終了している（または自分の古いロックである）ため取り直します
      removeStaleLock(lockPath, pid, isAlive);
    }
    throw new Error(`作業ディレクトリ ${dir} のロックを取得できませんでした`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 自分が持っているロックだけを外します。別のプロセスに取り直されたロックは消しません */
export function releaseLock(dir, pid = process.pid) {
  const lockPath = path.join(dir, LOCK);
  const holder = readLock(lockPath);
  if (holder && holder.pid === pid) fs.rmSync(lockPath, { force: true });
}

// ---------- 整理と用意 ----------

/**
 * 目印とロック以外の中身を消します。前回の生成ファイル（now.txt、plan.md、.mcp.json など）が
 * 次の実行の判定に影響しないようにするためです。目印のないディレクトリでは何も消さずに例外を投げます。
 */
export function clearWorkdir(dir) {
  if (!hasMarker(dir)) throw new Error(`E2E の目印（${MARKER}）がないため、${dir} の中身は消しません`);
  for (const name of fs.readdirSync(dir)) {
    // ロックの一時ファイルは、同時に起動した別の E2E がロックの取得を試みている途中のものなので残します
    if (name === MARKER || name.startsWith(LOCK)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/**
 * シナリオに必要な権限だけを .claude/settings.local.json で許可し、利用者の設定には手を加えません。
 */
function populateWorkdir(dir) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.local.json'),
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
  fs.writeFileSync(path.join(dir, 'README.md'), '# E2E 用の作業ディレクトリ\n\nAgent Hub の E2E シナリオが使うディレクトリです。実行のたびに中身を作り直します。\n');
}

/**
 * 作業ディレクトリを使える状態にします: 安全確認 → 目印の設置 → ロックの取得 → 前回の中身の整理 → 設定の作成。
 * 中身を消すのはロックを取ったあとだけなので、同時に実行された別の E2E の生成ファイルを消すことはありません。
 */
export function prepareWorkdir(dir, opts = {}) {
  const r = inspectWorkdir(dir);
  if (!r.ok) {
    throw new Error(`作業ディレクトリ ${dir} は${r.reason}。利用者のディレクトリの中身を誤って消さないよう中止します。E2E_WORKDIR で別の場所を指定してください。`);
  }
  fs.mkdirSync(dir, { recursive: true });
  if (r.state !== 'marked') fs.writeFileSync(path.join(dir, MARKER), MARKER_TEXT);
  acquireLock(dir, opts);
  try {
    clearWorkdir(dir);
    populateWorkdir(dir);
  } catch (e) {
    releaseLock(dir, opts.pid);
    throw e;
  }
  return dir;
}
