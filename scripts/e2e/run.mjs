#!/usr/bin/env node
// E2E シナリオの実行スクリプトです: npm run e2e -- <シナリオ名>
// 実際の Claude Code（既定は haiku）を起動してトークンを消費するため、npm test には含めず、明示的に実行したときだけ動きます。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E_DIR, HUB_URL, cleanup, failed, preflight } from './lib.mjs';

const SCENARIO_DIR = path.join(E2E_DIR, 'scenarios');
const scenarioUrl = (n) => pathToFileURL(path.join(SCENARIO_DIR, `${n}.mjs`)).href;
const names = fs
  .readdirSync(SCENARIO_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => f.slice(0, -4))
  .sort();

const name = process.argv[2];

if (!name || name === '--help' || name === '-h' || !names.includes(name)) {
  if (name && !['--help', '-h'].includes(name)) console.error(`不明なシナリオです: ${name}\n`);
  console.log('使い方: npm run e2e -- <シナリオ名>\n\nシナリオ:');
  for (const n of names) {
    const { description } = await import(scenarioUrl(n));
    console.log(`  ${n.padEnd(12)} ${description}`);
  }
  console.log(`
環境変数:
  HUB_URL       接続先のハブ（既定: http://localhost:4400 = npm run dev の開発用ハブ）
  E2E_MODEL     エージェントのモデル（既定: haiku）
  E2E_WORKDIR   作業ディレクトリを置く場所。指定先の下の agent-hub-e2e を使う
                （既定: ~/.agent-hub-dev/e2e-work。毎回同じパスを使い、実行の開始時に前回の中身を消す）
  E2E_KEEP=1    終了後もエージェントと作業ディレクトリの中身を残す（画面確認用）`);
  process.exit(name && !['--help', '-h'].includes(name) ? 1 : 0);
}

const info = await preflight().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
console.log(`▶ ${name}（ハブ: ${HUB_URL} / データ置き場: ${info.hubHome} / tmux: ${info.tmuxSession}）`);

const { default: run } = await import(scenarioUrl(name));
let error = null;
const t0 = Date.now();
try {
  await run();
} catch (e) {
  error = e;
  console.error(`  ✖ 中断しました: ${e.message}`);
} finally {
  await cleanup();
}
const sec = Math.round((Date.now() - t0) / 1000);
if (error || failed()) {
  console.log(`✖ ${name}: 失敗（${error ? '中断' : `${failed()} 件の確認に失敗`}、${sec} 秒）`);
  process.exit(1);
}
console.log(`✔ ${name}: 成功（${sec} 秒）`);
