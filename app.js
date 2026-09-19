/* 科研 idea 评审问卷 —— 前端。
 *
 * 数据流：items.json(题面，公开) + Apps Script(题序、已答、写回)。
 * 机器判定与「真实论文 / agent」标签不在这里，也不该在这里。
 *
 * POST 一律用 Content-Type: text/plain —— Apps Script 没有 doOptions，
 * 用 application/json 会触发 preflight 然后 CORS 失败。
 */
'use strict';

const CFG = window.SURVEY_CONFIG || {};
const PREVIEW = !CFG.ENDPOINT;

const SESSION_ID = (() => {
  try {
    let s = sessionStorage.getItem('sid');
    if (!s) { s = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('sid', s); }
    return s;
  } catch (e) { return Math.random().toString(36).slice(2, 10); }
})();

const S = {
  code: null, items: [], order: [], meta: {},
  answers: {}, idx: 0, finished: false,
  survey: 'judge', surveyTitle: '',
  // 交完之后点「重新填一份」时置真：下一次 join 不按名字接续，一定新建
  fresh: false,
};

/* 两份问卷共用这一个页面，靠邀请码分流：邀请码决定分到哪些题、看到哪段说明。
   受试者要求不一样，所以各发各的链接，互不相见。 */
const SURVEYS = {
  judge: {
    title: 'LLM judge 一致性',
    blurb: '每题给你两个匿名化的研究 idea 描述，请判断它们是不是同一个 idea。' +
           '我们要看的是人的判断与一套自动判定方法是否一致，所以<b>没有标准答案</b>，' +
           '按你自己的标准判即可。',
  },
  quality: {
    title: 'Idea 质量评审',
    blurb: '每题给你一个研究 idea 的结构化描述，请像审稿一样给它打分，' +
           '并判断它做不做得出来、实验大概率会不会 work。' +
           '部分 idea 来自真实论文，部分由模型生成，<b>题面已统一格式</b>，请只依据内容评判。',
  },
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ------------------------------------------------------------------ 网络 */

function setSave(state, text) {
  const n = $('saveState');
  n.dataset.s = state;
  n.textContent = text || { saved: '已保存', saving: '保存中…', offline: '未保存·重试中', preview: '预览模式' }[state];
}

async function apiGet(params) {
  const q = new URLSearchParams(params);   // 无共享 token：邀请码就是凭据
  const r = await fetch(`${CFG.ENDPOINT}?${q}`, { redirect: 'follow' });
  if (!r.ok) throw new Error('GET ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'server rejected');
  return j;
}

async function apiPost(body) {
  const r = await fetch(CFG.ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 不要改成 json
    redirect: 'follow',
    body: JSON.stringify({ code: S.code, session_id: SESSION_ID, ...body }),
  });
  if (!r.ok) throw new Error('POST ' + r.status);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'server rejected');
  return j;
}

/* 攒批发送。失败不丢答案：留在队列里退避重试，本地也留一份。 */
const Outbox = {
  pending: new Map(), timer: null, inflight: false,
  queue(entry) {
    if (PREVIEW) return;
    this.pending.set(entry.item_id, entry);
    this.persist();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 5000);
    setSave('saving');
  },
  async flush() {
    if (PREVIEW || this.inflight || !this.pending.size) return;
    const batch = [...this.pending.values()];
    this.inflight = true;
    try {
      await apiPost({ action: 'save', items: batch });
      // 期间又被改过的不能删，否则那次修改会丢
      batch.forEach(e => { if (this.pending.get(e.item_id) === e) this.pending.delete(e.item_id); });
      this.persist();
      setSave(this.pending.size ? 'saving' : 'saved');
    } catch (err) {
      console.warn('flush failed:', err);
      setSave('offline');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 15000);
    } finally { this.inflight = false; }
  },
  persist() {
    try { localStorage.setItem('outbox:' + S.code, JSON.stringify([...this.pending.values()])); }
    catch (e) { /* 隐身模式存不下就算了，服务端才是真相 */ }
  },
  restore() {
    try {
      const raw = localStorage.getItem('outbox:' + S.code);
      if (raw) JSON.parse(raw).forEach(e => this.pending.set(e.item_id, e));
      if (this.pending.size) this.flush();
    } catch (e) { /* 同上 */ }
  },
};

