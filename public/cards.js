// 対話カードです。
// - 回答待ちカード（質問 / 計画承認 / 権限確認 / MCP 入力要求）: ブラウザから回答できます
// - 履歴カード（質問と回答 / 計画 / TODO）: 会話タブに表示します
import { esc, inline, renderMarkdown } from './md.js';

// ---------- 共通 ----------

const MODE_LABEL = { auto: 'auto', acceptEdits: '編集の自動承認', default: '都度確認', manual: '都度確認', plan: 'plan', bypassPermissions: '全許可', dontAsk: '確認なし' };
const DEST_LABEL = { session: 'このセッション', localSettings: 'ローカル設定', projectSettings: 'プロジェクト設定', userSettings: 'ユーザー設定' };

function terminalButton() {
  return '<button type="button" data-action="terminal" class="ghost" title="ブラウザでは回答せず、tmux 上のダイアログで回答します">ターミナルで回答</button>';
}

function cardHead(kindLabel, title, item) {
  return `<header class="icard-head">
    <span class="badge st-waiting">${esc(kindLabel)}</span>
    <span class="icard-title">${title}</span>
    <span class="elapsed" data-since="${item.createdAt || ''}"></span>
  </header>`;
}

function prettyJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function truncateLines(text, max = 80) {
  const lines = String(text ?? '').split('\n');
  return lines.length > max ? { text: lines.slice(0, max).join('\n'), more: lines.length - max } : { text: lines.join('\n'), more: 0 };
}

// ---------- 質問（AskUserQuestion） ----------

function questionCard(item) {
  const qs = item.request.tool_input?.questions || [];
  const body = qs
    .map((q, qi) => {
      const multi = !!q.multiSelect;
      const type = multi ? 'checkbox' : 'radio';
      const hasPreview = (q.options || []).some((o) => o.preview);
      const opts = (q.options || [])
        .map(
          (o, oi) => `<label class="opt" data-oi="${oi}">
            <input type="${type}" name="q${item.reqId}-${qi}" value="${oi}">
            <span class="opt-num">${oi + 1}</span>
            <span class="opt-main"><span class="opt-label">${esc(o.label)}</span>${o.description ? `<span class="opt-desc">${inline(o.description)}</span>` : ''}</span>
          </label>`,
        )
        .join('');
      const other = `<label class="opt opt-other" data-oi="other">
          <input type="${type}" name="q${item.reqId}-${qi}" value="other">
          <span class="opt-num">${(q.options || []).length + 1}</span>
          <span class="opt-main"><span class="opt-label">その他</span><input type="text" class="other-text" placeholder="自由に入力してください"></span>
        </label>`;
      return `<section class="q" data-qi="${qi}">
        <div class="q-top">
          ${q.header ? `<span class="chip">${esc(q.header)}</span>` : ''}
          <span class="q-mode">${multi ? '複数選択可' : '1つ選択'}</span>
          <span class="q-check" hidden>✓</span>
        </div>
        <div class="q-text">${inline(q.question)}</div>
        <div class="q-body${hasPreview ? ' with-preview' : ''}">
          <div class="q-options">${opts}${other}</div>
          ${hasPreview ? '<div class="q-preview-wrap"><div class="q-preview-label">プレビュー</div><pre class="q-preview"></pre></div>' : ''}
        </div>
        <input type="text" class="q-notes" placeholder="メモ（任意・回答に添えて送信されます）">
      </section>`;
    })
    .join('');
  return `<form class="icard icard-question" data-req="${item.reqId}" tabindex="-1">
    ${cardHead('質問', `Claude からの質問${qs.length > 1 ? `（${qs.length}件）` : ''}`, item)}
    <div class="icard-body">${body}</div>
    <div class="reply-box" hidden>
      <textarea rows="3" class="reply-text" placeholder="選択肢を選ばずに Claude へ返信します"></textarea>
    </div>
    <footer class="icard-actions">
      <button type="submit" class="primary" data-action="answer">回答を送信</button>
      <button type="button" data-action="toggle-reply">選択せずに返信…</button>
      <button type="button" data-action="decline" class="danger">回答しない</button>
      <span class="spacer"></span>
      <span class="hint">数字キーで選択</span>
      ${terminalButton()}
    </footer>
  </form>`;
}

