// エージェントが起動したサブエージェントが一覧に出て、状態が変わり、会話を読めることを確かめます。
// あわせて、hook がサブエージェント内のイベントに agent_id を付けて記録していることを確かめます。
import fs from 'node:fs';
import path from 'node:path';
import { HUB_URL, api, brief, check, createAgent, getAgent, log, sleep, soft } from '../lib.mjs';

export const description = 'サブエージェントの一覧（状態の変化・入れ子）と会話の API、hook の agent_id';

// sleep は作業ディレクトリの設定で許可済みなので、確認なしでサブエージェントの実行中の時間を作れます
export const SUBAGENT_PROMPT = `Agent ツールでサブエージェントを2つ起動してください。
1つ目: run_in_background を true にし、description は「待機の確認」、prompt は「Bash で sleep 8 を実行してください。次に Agent ツールでサブエージェントを1つ起動し（description は「入れ子の確認」、prompt は「『入れ子完了』とだけ答えてください」）、その報告を受け取ったら『待機完了』とだけ報告してください」。
2つ目: フォアグラウンドで、description は「一覧の確認」、prompt は「Bash で sleep 3 を実行してから『確認完了』とだけ報告してください」。
両方の報告を受け取ったら、それぞれの報告を1行ずつ書いてください。ほかのツールは使わないでください。`;

const ACTIVE = new Set(['running', 'waiting']);

export default async function run() {
  const info = await api('GET', '/api/info');
  const a = await createAgent({ name: 'e2e-subagent', prompt: SUBAGENT_PROMPT });

  // 親とサブエージェントがすべて終わるまで状態を記録します（途中の「実行中」も見るため短い間隔で確認します）
  const seen = new Map();
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < 300000) {
    s = await getAgent(a.id);
    for (const sub of s.subagents || []) {
      if (!seen.has(sub.id)) log(`サブエージェントが一覧に出ました: ${sub.id}（${sub.description}・${sub.background ? 'バックグラウンド' : 'フォアグラウンド'}）`);
      seen.set(sub.id, new Set([...(seen.get(sub.id) || []), sub.state]));
    }
    const subs = s.subagents || [];
    if (s.state === 'done' && subs.length >= 2 && !subs.some((x) => ACTIVE.has(x.state))) break;
    await sleep(400);
  }
  log(brief(s));
  const subs = s.subagents || [];
  log(`サブエージェント: ${JSON.stringify(subs.map((x) => [x.id, x.parentId, x.description, x.state]))}`);

  check(subs.length >= 2, 'サブエージェントが親の一覧に出る', subs.length);
  check([...seen.values()].some((st) => st.has('running')), '作業中のサブエージェントが「実行中」になる', [...seen.entries()].map(([k, v]) => [k, [...v]]));
  check(subs.length > 0 && subs.every((x) => x.state === 'done'), '終わったサブエージェントが「完了」になる', subs.map((x) => x.state));
  soft(subs.some((x) => x.background) && subs.some((x) => !x.background), 'バックグラウンドとフォアグラウンドの両方がある', subs.map((x) => x.background));
  soft(subs.some((x) => x.parentId && subs.some((p) => p.id === x.parentId)), '入れ子のサブエージェントが親のサブエージェントに対応付く');
  soft(subs.some((x) => x.description === '待機の確認'), 'Agent ツールに渡した説明が名前になる', subs.map((x) => x.description));

  // 会話の API: 一覧にあるサブエージェントの会話は読め、ほかの ID は読めないこと
  const first = subs[0];
  if (first) {
    const { items } = await api('GET', `/api/agents/${a.id}/subagents/${first.id}/transcript`);
    check(items.length > 0 && items[0].role === 'user', 'サブエージェントの会話が依頼の内容から始まる', items.slice(0, 2));
    soft(items.some((i) => i.role === 'tool' && i.name === 'Bash') || items.some((i) => i.role === 'assistant'), 'サブエージェントの作業が会話に出る');
  }
  for (const bad of ['missing0000000000', '..%2F..%2Fagents', 'agent-x.jsonl']) {
    const r = await fetch(`${HUB_URL}/api/agents/${a.id}/subagents/${bad}/transcript`);
    check(r.status === 404, `記録の無い ID（${bad}）は 404 になる`, r.status);
  }

  // hook の記録: サブエージェントのイベントに agent_id が付き、親の transcript の場所が変わらないこと
  const events = fs
    .readFileSync(path.join(info.hubHome, 'events', `${a.id}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const ids = new Set(subs.map((x) => x.id));
  const starts = events.filter((e) => e.event === 'SubagentStart');
  check(starts.length > 0 && starts.every((e) => ids.has(e.agent_id)), 'SubagentStart に一覧と同じ agent_id が付く', starts.map((e) => e.agent_id));
  check(events.some((e) => e.event === 'PreToolUse' && ids.has(e.agent_id)), 'サブエージェント内のツール呼び出しに agent_id が付く');
  const paths = [...new Set(events.filter((e) => e.agent_id && e.transcript_path).map((e) => e.transcript_path))];
  log(`サブエージェントのイベントの transcript_path: ${JSON.stringify(paths)}`);
  check(s.transcriptPath && !s.transcriptPath.includes('/subagents/'), '親の transcript の場所はサブエージェントのイベントで変わらない', s.transcriptPath);
}
