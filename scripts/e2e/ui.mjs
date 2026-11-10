#!/usr/bin/env node
// ブラウザでの画面確認スクリプトです: npm run e2e:ui -- <モード> [エージェントID]
// playwright-core でハブの画面を操作し、スクリーンショットを保存します。
// playwright-core はリポジトリの依存に含めていないため、利用者の環境にあるものを動的に読み込みます。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HUB_URL, api, brief, check, cleanup, createAgent, failed, log, preflight, sleep, waitFor } from './lib.mjs';

const MODES = {
  shot: '既存のエージェントの画面を撮影します（Claude は起動しません。ID 省略時は最後に作成したエージェント）',
  question: '質問するエージェントを作り、回答待ちパネルを撮影してから画面のクリック操作で回答します',
  triage: '提案を出すエージェントを作り、仕分けボードをドラッグ＆ドロップ・キー操作・拡大表示で仕分けて送信します',
};

const [mode, agentArg] = process.argv.slice(2);
if (!MODES[mode]) {
  console.log('使い方: npm run e2e:ui -- <モード> [エージェントID]\n\nモード:');
  for (const [k, v] of Object.entries(MODES)) console.log(`  ${k.padEnd(9)} ${v}`);
  console.log(`
環境変数:
  HUB_URL                         接続先のハブ（既定: http://localhost:4400）
  PLAYWRIGHT_CORE_PATH            playwright-core のディレクトリ（未指定なら通常のモジュール解決で探します）
  PLAYWRIGHT_CHROMIUM_EXECUTABLE  使用する Chromium の実行ファイル（未指定なら playwright の既定）
  E2E_SHOTS_DIR                   スクリーンショットの保存先（既定: OS の一時ディレクトリに作成）
  E2E_KEEP=1                      作成したエージェントを残す（question / triage）`);
  process.exit(mode ? 1 : 0);
}

async function loadChromium() {
  const p = process.env.PLAYWRIGHT_CORE_PATH;
  try {
    const mod = p ? createRequire(import.meta.url)(path.resolve(p)) : await import('playwright-core');
    return mod.chromium ?? mod.default?.chromium;
  } catch {
    console.error(`playwright-core が見つかりません${p ? `（PLAYWRIGHT_CORE_PATH=${p}）` : ''}。
画面確認には playwright-core とブラウザが必要です（リポジトリの依存には含めていません）。次のいずれかで用意してください:
  - リポジトリ外に導入する:   npm install --prefix ~/.cache/agent-hub-pw playwright-core
                              PLAYWRIGHT_CORE_PATH=~/.cache/agent-hub-pw/node_modules/playwright-core npm run e2e:ui -- ${mode}
  - ブラウザを導入する:       npx playwright install chromium-headless-shell
  - 既存の Chromium を使う:   PLAYWRIGHT_CHROMIUM_EXECUTABLE=<実行ファイルのパス> を指定`);
    process.exit(2);
  }
}

const chromium = await loadChromium();
await preflight().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

const outDir = process.env.E2E_SHOTS_DIR ? path.resolve(process.env.E2E_SHOTS_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-shots-'));
fs.mkdirSync(outDir, { recursive: true });
const shot = (name) => path.join(outDir, `${mode}-${name}.png`);

let browser;
try {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
} catch (e) {
  console.error(`ブラウザを起動できません: ${e.message.split('\n')[0]}
\`npx playwright install chromium-headless-shell\` で導入するか、PLAYWRIGHT_CHROMIUM_EXECUTABLE で実行ファイルを指定してください。`);
  process.exit(2);
}

const errors = [];

/** 指定したエージェントを選択した状態で会話タブを開きます */
async function openPage(id) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  // 画面は選択中のエージェントとタブを localStorage（hub.*）から復元します
  await page.addInitScript((id) => {
    localStorage.setItem('hub.selectedId', id);
    localStorage.setItem('hub.tab', 'chat');
  }, id);
  await page.goto(HUB_URL + '/');
  await page.waitForTimeout(2500);
  return page;
}

async function captureAgent(page, prefix) {
  await page.screenshot({ path: shot(`${prefix}-full`) });
  const pending = page.locator('#pending');
  if (await pending.isVisible()) {
    await pending.evaluate((el) => (el.style.maxHeight = 'none'));
    await pending.screenshot({ path: shot(`${prefix}-pending`) });
  }
  await page.locator('#chat').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(300);
  await page.locator('#chat').screenshot({ path: shot(`${prefix}-chat`) });
}