function wireQuestion(card, item, respond) {
  const qs = item.request.tool_input?.questions || [];
  let activeQi = 0;

  const selectedPreview = (sec) => {
    const q = qs[Number(sec.dataset.qi)];
    const checked = [...sec.querySelectorAll('.q-options input:checked')].map((i) => i.value).filter((v) => v !== 'other');
    return checked.length ? q.options[Number(checked[checked.length - 1])]?.preview || '' : '';
  };
  const showPreview = (sec, text) => {
    const pre = sec.querySelector('.q-preview');
    if (!pre) return;
    pre.textContent = text || '（この選択肢にはプレビューがありません）';
  };
  const refresh = () => {
    for (const sec of card.querySelectorAll('.q')) {
      const answered = [...sec.querySelectorAll('.q-options input:checked')].some(
        (i) => i.value !== 'other' || sec.querySelector('.other-text').value.trim(),
      );
      sec.querySelector('.q-check').hidden = !answered;
      sec.classList.toggle('answered', answered);
      for (const opt of sec.querySelectorAll('.opt')) opt.classList.toggle('checked', opt.querySelector('input').checked);
    }
  };
  // 初期プレビューは最初の選択肢のものです
  for (const sec of card.querySelectorAll('.q')) {
    const q = qs[Number(sec.dataset.qi)];
    showPreview(sec, q.options?.find((o) => o.preview)?.preview);
  }

  card.addEventListener('mouseover', (e) => {
    const opt = e.target.closest('.opt[data-oi]');
    if (!opt || opt.dataset.oi === 'other') return;
    const sec = opt.closest('.q');
    showPreview(sec, qs[Number(sec.dataset.qi)].options[Number(opt.dataset.oi)]?.preview);
  });
  card.addEventListener('mouseout', (e) => {
    const sec = e.target.closest('.q');
    if (sec && !sec.contains(e.relatedTarget)) {
      const p = selectedPreview(sec);
      if (p) showPreview(sec, p);
    }
  });
  card.addEventListener('focusin', (e) => {
    const sec = e.target.closest('.q');
    if (sec) activeQi = Number(sec.dataset.qi);
  });
  card.addEventListener('change', (e) => {
    const sec = e.target.closest('.q');
    if (sec) {
      activeQi = Number(sec.dataset.qi);
      const p = selectedPreview(sec);
      if (p) showPreview(sec, p);
    }
    refresh();
  });
  card.addEventListener('input', (e) => {
    if (e.target.classList.contains('other-text')) {
      const radio = e.target.closest('.opt').querySelector('input[type=radio],input[type=checkbox]');
      if (e.target.value.trim() && !radio.checked) radio.checked = true;
      refresh();
    }
  });
  // 数字キーで現在の質問の選択肢を選びます（文字入力中は無効）
  card.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type=text], textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const sec = card.querySelector(`.q[data-qi="${activeQi}"]`);
    const input = sec?.querySelectorAll('.q-options input')[Number(e.key) - 1];
    if (!input) return;
    e.preventDefault();
    input.checked = input.type === 'checkbox' ? !input.checked : true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (input.value === 'other') input.closest('.opt').querySelector('.other-text').focus();
  });

  card.addEventListener('submit', (e) => {
    e.preventDefault();
    const answers = {};
    const annotations = {};
    for (const sec of card.querySelectorAll('.q')) {
      const q = qs[Number(sec.dataset.qi)];
      const otherText = sec.querySelector('.other-text').value.trim();
      const vals = [];
      for (const i of sec.querySelectorAll('.q-options input:checked')) {
        if (i.value === 'other') {
          if (otherText) vals.push(otherText);
        } else vals.push(q.options[Number(i.value)].label);
      }
      if (!vals.length) {
        sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        sec.classList.add('missing');
        setTimeout(() => sec.classList.remove('missing'), 1200);
        return;
      }
      answers[q.question] = q.multiSelect ? vals : vals[0];
      const notes = sec.querySelector('.q-notes').value.trim();
      const preview = !q.multiSelect ? selectedPreview(sec) : '';
      if (notes || preview) annotations[q.question] = { notes, preview };
    }
    respond({ action: 'answer', answers, annotations });
  });

  card.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b || b.type === 'submit') return;
    const action = b.dataset.action;
    if (action === 'toggle-reply') {
      const box = card.querySelector('.reply-box');
      if (box.hidden) {
        box.hidden = false;
        b.textContent = '返信を送信';
        box.querySelector('textarea').focus();
      } else {
        const text = box.querySelector('textarea').value.trim();
        if (text) respond({ action: 'respond', text });
        else box.querySelector('textarea').focus();
      }
    } else if (action === 'decline') {
      respond({ action: 'deny', message: 'ユーザーはこの質問への回答を辞退しました。質問せずに進めるか、別の方法を提案してください。' });
    } else if (action === 'terminal') respond({ action: 'terminal' });
  });
}