window.addEventListener('pagehide', () => {
  if (PREVIEW || !Outbox.pending.size) return;
  try {
    fetch(CFG.ENDPOINT, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ code: S.code, session_id: SESSION_ID,
                             action: 'save', items: [...Outbox.pending.values()] }),
    });
  } catch (e) { /* 卸载期发不出去也没辙，本地已存 */ }
});

/* -------------------------------------------------------------- 题面渲染 */

function fieldsHtml(schema) {
  return (S.meta.shown_fields || Object.keys(schema)).map(f => {
    const v = schema[f];
    const body = Array.isArray(v)
      ? `<ul>${v.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
      : esc(v);
    return `<div class="fld"><span class="k">${esc(f)}</span><div class="v">${body}</div></div>`;
  }).join('');
}

function scale(name, opts) {
  return `<div class="scale">${opts.map(o =>
    `<label><input type="radio" name="${name}" value="${esc(o.v)}"><em>${esc(o.t)}</em>` +
    (o.s ? `<span>${esc(o.s)}</span>` : '') + `</label>`).join('')}</div>`;
}
const n15 = (lo, hi) => [{ v: 1, t: '1', s: lo }, { v: 2, t: '2' }, { v: 3, t: '3' },
                         { v: 4, t: '4' }, { v: 5, t: '5', s: hi }];

function renderA(it) {
  const fields = S.meta.shown_fields || [];
  const rows = fields.map(f => `<tr><td>${esc(f)}</td>
      <td><label class="opt"><input type="radio" name="f_${f}" value="same"></label></td>
      <td><label class="opt"><input type="radio" name="f_${f}" value="diff"></label></td>
      <td><label class="opt"><input type="radio" name="f_${f}" value="unsure"></label></td></tr>`).join('');
  return `
    <div class="cmp">
      <div class="col a"><div class="colhead">SCHEMA A</div>${fieldsHtml(it.A)}</div>
      <div class="col b"><div class="colhead">SCHEMA B</div>${fieldsHtml(it.B)}</div>
    </div>
    <div class="ans">
      <h4>第一步 · 逐字段判定</h4>
      <p class="hint">只看这一个字段，当其余字段被遮住。措辞、命名、详略不同不算不同；
        只是同一个话题 / 任务 / 数据集 / 技术家族<b>不算</b>相同。
        任一侧该字段没有内容一律判「不同」。</p>
      <div class="tscroll"><table class="grid">
        <thead><tr><th>字段</th><th>相同</th><th>不同</th><th>说不准</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <div class="ans">
      <h4>第二步 · 整体判定</h4>
      <div class="row">
        <div class="q">A 与 B 是否是同一个 core idea？
          <small>门槛：处理的 problem 实质相同 <b>且</b> 提出的 approach 实质相同。
            这不是上面五格的投票或平均——只在 problem / motivation / contribution_type
            上一致<b>不够</b>。</small></div>
        ${scale('same_idea', [{ v: 'yes', t: '是' }, { v: 'no', t: '否' }])}
      </div>
      <div class="row">
        <div class="q">把握程度</div>
        ${scale('confidence', n15('很不确定', '很确定'))}
      </div>
      <div class="row"><div class="q">一句话理由<small>写清决定性的那一点，不要复述两边</small></div></div>
      <textarea name="reason" rows="2"></textarea>
    </div>`;
}

function renderB(it) {
  return `
    ${fieldsHtml(it.schema)}
    <div class="ans">
      <h4>第一组 · 评审维度（1–5）</h4>
      <div class="row"><div class="q"><b>Originality</b>
        <small>相对你所知的已有工作，这个 delta 是真的吗、有多大？</small></div>
        ${scale('originality', n15('已有', '开新路'))}</div>
      <div class="row"><div class="q"><b>Significance</b>
        <small>若主张成立，会改变多少人的做法？</small></div>
        ${scale('significance', n15('无人关心', '改变领域'))}</div>
      <div class="row"><div class="q"><b>Soundness of the plan</b>
        <small>research_plan 里的证据真能支撑它要证的东西吗？baseline、消融、失败条件够不够？</small></div>
        ${scale('soundness', n15('证不出', '严密'))}</div>
      <div class="row"><div class="q"><b>Specificity</b>
        <small>说清楚到可以照着动手了吗？还是停在口号层面？</small></div>
        ${scale('specificity', n15('空泛', '可执行'))}</div>
    </div>
    <div class="ans">
      <h4>第二组 · 能不能做 / 会不会成</h4>
      <div class="note"><b>统一预算前提：</b>一名博士生 + 两名合作者，3 个月，8×A100，
        公开数据与公开 API，无自采实验数据。下面两问都以此为准。</div>
      <div class="row"><div class="q"><b>Feasibility</b> — 在上述预算内做得出来吗？</div>
        ${scale('feasibility', [{ v: 1, t: '1', s: '做不了' }, { v: 2, t: '2', s: '要砍' },
                                { v: 3, t: '3', s: '勉强' }, { v: 4, t: '4', s: '可以' },
                                { v: 5, t: '5', s: '很轻松' }])}</div>
      <div class="row"><div class="q">若 ≤3，卡在哪？<small>多选</small></div></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px 16px;margin-bottom:12px">
        ${['拿不到数据或环境', '算力不够', '缺可用 benchmark 或 ground truth',
           '关键组件未定义，无法实现', '工程量远超 3 个月', '需要人工标注或领域专家']
          .map((t, i) => `<label class="opt"><input type="checkbox" name="blockers" value="b${i + 1}"> ${t}</label>`).join('')}
      </div>
      <div class="row"><div class="q"><b>Expected success</b> — 假设按计划完整做完，主要主张成立的概率？
        <small>问的是「实验会不会 work」，与可行性分开：容易做但多半不 work 的 idea 很常见。</small></div>
        ${scale('success', [{ v: 'p10', t: '<10%' }, { v: 'p10_30', t: '10–30%' },
                            { v: 'p30_50', t: '30–50%' }, { v: 'p50_70', t: '50–70%' },
                            { v: 'p70', t: '>70%' }])}</div>
      <div class="row"><div class="q">最可能让它失败的那一件事</div></div>
      <textarea name="risk" rows="2"></textarea>
    </div>
    <div class="ans">
      <h4>第三组 · 总评</h4>
      <div class="row"><div class="q"><b>Overall rating</b>（ICLR 1–10，只评 idea 本身，不评写作）</div>
        ${scale('overall', [{ v: 1, t: '1' }, { v: 3, t: '3', s: 'reject' },
                            { v: 5, t: '5', s: 'borderline' }, { v: 6, t: '6', s: 'weak acc' },
                            { v: 8, t: '8', s: 'accept' }, { v: 10, t: '10', s: 'top 5%' }])}</div>
      <div class="row"><div class="q">你猜这条是？<small>盲法检查</small></div>
        ${scale('guess_source', [{ v: 'paper', t: '真实论文' }, { v: 'agent', t: 'AI 生成' },
                                 { v: 'unsure', t: '看不出' }])}</div>
      <div class="row"><div class="q">这条 idea 所在的子领域你熟悉吗？</div>
        ${scale('expertise', [{ v: 1, t: '不熟' }, { v: 2, t: '读过' },
                              { v: 3, t: '做过' }, { v: 4, t: '发过' }])}</div>
    </div>`;
}

/* -------------------------------------------------------------- 答案读写 */

function readItem(node) {
  const out = {};
  node.querySelectorAll('input[type=radio]:checked').forEach(i => { out[i.name] = i.value; });
  node.querySelectorAll('input[type=checkbox]:checked').forEach(i => {
    (out[i.name] = out[i.name] || []).push(i.value);
  });
  node.querySelectorAll('textarea, input[type=text]').forEach(i => {
    if (i.value.trim()) out[i.name] = i.value.trim();
  });
  return out;
}

function writeItem(node, ans) {
  if (!ans) return;
  Object.entries(ans).forEach(([name, val]) => {
    const vals = Array.isArray(val) ? val.map(String) : [String(val)];
    node.querySelectorAll(`[name="${CSS.escape(name)}"]`).forEach(i => {
      if (i.type === 'radio' || i.type === 'checkbox') i.checked = vals.includes(i.value);
      else i.value = val;
    });
  });
}

/* ------------------------------------------------------------------ 界面 */

let shownAt = Date.now();

function renderItem() {
  const id = S.order[S.idx];
  const it = S.items.find(x => x.id === id);
  if (!it) { showFatal(`题目 ${id} 不在 items.json 里`); return; }
  shownAt = Date.now();

  const partName = it.part === 'A' ? '判断两个 idea 是否相同' : '评审一个 idea';
  const card = el('div', 'item');
  card.innerHTML =
    `<div class="ihead"><span class="inum">${esc(it.id)}</span>
       <span class="pill">Part ${esc(it.part)} · ${partName}</span></div>
     <div class="ibody" id="itemBody"></div>`;
  card.querySelector('#itemBody').innerHTML = it.part === 'A' ? renderA(it) : renderB(it);

  const main = $('main');
  main.replaceChildren(card);
  window.scrollTo(0, 0);

  const body = card.querySelector('#itemBody');
  writeItem(body, S.answers[it.id]);

  const capture = () => {
    const ans = readItem(body);
    S.answers[it.id] = ans;
    Outbox.queue({ item_id: it.id, part: it.part, answer: ans,
                   client_ts: new Date().toISOString(),
                   elapsed_ms: Date.now() - shownAt });
    updateProgress();
  };
  body.addEventListener('change', capture);
  body.addEventListener('input', e => { if (e.target.tagName === 'TEXTAREA') capture(); });

  $('counter').textContent = `${S.idx + 1} / ${S.order.length}`;
  $('btnPrev').disabled = S.idx === 0;
  const last = S.idx === S.order.length - 1;
  $('btnNext').hidden = last;
  $('btnFinish').hidden = !last;
  $('nav').hidden = false;
  updateProgress();
}

function answered(id) {
  const a = S.answers[id];
  return a && Object.keys(a).length > 0;
}

function updateProgress() {
  const done = S.order.filter(answered).length;
  $('progressBar').style.width = `${(done / Math.max(1, S.order.length)) * 100}%`;
}

function showJoin(msg) {
  $('nav').hidden = true;
  const cfg = SURVEYS[S.survey] || SURVEYS.judge;
  const p = el('div', 'panel');
  p.innerHTML = `
    <h2>${esc(cfg.title)}</h2>
    <p>${cfg.blurb}</p>
    <p>不收集个人身份信息，数据仅用于学术研究。点「开始」即表示同意参与，可随时退出。
      共 ${S.order.length || S.items.length} 题，可分多次完成，答案自动保存。</p>
    ${msg ? `<div class="note">${esc(msg)}</div>` : ''}
    <div class="row" style="margin-top:18px"><div class="q">你的名字</div></div>
    <input type="text" id="nameIn" placeholder="留空 = 匿名" maxlength="60" style="max-width:280px">
    <p style="font-size:12.5px;color:var(--ink3);margin-top:6px">
      填了名字，换设备时打同样的名字就能接着上次继续。</p>
    <p style="margin-top:14px"><button class="primary" id="joinGo">开始</button></p>
    <details style="margin-top:14px">
      <summary style="cursor:pointer;font-size:12.5px;color:var(--ink3)">已经答过一半？</summary>
      <p style="margin-top:8px">同一浏览器直接打开原链接就会接着上次的地方继续。
        换了设备或清过浏览器数据：填了名字的，打同样的名字即可；
        匿名的，用左上角参与者编号找回记录。</p>
    </details>`;
  $('main').replaceChildren(p);

  $('nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinGo').click(); });
  $('joinGo').addEventListener('click', async () => {
    $('joinGo').disabled = true;
    const name = $('nameIn').value.trim();
    if (PREVIEW) { S.code = 'PREVIEW'; showPid(); S.idx = 0; renderItem(); return; }
    try {
      const r = await apiPost({ action: 'join', survey: S.survey, name,
                                fresh: S.fresh, item_ids: S.items.map(i => i.id) });
      rememberPid(S.survey, r.code);
      // 带 ?p= 重载：新建和「按名字接续」走同一条恢复路径，答案回填不用写第二套
      const u = new URL(location.href);
      u.searchParams.set('p', r.code);
      location.href = u.toString();
    } catch (e) {
      $('joinGo').disabled = false;
      showJoin('登记失败：' + e.message + '。请检查网络后重试。');
    }
  });
}

/* 左上角显示参与者编号 —— 换设备找回记录全靠它，所以要一直看得见。 */
function showPid() {
  const n = $('codePill');
  n.textContent = S.code;
  n.title = '参与者编号：换设备或清过浏览器数据时，用它找回记录';
  n.hidden = false;
}

/* 参与者编号按问卷分别记在本地：同一台机器可以先后做两份问卷，互不覆盖。 */
function rememberPid(survey, pid) {
  try { localStorage.setItem('pid:' + survey, pid); } catch (e) { /* 存不下不影响本次作答 */ }
}
function recallPid(survey) {
  try { return localStorage.getItem('pid:' + survey) || ''; } catch (e) { return ''; }
}

function showFatal(msg) {
  $('nav').hidden = true;
  $('main').replaceChildren(el('div', 'panel',
    `<h2>出错了</h2><p>${esc(msg)}</p><p>刷新页面重试；若反复出现请联系研究者。</p>`));
}

function showThanks() {
  $('nav').hidden = true;
  const p = el('div', 'panel');
  p.innerHTML = `<h2>已提交，谢谢</h2>
    <p>答案已全部保存。可以关闭页面了。</p>
    <p style="margin-top:16px"><button id="againGo">重新填一份</button></p>
    <p style="font-size:12.5px;color:var(--ink3)">
      会作为一份新的记录，不覆盖刚才提交的内容。</p>`;
  $('main').replaceChildren(p);
  $('againGo').addEventListener('click', () => {
    // 换一份全新记录：清掉本地 pid 和 URL 上的 ?p=，并让下一次 join 跳过按名字接续
    try { localStorage.removeItem('pid:' + S.survey); } catch (e) { /* 存不下也无妨 */ }
    const u = new URL(location.href);
    u.searchParams.delete('p');
    u.searchParams.delete('code');
    history.replaceState(null, '', u);
    S.fresh = true;
    S.code = null;
    S.answers = {};
    S.idx = 0;
    $('codePill').hidden = true;
    showJoin();
  });
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  setSave(PREVIEW ? 'preview' : 'saved', PREVIEW ? '预览模式' : '已连接');

  let bank;
  try {
    bank = await (await fetch('items.json', { cache: 'no-cache' })).json();
  } catch (e) { showFatal('题库载入失败：' + e.message); return; }
  S.items = bank.items;
  S.meta = bank.meta || {};

  // 问卷种类由链接决定（?s=judge / ?s=quality），身份由 p= 或 localStorage 决定。
  const q = new URL(location.href).searchParams;
  S.survey = q.get('s') || q.get('survey') || 'judge';
  if (!SURVEYS[S.survey]) S.survey = 'judge';
  // ?code= 是预先生成的邀请码，仍然支持；?p= 是自助登记拿到的参与者编号
  S.code = (q.get('p') || q.get('code') || recallPid(S.survey) || '').trim().toUpperCase();

  if (PREVIEW) {
    const prefix = S.survey === 'quality' ? 'B-' : 'A-';
    S.code = S.code || 'PREVIEW';
    S.order = S.items.filter(i => i.id.startsWith(prefix)).map(i => i.id);
    if (!S.order.length) S.order = S.items.map(i => i.id);
  } else {
    if (!S.code) { showJoin(); return; }
    let st;
    try { st = await apiGet({ action: 'state', code: S.code }); }
    catch (e) { showJoin('没找到这个参与者编号，或服务器暂时无法连接：' + e.message); return; }
    rememberPid(st.survey || S.survey, S.code);
    S.order = (st.item_ids && st.item_ids.length) ? st.item_ids : S.items.map(i => i.id);
    S.survey = st.survey || 'judge';
    S.surveyTitle = st.survey_title || '';
    S.answers = st.answers || {};
    S.finished = !!st.finished_ts;
    Outbox.restore();
  }

  showPid();
  const cfg = SURVEYS[S.survey] || SURVEYS.judge;
  document.querySelector('.bar .title').textContent = cfg.title;
  document.title = cfg.title + ' · 问卷';

  if (S.finished) { showThanks(); return; }
  // 续答落到第一道没答的题
  const first = S.order.findIndex(id => !answered(id));
  S.idx = first < 0 ? 0 : first;
  renderItem();
}

$('btnPrev').addEventListener('click', () => { if (S.idx > 0) { S.idx--; renderItem(); } });
$('btnNext').addEventListener('click', () => {
  if (S.idx < S.order.length - 1) { S.idx++; renderItem(); }
});
$('btnFinish').addEventListener('click', async () => {
  const missing = S.order.filter(id => !answered(id));
  if (missing.length && !confirm(`还有 ${missing.length} 题没作答，确定提交吗？`)) return;
  if (PREVIEW) { showThanks(); return; }
  await Outbox.flush();
  if (Outbox.pending.size) { alert('还有答案没保存成功，请检查网络后再试。'); return; }
  try { await apiPost({ action: 'finish', detail: { n_items: S.order.length } }); }
  catch (e) { alert('提交失败：' + e.message); return; }
  showThanks();
});

boot();