async function runShot() {
  let id = agentArg;
  if (!id) {
    const list = await api('GET', '/api/agents');
    if (!list.length) throw new Error('エージェントがありません。ID を指定するか、先に E2E_KEEP=1 でシナリオを実行してください。');
    id = list.at(-1).id;
  }
  log(`対象: ${id}`);
  const page = await openPage(id);
  await captureAgent(page, id);
}

async function runQuestion() {
  const a = await createAgent({
    name: 'e2e-ui-question',
    prompt:
      'AskUserQuestion ツールを1回だけ使って2つ同時に質問してください。質問1: 好きな言語（単一選択。TypeScript/Python、各選択肢に description と短い ASCII 図の preview）。質問2: 使うツール（multiSelect。git/tmux/docker）。回答を受け取ったら、受け取った回答とメモをそのまま箇条書きで報告してください。',
  });
  await waitFor(a.id, (x) => x.pending.some((p) => p.kind === 'question'), '質問の表示');
  const page = await openPage(a.id);
  await captureAgent(page, 'before');

  const card = page.locator('.icard-question');
  check(await card.isVisible(), '回答待ちパネルに質問カードが表示される');
  const qs = card.locator('.q');
  await qs.nth(0).locator('.opt').nth(1).hover();
  await page.waitForTimeout(200);
  await qs.nth(0).screenshot({ path: shot('hover') });
  await qs.nth(0).locator('.opt').nth(1).click();
  await qs.nth(1).locator('.opt').nth(0).click();
  await qs.nth(1).locator('.other-text').fill('画面からの自由記述');
  await qs.nth(0).locator('.q-notes').fill('画面からのメモです');
  await card.screenshot({ path: shot('filled') });
  await card.locator('button[data-action=answer]').click();

  const s = await waitFor(a.id, (x) => x.state === 'done' && !x.pending.length, '回答後の応答完了');
  log(brief(s));
  await page.waitForTimeout(1500);
  check(!(await page.locator('.icard-question').count()), '回答後に質問カードが消える');
  await captureAgent(page, 'after');
}

/** 要素が非表示になるまで待ちます（ダイアログの close は遅れて反映されることがあるため）。期限内に消えなければ false */
function waitHidden(locator, timeout = 5000) {
  return locator.waitFor({ state: 'hidden', timeout }).then(
    () => true,
    () => false,
  );
}