// ---------- 計画（ExitPlanMode） ----------

function planCard(item) {
  const input = item.request.tool_input || {};
  return `<div class="icard icard-plan" data-req="${item.reqId}">
    ${cardHead('計画', '実行前に計画の承認を求めています', item)}
    <div class="icard-body">
      <div class="plan-body md">${renderMarkdown(input.plan || '（計画本文がありません）')}</div>
      ${input.planFilePath ? `<div class="muted mono">${esc(input.planFilePath)}</div>` : ''}
      <textarea rows="2" class="plan-feedback" placeholder="修正してほしい点を入力してください"></textarea>
    </div>
    <footer class="icard-actions">
      <button type="button" class="primary" data-action="approve" data-mode="auto">承認（auto モードで実行）</button>
      <button type="button" data-action="approve" data-mode="acceptEdits">承認（編集を自動承認）</button>
      <button type="button" data-action="approve" data-mode="default">承認（編集は都度確認）</button>
      <button type="button" data-action="revise">修正を依頼</button>
      <span class="spacer"></span>
      ${terminalButton()}
    </footer>
  </div>`;
}

function wirePlan(card, item, respond) {
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    if (b.dataset.action === 'approve') respond({ action: 'approve', mode: b.dataset.mode });
    else if (b.dataset.action === 'revise') {
      const ta = card.querySelector('.plan-feedback');
      if (!ta.value.trim()) return ta.focus();
      respond({ action: 'revise', message: ta.value.trim() });
    } else if (b.dataset.action === 'terminal') respond({ action: 'terminal' });
  });
}

// ---------- 権限確認（通常ツール） ----------

function describeSuggestion(s) {
  const dest = DEST_LABEL[s.destination] || s.destination || '';
  switch (s.type) {
    case 'addRules':
    case 'replaceRules': {
      const rules = (s.rules || []).map((r) => `${r.toolName}${r.ruleContent ? `(${r.ruleContent})` : ''}`).join(', ');
      const behavior = s.behavior === 'deny' ? '拒否' : s.behavior === 'ask' ? '確認' : '許可';
      return `${behavior}ルールを追加: <code>${esc(rules)}</code>（${esc(dest)}）`;
    }
    case 'setMode':
      return `権限モードを「${esc(MODE_LABEL[s.mode] || s.mode)}」に変更（${esc(dest)}）`;
    case 'addDirectories':
      return `作業ディレクトリを追加: <code>${esc((s.directories || []).join(', '))}</code>（${esc(dest)}）`;
    default:
      return `<code>${esc(JSON.stringify(s))}</code>`;
  }
}

function diffHtml(oldStr, newStr) {
  const minus = String(oldStr ?? '').split('\n').map((l) => `<span class="del">- ${esc(l)}</span>`);
  const plus = String(newStr ?? '').split('\n').map((l) => `<span class="add">+ ${esc(l)}</span>`);
  return `<pre class="diff">${[...minus, ...plus].join('\n')}</pre>`;
}

function toolDetail(tool, input = {}) {
  if (tool === 'Bash') {
    return `<pre class="cmd">$ ${esc(input.command)}</pre>${input.description ? `<div class="muted">${esc(input.description)}</div>` : ''}`;
  }
  if (tool === 'Write') {
    const t = truncateLines(input.content);
    return `<div class="mono path">${esc(input.file_path)}</div><pre class="code">${esc(t.text)}</pre>${t.more ? `<div class="muted">… ほか ${t.more} 行</div>` : ''}`;
  }
  if (tool === 'Edit') {
    return `<div class="mono path">${esc(input.file_path)}${input.replace_all ? ' <span class="chip">すべて置換</span>' : ''}</div>${diffHtml(input.old_string, input.new_string)}`;
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return `<div class="mono path">${esc(input.file_path)}</div>${input.edits.map((e) => diffHtml(e.old_string, e.new_string)).join('')}`;
  }
  if (tool === 'WebFetch') {
    return `<div class="mono path"><a href="${esc(input.url)}" target="_blank" rel="noopener noreferrer">${esc(input.url)}</a></div>${input.prompt ? `<div class="muted">${esc(input.prompt)}</div>` : ''}`;
  }
  if (tool === 'WebSearch') return `<div>検索: <code>${esc(input.query)}</code></div>`;
  if (tool === 'Read' || tool === 'NotebookEdit') return `<div class="mono path">${esc(input.file_path || input.notebook_path)}</div><pre class="code">${esc(prettyJson(input))}</pre>`;
  return `<pre class="code">${esc(prettyJson(input))}</pre>`;
}

