// 対話要求（質問・計画承認・権限確認・MCP 入力要求）の分類と、
// ブラウザからの回答を hook の出力 JSON に変換する処理にゃ

export function kindOf(req) {
  if (req.event === 'Elicitation') return 'elicitation';
  if (req.tool_name === 'AskUserQuestion') return 'question';
  if (req.tool_name === 'ExitPlanMode') return 'plan';
  return 'permission';
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const permissionOutput = (decision) => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
});

/** 回答 body から hook 出力を作るにゃ。null は「何も返さず TUI に任せる」にゃ */
export function buildOutput(req, body) {
  const kind = kindOf(req);
  const action = String(body.action || '');
  if (action === 'terminal') return { result: 'terminal', output: null };

  if (kind === 'elicitation') {
    if (action === 'accept') {
      const content = body.content && typeof body.content === 'object' ? body.content : {};
      return { result: 'accept', output: { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content } } };
    }
    if (action === 'decline' || action === 'cancel') {
      return { result: action, output: { hookSpecificOutput: { hookEventName: 'Elicitation', action } } };
    }
    throw badRequest(`不明な操作です: ${action}`);
  }

  if (action === 'deny') {
    const message = String(body.message || '').trim() || 'ユーザーがブラウザから拒否しました。';
    return { result: 'deny', output: permissionOutput({ behavior: 'deny', message, ...(body.interrupt ? { interrupt: true } : {}) }) };
  }

  if (kind === 'question') {
    const input = req.tool_input || {};
    if (action === 'answer') {
      const questions = input.questions || [];
      const answers = {};
      for (const q of questions) {
        const v = body.answers?.[q.question];
        const s = Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v ?? '').trim();
        if (!s) throw badRequest(`未回答の質問があります: ${q.header || q.question}`);
        answers[q.question] = s;
      }
      const annotations = {};
      for (const [q, a] of Object.entries(body.annotations || {})) {
        const notes = String(a?.notes || '').trim();
        const preview = typeof a?.preview === 'string' ? a.preview : '';
        if (notes || preview) annotations[q] = { ...(notes ? { notes } : {}), ...(preview ? { preview } : {}) };
      }
      const updatedInput = { ...input, answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
      return { result: 'answer', output: permissionOutput({ behavior: 'allow', updatedInput }) };
    }
    if (action === 'respond') {
      // 選択肢を選ばずに自由に返信するにゃ（TUI の「Chat about this」相当）
      const text = String(body.text || '').trim();
      if (!text) throw badRequest('返信内容が空です');
      return {
        result: 'respond',
        output: permissionOutput({ behavior: 'deny', message: `ユーザーは選択肢を選ばずに次のように返信しました:\n${text}` }),
      };
    }
    throw badRequest(`不明な操作です: ${action}`);
  }

  if (kind === 'plan') {
    if (action === 'approve') {
      const mode = String(body.mode || '');
      const allowed = new Set(['auto', 'acceptEdits', 'default']);
      // ExitPlanMode は allow だけでは不十分で、updatedInput を添える必要があるにゃ
      const decision = { behavior: 'allow', updatedInput: { ...(req.tool_input || {}) } };
      if (allowed.has(mode)) decision.updatedPermissions = [{ type: 'setMode', mode, destination: 'session' }];
      return { result: 'approve', output: permissionOutput(decision) };
    }
    if (action === 'revise') {
      const feedback = String(body.message || '').trim();
      if (!feedback) throw badRequest('修正内容を入力してください');
      return { result: 'revise', output: permissionOutput({ behavior: 'deny', message: feedback }) };
    }
    throw badRequest(`不明な操作です: ${action}`);
  }

  // 通常のツール権限確認にゃ
  if (action === 'allow') return { result: 'allow', output: permissionOutput({ behavior: 'allow' }) };
  if (action === 'allowAlways') {
    const all = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
    const idx = Array.isArray(body.suggestions) ? body.suggestions : all.map((_, i) => i);
    const updatedPermissions = idx.map((i) => all[i]).filter(Boolean);
    return {
      result: 'allowAlways',
      output: permissionOutput({ behavior: 'allow', ...(updatedPermissions.length ? { updatedPermissions } : {}) }),
    };
  }
  throw badRequest(`不明な操作です: ${action}`);
}

/** 一覧表示用の短い説明にゃ */
export function describe(req) {
  const kind = kindOf(req);
  if (kind === 'question') {
    const qs = req.tool_input?.questions || [];
    const head = qs[0]?.header || qs[0]?.question || '質問';
    return `質問: ${head}${qs.length > 1 ? ` ほか${qs.length - 1}件` : ''}`;
  }
  if (kind === 'plan') return '計画の承認待ち';
  if (kind === 'elicitation') return `入力要求: ${req.mcp_server_name || 'MCP'}`;
  return `許可待ち: ${req.tool_name}`;
}