async function runTriage() {
  const a = await createAgent({
    name: 'e2e-ui-triage',
    coat: 'calico',
    // 拡大表示で Markdown の補足を確かめるため、補足を箇条書きで書くよう頼みます
    prompt:
      'このディレクトリの README.md に載せる内容の改善案を5つ考えて、どれを採用するか私に個別に判断させてください。各提案の detail には、理由と具体的な変更内容を Markdown の箇条書きで3〜4行書いてください。ファイルはまだ変更しないでください。',
  });
  await waitFor(a.id, (x) => x.state === 'done', '応答完了', 180000);
  const page = await openPage(a.id);
  const board = page.locator('#triage .triage');
  if (!(await board.isVisible())) {
    await captureAgent(page, 'no-board');
    log('仕分けボードが開きませんでした（Claude が提案ブロックを出さなかった可能性があります）');
    check(false, '最後の応答に提案があると仕分けボードが自動で開く');
    return;
  }
  const count = await page.locator('.tri-card').count();
  log(`提案カード: ${count} 件`);
  await page.locator('#triage').screenshot({ path: shot('board-0') });

  const ids = await page.locator('.tri-card').evaluateAll((els) => els.map((e) => e.dataset.id));
  const card = (id) => page.locator(`.tri-card[data-id="${id}"]`);
  // 実際のドラッグ＆ドロップで仕分けます
  if (ids[0]) await card(ids[0]).dragTo(page.locator('.tri-col[data-decision="ok"]'));
  if (ids[1]) await card(ids[1]).dragTo(page.locator('.tri-col[data-decision="ng"]'));
  if (ids[2]) {
    await card(ids[2]).dragTo(page.locator('.tri-col[data-decision="change"]'));
    await card(ids[2]).locator('.tri-note').fill('手順はコマンド例を1つだけにしてください');
  }
  // 残りはキーボード操作（A キー）で採用します
  if (ids[3]) {
    await card(ids[3]).focus();
    await page.keyboard.press('a');
  }
  await page.locator('.tri-comment').fill('全体的に短めでお願いします');
  await page.waitForTimeout(300);
  await page.locator('#triage').screenshot({ path: shot('board-1') });
  check((await page.locator('.tri-col[data-decision="none"] .tri-card').count()) === Math.max(0, count - 4), '仕分けた提案が各列に移動する');
  const viewer = page.locator('#triage .tri-viewer');
  check(!(await viewer.isVisible()), 'ドラッグ＆ドロップでは拡大表示が開かない');

  // 拡大表示: カードのクリックで開き、前後の移動と判断・修正内容の入力を拡大表示の中で行います
  const last = ids.at(-1);
  if (count >= 5) {
    await card(last).locator('.tri-text').click();
    check(await viewer.isVisible(), 'カードのクリックで拡大表示が開く');
    check((await viewer.locator('.tv').getAttribute('data-id')) === last, '拡大表示にクリックしたカードの提案が表示される');
    await page.waitForTimeout(300);
    await viewer.screenshot({ path: shot('viewer-0') });
    await page.keyboard.press('ArrowLeft');
    check((await viewer.locator('.tv').getAttribute('data-id')) === ids.at(-2), '← キーで前の提案に移動する');
    await viewer.locator('button[data-nav="1"]').click();
    check((await viewer.locator('.tv').getAttribute('data-id')) === last, '「次へ」で次の提案に移動する');
    await viewer.locator('button[data-to="change"]').click();
    await viewer.locator('.tri-note').fill('拡大表示から入力した修正内容です');
    check((await viewer.locator('.tv').getAttribute('data-decision')) === 'change', '拡大表示から判断を変更できる');
    await page.waitForTimeout(200);
    await viewer.screenshot({ path: shot('viewer-1') });
    // 文字を選択しながら背景で離しても閉じないことを確かめます
    const box = await viewer.locator('.tv-detail').boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(5, 5, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    check(await viewer.isVisible(), '本文の文字を選択しながら背景で離しても拡大表示は閉じない');
    // 入力欄の外にフォーカスを移してから Esc で閉じます
    await viewer.locator('.tv-scroll').focus();
    await page.keyboard.press('Escape');
    check(await waitHidden(viewer), 'Esc で拡大表示が閉じる');
    // 拡大表示で入力した修正内容がボードの DOM に入るのは、close イベントで描き直したときです。
    // close イベントは Esc の後に遅れて発火するため、描き直しが終わるのを待ってから値を確かめます
    const noteOnBoard = await page
      .waitForFunction(
        ([id, value]) => document.querySelector(`.tri-col[data-decision="change"] .tri-card[data-id="${CSS.escape(id)}"] .tri-note`)?.value === value,
        [last, '拡大表示から入力した修正内容です'],
        { timeout: 5000 },
      )
      .then(
        () => true,
        () => false,
      );
    check(noteOnBoard, '拡大表示での判断と修正内容がボードに反映される');
    // Enter キーでも開け、背景のクリックで閉じられます
    await card(ids[0]).focus();
    await page.keyboard.press('Enter');
    check(await viewer.isVisible(), 'カードにフォーカスして Enter で拡大表示が開く');
    await page.mouse.click(5, 5);
    check(await waitHidden(viewer), '背景のクリックで拡大表示が閉じる');
    // ドラッグの後でも、キーボードで拡大ボタンを押せば開きます（同じ列へのドロップで、判断を変えずにドラッグだけを行います）
    await card(ids[0]).dragTo(page.locator(`.tri-col[data-decision="${await card(ids[0]).evaluate((el) => el.closest('.tri-col').dataset.decision)}"]`));
    await card(ids[0]).locator('.tri-expand').focus();
    await page.keyboard.press('Enter');
    check(await viewer.isVisible(), 'ドラッグの後でも、キーボードで拡大ボタンを押すと拡大表示が開く');
    await page.keyboard.press('Escape');
    check(await waitHidden(viewer), 'Esc で拡大表示が閉じる（拡大ボタンから開いた場合）');
  } else {
    log('提案が 5 件未満のため、拡大表示の確認を省略します');
    check(false, '拡大表示の確認に必要な 5 件以上の提案がある');
  }
  await page.locator('#triage').screenshot({ path: shot('board-2') });

  await page.locator('.tri-foot button[data-act="send"]').click();
  await page.waitForTimeout(1500);
  check(await page.locator('#triage').isHidden(), '送信後に仕分けボードが閉じる');
  await waitFor(a.id, (x) => x.state === 'running' || x.state === 'done', '判断の送信', 30000);
  await sleep(500);
  await captureAgent(page, 'after');
}

let error = null;
try {
  await { shot: runShot, question: runQuestion, triage: runTriage }[mode]();
} catch (e) {
  error = e;
  console.error(`  ✖ 中断しました: ${e.message}`);
} finally {
  await browser.close();
  await cleanup();
}

check(!errors.length, 'ページでエラーが発生していない', errors.join('\n      '));
console.log(`スクリーンショット: ${outDir}`);
process.exit(error || failed() ? 1 : 0);