function permissionCard(item) {
  const r = item.request;
  const sugg = Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [];
  const suggHtml = sugg.length
    ? `<div class="suggestions"><div class="muted">「許可して記憶」で適用される設定:</div>${sugg
        .map((s, i) => `<label class="sugg"><input type="checkbox" value="${i}" checked> ${describeSuggestion(s)}</label>`)
        .join('')}</div>`
    : '';
  return `<div class="icard icard-permission" data-req="${item.reqId}">
    ${cardHead('権限', `<b>${esc(r.tool_name)}</b> の実行許可を求めています`, item)}
    <div class="icard-body">
      ${toolDetail(r.tool_name, r.tool_input)}
      ${suggHtml}
      <div class="deny-row">
        <input type="text" class="deny-reason" placeholder="拒否する理由（任意・Claude に伝えられます）">
        <label class="inline-check"><input type="checkbox" class="deny-interrupt"> 作業も中断する</label>
      </div>
    </div>
    <footer class="icard-actions">
      <button type="button" class="primary" data-action="allow">許可</button>
      ${sugg.length ? '<button type="button" data-action="allowAlways">許可して記憶</button>' : ''}
      <button type="button" class="danger" data-action="deny">拒否</button>
      <span class="spacer"></span>
      ${terminalButton()}
    </footer>
  </div>`;
}

function wirePermission(card, item, respond) {
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    const a = b.dataset.action;
    if (a === 'allow') respond({ action: 'allow' });
    else if (a === 'allowAlways') {
      const suggestions = [...card.querySelectorAll('.sugg input:checked')].map((i) => Number(i.value));
      respond({ action: 'allowAlways', suggestions });
    } else if (a === 'deny') {
      respond({
        action: 'deny',
        message: card.querySelector('.deny-reason').value.trim(),
        interrupt: card.querySelector('.deny-interrupt').checked,
      });
    } else if (a === 'terminal') respond({ action: 'terminal' });
  });
}

// ---------- MCP 入力要求（Elicitation） ----------

function enumChoices(schema) {
  if (Array.isArray(schema.enum)) return schema.enum.map((v, i) => ({ value: v, title: schema.enumNames?.[i] ?? String(v) }));
  const list = schema.oneOf || schema.anyOf;
  if (Array.isArray(list) && list.every((x) => 'const' in x)) return list.map((x) => ({ value: x.const, title: x.title ?? String(x.const) }));
  return null;
}

function fieldHtml(name, schema, required) {
  const label = `${esc(schema.title || name)}${required ? ' <span class="req">*</span>' : ''}`;
  const desc = schema.description ? `<span class="muted">${inline(schema.description)}</span>` : '';
  const choices = enumChoices(schema);
  const def = schema.default;
  let control;
  if (schema.type === 'boolean') {
    control = `<label class="inline-check"><input type="checkbox" data-field="${esc(name)}" data-type="boolean"${def ? ' checked' : ''}> ${esc(schema.title || name)}</label>`;
    return `<div class="field">${control}${desc}</div>`;
  }
  if (schema.type === 'array') {
    const items = enumChoices(schema.items || {}) || [];
    control = items
      .map(
        (c) =>
          `<label class="inline-check"><input type="checkbox" data-field="${esc(name)}" data-type="array" value="${esc(JSON.stringify(c.value))}"${Array.isArray(def) && def.includes(c.value) ? ' checked' : ''}> ${esc(c.title)}</label>`,
      )
      .join('');
    // チェックボックス群は label の入れ子にならないよう div で包みます
    return `<div class="field"><span>${label}</span><div>${control}</div>${desc}</div>`;
  } else if (choices) {
    control = `<select data-field="${esc(name)}" data-type="enum">${required ? '' : '<option value="">（未選択）</option>'}${choices
      .map((c) => `<option value="${esc(JSON.stringify(c.value))}"${c.value === def ? ' selected' : ''}>${esc(c.title)}</option>`)
      .join('')}</select>`;
  } else if (schema.type === 'number' || schema.type === 'integer') {
    control = `<input type="number" data-field="${esc(name)}" data-type="${schema.type}"${schema.minimum != null ? ` min="${schema.minimum}"` : ''}${schema.maximum != null ? ` max="${schema.maximum}"` : ''}${schema.type === 'integer' ? ' step="1"' : ''}${def != null ? ` value="${esc(def)}"` : ''}${required ? ' required' : ''}>`;
  } else {
    const t = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' }[schema.format] || 'text';
    control = `<input type="${t}" data-field="${esc(name)}" data-type="string"${schema.minLength ? ` minlength="${schema.minLength}"` : ''}${schema.maxLength ? ` maxlength="${schema.maxLength}"` : ''}${def != null ? ` value="${esc(def)}"` : ''}${required ? ' required' : ''}>`;
  }
  return `<label class="field"><span>${label}</span>${control}${desc}</label>`;
}

function elicitationCard(item) {
  const r = item.request;
  const schema = r.requested_schema || {};
  const req = new Set(schema.required || []);
  const isUrl = r.mode === 'url';
  const fields = isUrl ? '' : Object.entries(schema.properties || {}).map(([k, s]) => fieldHtml(k, s, req.has(k))).join('');
  return `<form class="icard icard-elicitation" data-req="${item.reqId}">
    ${cardHead('入力要求', `MCP サーバ <b>${esc(r.mcp_server_name || '')}</b> が入力を求めています`, item)}
    <div class="icard-body">
      <div class="md">${renderMarkdown(r.message || '')}</div>
      ${isUrl && r.url ? `<p><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a> を開いて手続きを完了してください。</p>` : ''}
      <div class="fields">${fields}</div>
    </div>
    <footer class="icard-actions">
      <button type="submit" class="primary" data-action="accept">${isUrl ? '完了しました' : '送信'}</button>
      <button type="button" data-action="decline">辞退</button>
      <button type="button" data-action="cancel" class="danger">キャンセル</button>
      <span class="spacer"></span>
      ${terminalButton()}
    </footer>
  </form>`;
}

function wireElicitation(card, item, respond) {
  card.addEventListener('submit', (e) => {
    e.preventDefault();
    const content = {};
    for (const el of card.querySelectorAll('[data-field]')) {
      const k = el.dataset.field;
      const t = el.dataset.type;
      if (t === 'boolean') content[k] = el.checked;
      else if (t === 'array') {
        content[k] ||= [];
        if (el.checked) content[k].push(JSON.parse(el.value));
      } else if (t === 'enum') {
        if (el.value) content[k] = JSON.parse(el.value);
      } else if (t === 'number' || t === 'integer') {
        if (el.value !== '') content[k] = Number(el.value);
      } else if (el.value !== '') content[k] = el.value;
    }
    respond({ action: 'accept', content });
  });
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b || b.type === 'submit') return;
    respond({ action: b.dataset.action });
  });
}

// ---------- 回答待ちカードの設置 ----------

const RENDER = {
  question: [questionCard, wireQuestion],
  plan: [planCard, wirePlan],
  permission: [permissionCard, wirePermission],
  elicitation: [elicitationCard, wireElicitation],
};

/**
 * 回答待ちカードを描画します。
 * respond(reqId, body) は Promise を返す関数で、失敗時は例外を投げます
 */
export function mountPending(root, items, respond, onError) {
  root.innerHTML = items.map((it) => (RENDER[it.kind] || RENDER.permission)[0](it)).join('');
  root.hidden = !items.length;
  for (const it of items) {
    const card = root.querySelector(`[data-req="${it.reqId}"]`);
    if (!card) continue;
    const send = async (body) => {
      const buttons = card.querySelectorAll('button');
      buttons.forEach((b) => (b.disabled = true));
      card.classList.add('sending');
      try {
        await respond(it.reqId, body);
        card.classList.add('done');
      } catch (e) {
        buttons.forEach((b) => (b.disabled = false));
        card.classList.remove('sending');
        onError?.(e);
      }
    };
    (RENDER[it.kind] || RENDER.permission)[1](card, it, send);
  }
  root.querySelector('.icard-question')?.focus({ preventScroll: true });
}

// ---------- 履歴カード ----------

function answeredSet(answer) {
  if (Array.isArray(answer)) return answer.map(String);
  return String(answer ?? '')
    .split(', ')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function questionHistory(it) {
  const replied = it.status === 'rejected' && /^ユーザーは選択肢を選ばずに/.test(it.resultText || '');
  const status = it.status === 'answered' ? '回答済み' : replied ? '返信' : it.status === 'rejected' ? '未回答で終了' : '回答待ち';
  if (it.status === 'pending') {
    // 回答待ちの間は下のパネルで回答するので、履歴側は簡略表示にします
    return `<div class="hcard hcard-question hcard-compact">
      <div class="hcard-head"><span class="badge st-waiting">${status}</span> 質問（下のパネルで回答できます）</div>
      ${(it.questions || []).map((q) => `<div class="q-text">・${inline(q.question)}</div>`).join('')}
    </div>`;
  }
  const qs = (it.questions || [])
    .map((q) => {
      const ans = it.answers?.[q.question];
      const chosen = answeredSet(ans);
      const labels = new Set((q.options || []).map((o) => o.label));
      const otherVals = chosen.filter((c) => !labels.has(c));
      const opts = (q.options || [])
        .map((o) => {
          const on = chosen.includes(o.label);
          return `<li class="${on ? 'chosen' : ''}"><span class="mark">${on ? (q.multiSelect ? '☑' : '◉') : q.multiSelect ? '☐' : '○'}</span><span><b>${esc(o.label)}</b>${o.description ? `<span class="opt-desc">${inline(o.description)}</span>` : ''}${
            o.preview ? `<details class="pv"><summary>プレビュー</summary><pre class="q-preview">${esc(o.preview)}</pre></details>` : ''
          }</span></li>`;
        })
        .join('');
      // 回答が単一文字列で選択肢と一致しない場合は自由記述とみなします（カンマを含む自由記述にも対応）
      const free = ans != null && !q.multiSelect && !labels.has(String(ans)) ? String(ans) : otherVals.join(', ');
      const notes = it.annotations?.[q.question]?.notes;
      return `<div class="hq">
        <div class="q-top">${q.header ? `<span class="chip">${esc(q.header)}</span>` : ''}<span class="q-mode">${q.multiSelect ? '複数選択' : '単一選択'}</span></div>
        <div class="q-text">${inline(q.question)}</div>
        <ul class="hq-opts">${opts}</ul>
        ${free ? `<div class="hq-free">その他: ${esc(free)}</div>` : ''}
        ${notes ? `<div class="hq-notes">メモ: ${esc(notes)}</div>` : ''}
      </div>`;
    })
    .join('');
  return `<div class="hcard hcard-question">
    <div class="hcard-head"><span class="badge ${it.status === 'answered' ? 'st-done' : it.status === 'rejected' ? 'st-ended' : 'st-waiting'}">${status}</span> 質問</div>
    ${qs}
    ${it.resultText && it.status !== 'answered' ? `<div class="muted hq-result">${esc(it.resultText)}</div>` : ''}
  </div>`;
}

export function planHistory(it) {
  const status = it.status === 'approved' ? '承認' : it.status === 'rejected' ? '差し戻し' : '承認待ち';
  const cls = it.status === 'approved' ? 'st-done' : it.status === 'rejected' ? 'st-ended' : 'st-waiting';
  const feedback = it.status === 'rejected' && it.resultText ? `<div class="hq-notes">${esc(it.resultText)}</div>` : '';
  return `<details class="hcard hcard-plan" data-key="plan-${esc(it.id)}"${it.status !== 'approved' ? ' open' : ''}>
    <summary class="hcard-head"><span class="badge ${cls}">${status}</span> 計画</summary>
    <div class="md">${renderMarkdown(it.plan)}</div>
    ${feedback}
  </details>`;
}

export function todosHistory(it) {
  const icon = { completed: '☑', in_progress: '◐', pending: '☐' };
  const items = (it.todos || [])
    .map((t) => `<li class="todo-${esc(t.status)}"><span class="mark">${icon[t.status] || '☐'}</span>${esc(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</li>`)
    .join('');
  const done = (it.todos || []).filter((t) => t.status === 'completed').length;
  return `<div class="hcard hcard-todos"><div class="hcard-head">TODO <span class="muted">${done}/${(it.todos || []).length}</span></div><ul class="todos">${items}</ul></div>`;
}
