/* AuditRank web app - talks to the server API; no analysis happens in the browser. */
const SIGNALS = [
  { id: 'faq', name: 'FAQ / answer-shaped content', w: 14 },
  { id: 'schema', name: 'Structured data (schema)', w: 13 },
  { id: 'facts', name: 'Citable facts & statistics', w: 12 },
  { id: 'mentions', name: 'Earned mentions & reviews', w: 12 },
  { id: 'fresh', name: 'Content freshness', w: 11 },
  { id: 'identity', name: 'Identity & trust (E-E-A-T)', w: 11 },
  { id: 'convo', name: 'Conversational content', w: 10 },
  { id: 'gbp', name: 'Google Business Profile', w: 9 },
  { id: 'tech', name: 'Technical health', w: 8 },
];
const QMAP = {
  faq: "Do you directly answer your customers' real buying questions (an FAQ / Q&A page)?",
  schema: "Is schema markup (FAQ, LocalBusiness, Organization) on your site?",
  facts: "Does your content include specific numbers, prices and facts (not vague claims)?",
  mentions: "Is your business mentioned on other sites - directories, reviews, press, forums?",
  fresh: "Is your key content updated regularly with a visible \u201clast updated\u201d date?",
  identity: "Is it clear who you are - real name, About page, contact details?",
  convo: "Is your content written the way people actually ask - full questions, plain answers?",
  gbp: "Is your Google Business Profile complete, accurate and active?",
  tech: "Is your site fast, mobile-friendly and easy for crawlers to read?",
};

const state = { name: '', site: '', report: null, answers: {}, unverified: [], mode: 'self' };
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function show(id) {
  ['p_intake', 'p_loading', 'p_theater', 'p_readfail', 'p_audit', 'p_results'].forEach(p => $(p).classList.toggle('show', p === id));
  const map = { p_intake: 0, p_audit: 1, p_results: 2 };
  if (id in map) setStep(map[id]);
}
function setStep(i) {
  document.querySelectorAll('.stepper .s').forEach((el, k) => { el.classList.toggle('active', k === i); el.classList.toggle('done', k < i); });
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3200); }

function start() {
  $('stepper').style.display = 'flex';
  show('p_intake');
  $('p_intake').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let loadTimer = null;
function showLoading(title, msgs) {
  $('loadTitle').textContent = title; show('p_loading');
  let i = 0; $('loadMsg').textContent = msgs[0];
  clearInterval(loadTimer);
  loadTimer = setInterval(() => { i = (i + 1) % msgs.length; $('loadMsg').style.opacity = 0; setTimeout(() => { $('loadMsg').textContent = msgs[i]; $('loadMsg').style.opacity = 1; }, 200); }, 1400);
}
function stopLoading() { clearInterval(loadTimer); }

function runAudit() {
  const name = $('f_name').value.trim();
  const site = $('f_site').value.trim();
  if (!name) { toast('Add your business name first.'); return; }
  state.name = name; state.site = site; state.report = null; state._deepReport = null;
  if (!site) return goSelfAssess();

  startTheater(site);
  var url = '/api/audit/stream?name=' + encodeURIComponent(name) + '&website=' + encodeURIComponent(site);
  var es = new EventSource(url);
  state._es = es;
  es.addEventListener('log', function (e) { theaterLog(JSON.parse(e.data)); });
  es.addEventListener('finding', function (e) { theaterFinding(JSON.parse(e.data)); });
  es.addEventListener('done', function (e) {
    es.close();
    var data = JSON.parse(e.data);
    if (data.readError) { toast(data.message || "We couldn't read that site."); show('p_readfail'); return; }
    setTimeout(function () { applyReport(data); }, 550);
  });
  es.addEventListener('error', function (e) {
    es.close();
    if (e && e.data) { try { var d = JSON.parse(e.data); toast(d.message || 'Audit failed.'); show('p_readfail'); return; } catch (x) {} }
    if (!state.report) fallbackAudit(name, site); // connection dropped -> direct request
  });
}

// resilient fallback if SSE is blocked (some proxies buffer event-streams)
function fallbackAudit(name, site) {
  showLoading('Reading your site…', ['Reading your pages…', 'Checking signals…', 'Scoring…']);
  fetch('/api/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name, website: site }) })
    .then(function (r) { return r.json(); })
    .then(function (data) { stopLoading(); if (data.readError) { show('p_readfail'); return; } if (!data.ok) { toast(data.error || 'Audit failed.'); show('p_intake'); return; } applyReport(data); })
    .catch(function () { stopLoading(); toast('Network error - is the server running?'); show('p_intake'); });
}

/* ---- live audit theater ---- */
function startTheater(site) {
  $('theaterTitle').textContent = 'Auditing ' + site.replace(/^https?:\/\//, '') + '…';
  $('theaterSteps').innerHTML = '';
  $('theaterFind').style.display = 'none'; $('theaterFindHead').style.display = 'none';
  $('theaterFind').querySelector('ul').innerHTML = '';
  if ($('stepper').style.display === 'none') $('stepper').style.display = 'flex';
  show('p_theater');
  $('p_theater').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function theaterLog(d) {
  var id = 'st_' + d.key;
  var row = document.getElementById(id);
  if (!row) {
    row = document.createElement('div');
    row.className = 'tstep'; row.id = id;
    row.innerHTML = '<span class="tmark"></span><span class="tlabel"></span>';
    $('theaterSteps').appendChild(row);
  }
  row.querySelector('.tlabel').textContent = d.label;
  row.className = 'tstep ' + (d.state || 'run');
}
function theaterFinding(f) {
  $('theaterFindHead').style.display = 'flex';
  $('theaterFind').style.display = 'block';
  var ul = $('theaterFind').querySelector('ul');
  var li = document.createElement('li');
  li.className = f.c + ' reveal';
  li.innerHTML = '<span class="mk">' + (f.c === 'ok' ? '✓' : f.c === 'no' ? '✕' : '•') + '</span><span>' + esc(f.t) + '</span>';
  ul.appendChild(li);
}

async function analysePasted() {
  const html = ($('f_html').value || '').trim();
  if (html.length < 200) { toast('Paste a bit more of your page source first.'); return; }
  showLoading('Analysing your page…', ['Parsing your HTML…', 'Detecting schema & FAQs…', 'Scoring your signals…']);
  try {
    const r = await fetch('/api/audit-html', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: state.name, website: state.site, html }) });
    const data = await r.json(); stopLoading();
    if (!data.ok) { toast(data.error || 'Analysis failed.'); return; }
    applyReport(data);
  } catch (e) { stopLoading(); toast('Network error.'); }
}

function applyReport(data) {
  state.report = data; state.answers = data.answers || {}; state.unverified = data.unverified || []; state.mode = data.mode;
  renderResults(); show('p_results');
  $('p_results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---- self-assessment ---- */
function goSelfAssess() {
  state.mode = 'self';
  state.answers = {}; state.unverified = [];
  const list = $('auditList'); list.innerHTML = '';
  SIGNALS.forEach(s => {
    list.insertAdjacentHTML('beforeend', `<div class="aud" id="aud_${s.id}">
      <div class="q"><span class="wt">${s.w} pts</span><span>${esc(QMAP[s.id])}</span></div>
      <div class="opts">${['yes', 'partial', 'no'].map(v => `<button data-v="${v}" onclick="ans('${s.id}','${v}')">${v === 'yes' ? 'Yes' : v === 'partial' ? 'Partly' : 'No'}</button>`).join('')}</div>
    </div>`);
  });
  $('auditTitle').textContent = 'Self-assessment';
  $('auditLede').textContent = 'Answer honestly - this scores how AI sees you.';
  show('p_audit');
  $('p_audit').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function ans(id, v) {
  state.answers[id] = v;
  const row = $('aud_' + id); row.classList.add('answered');
  row.querySelectorAll('.opts button').forEach(b => b.classList.toggle('sel', b.dataset.v === v));
}
async function seeScore() {
  SIGNALS.forEach(s => { if (!state.answers[s.id]) state.answers[s.id] = 'no'; });
  const data = await postScore();
  if (!data) return;
  state.report = { ...data, business: { name: state.name, website: state.site }, mode: 'self', findings: [] };
  renderResults(); show('p_results'); $('p_results').scrollIntoView({ behavior: 'smooth' });
}

async function postScore() {
  try {
    const r = await fetch('/api/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: state.name, website: state.site, answers: state.answers }) });
    const d = await r.json(); if (!d.ok) { toast('Scoring failed.'); return null; } return d;
  } catch (e) { toast('Network error.'); return null; }
}
async function refine(id, v) {
  state.answers[id] = v;
  const data = await postScore(); if (!data) return;
  state.report = { ...state.report, score: data.score, band: data.band, headline: data.headline, summary: data.summary, signals: data.signals, fixes: data.fixes };
  renderResults();
}

function renderAi(r) {
  const el = $('aiWrap'); if (!el) return;
  var ai = r.aiAccess;
  if (r.mode !== 'analyzed' || !ai || !ai.bots) { el.innerHTML = ''; return; }
  var chips = ai.bots.map(function (b) {
    return '<span class="botchip ' + (b.allowed ? 'on' : 'off') + '">' + (b.allowed ? '✓' : '✕') + ' ' + esc(b.name) + '</span>';
  }).join('');
  var ok = ai.majorBlocked === 0;
  var head = ok ? 'All major AI crawlers can read your site' : ai.majorBlocked + ' major AI crawler' + (ai.majorBlocked > 1 ? 's are' : ' is') + ' blocked';
  el.innerHTML = '<div class="sub-h">AI crawler access <span class="conf-overall">the gate to AI visibility</span></div>' +
    '<div class="aicard ' + (ok ? 'ok' : 'bad') + '">' +
    '<div class="aihead"><span class="aiverdict">' + (ok ? '✓ ' : '✕ ') + esc(head) + '</span>' +
    '<span class="llms ' + (ai.llmsTxt ? 'on' : 'off') + '">llms.txt ' + (ai.llmsTxt ? 'found' : 'not found') + '</span></div>' +
    '<div class="bots">' + chips + '</div>' +
    '<div class="aifoot">If a crawler is blocked in robots.txt, that engine cannot read or recommend you. This is checked directly from your robots.txt.</div></div>';
}

function renderScan(r) {
  var el = $('scanWrap'); if (!el) return;
  if (r.mode !== 'analyzed' || !r.scan) { el.innerHTML = ''; return; }
  var sc = r.scan;
  var path = function (u) { try { var x = new URL(u); return (x.pathname === '/' || !x.pathname) ? '/' : x.pathname; } catch (e) { return u; } };
  var pagesRow = sc.pages.length > 1
    ? '<div class="scan-pages">' + sc.pages.map(function (p) {
        var rep = p.url === sc.representative;
        return '<span class="scan-pg' + (rep ? ' rep' : '') + '">' + esc(path(p.url)) + ' <b>' + p.score + '</b></span>';
      }).join('') + '</div>'
    : '';
  var note = sc.note ? '<div class="scan-note">' + esc(sc.note) + '</div>' : '';
  var bench = '';
  if (r.benchmark) {
    var bm = r.benchmark, vmap = { below: ['below', 'lose'], within: ['within', 'hold'], above: ['above', 'win'] };
    var vv = vmap[bm.verdict] || vmap.within;
    bench = '<div class="scan-bench ' + vv[1] + '">Typical for a <b>' + esc(bm.pageType) + '</b> page is <b>' + bm.low + '-' + bm.high + '</b>. You are <b>' + vv[0] + '</b> the typical range.</div>';
  }
  el.innerHTML = '<div class="scancard">' +
    '<div class="scan-cap">AI-citability readiness <span class="scan-sub">how ready your pages are to be cited by AI, not your site\'s size or fame</span></div>' +
    '<div class="scan-line">Scanned <b>' + sc.pages.length + ' page' + (sc.pages.length > 1 ? 's' : '') + '</b>, scored on your strongest: <b>' + esc(path(sc.representative)) + '</b></div>' +
    pagesRow + bench + note + '</div>';
}

function renderAuthority(r) {
  var el = $('authWrap'); if (!el) return;
  var a = r.authority;
  if (r.mode !== 'analyzed' || !a) { el.innerHTML = ''; return; }
  if (a.tier === 'unknown' && !a.entity.found) { el.innerHTML = ''; return; } // nothing useful to show offline
  var tierLabel = { high: 'Strong', medium: 'Moderate', low: 'Limited', unknown: 'Unknown' }[a.tier] || a.tier;
  var rows = (a.findings || []).map(function (f) {
    var chip = f.status ? '<span class="evchip ' + esc(f.status) + '">' + esc(f.status) + (f.conf ? ' · ' + esc(f.conf) : '') + '</span>' : '';
    var ev = f.ev ? '<div class="evidence">' + esc(f.ev) + '</div>' : '';
    return '<li class="' + f.c + '"><span class="mk">' + (f.c === 'ok' ? '✓' : f.c === 'no' ? '✕' : '•') + '</span><span class="ftext">' + esc(f.t) + ' ' + chip + ev + '</span></li>';
  }).join('');
  el.innerHTML = '<div class="sub-h">Off-page authority <span class="conf-overall">real-world recognition</span></div>' +
    '<div class="aicard ' + (a.entity.found ? 'ok' : '') + '"><div class="aihead"><span class="aiverdict">Authority signal: ' + esc(tierLabel) + '</span></div>' +
    '<ul class="ar-find2">' + rows + '</ul>' +
    '<div class="aifoot">A recognized knowledge-graph entity counts toward earned recognition. These are free, public signals, not paid data.</div></div>';
}

function renderCompare(r) {
  var el = $('compareWrap'); if (!el) return;
  if (r.mode !== 'analyzed' || !state.site) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="sub-h">How you stack up <span class="conf-overall">share of AI-readiness</span></div>' +
    '<div class="cmpcard">' +
    '<p class="cmp-lede">Add up to three competitor sites. We score each homepage the same way, so you can see who AI is most ready to recommend.</p>' +
    '<div class="cmp-in"><input type="text" id="cmpUrls" placeholder="competitor1.com, competitor2.com"><button class="btn btn-primary cmp-go" id="cmpGo">Compare</button></div>' +
    '<div id="cmpResult"></div></div>';
  var go = $('cmpGo');
  if (go) go.addEventListener('click', runCompare);
}
function runCompare() {
  var raw = ($('cmpUrls').value || '').trim();
  var comps = raw.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 3);
  if (!comps.length) { toast('Add at least one competitor URL.'); return; }
  var go = $('cmpGo'); go.disabled = true; go.textContent = 'Scoring…';
  $('cmpResult').innerHTML = '<p class="cmp-wait">Scoring ' + (comps.length + 1) + ' homepages…</p>';
  fetch('/api/compare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: state.name || 'You', website: state.site, competitors: comps }) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      go.disabled = false; go.textContent = 'Compare';
      if (!j.ok || !j.ranked || !j.ranked.length) { $('cmpResult').innerHTML = '<p class="cmp-wait">Could not score those sites. Check the URLs and try again.</p>'; return; }
      var max = Math.max.apply(null, j.ranked.map(function (x) { return x.score || 0; }).concat([1]));
      var rows = j.ranked.map(function (x, i) {
        var col = x.you ? 'var(--amber)' : (x.score >= 60 ? 'var(--ok)' : x.score >= 35 ? 'var(--warn)' : 'var(--bad)');
        var nm = x.you ? (x.name + ' (you)') : x.name;
        return '<div class="cmp-row' + (x.you ? ' me' : '') + '"><div class="cmp-rank">' + (i + 1) + '</div>' +
          '<div class="cmp-bar"><div class="cmp-lab"><span>' + esc(nm) + '</span><span class="cmp-sc">' + x.score + '<small>/100</small></span></div>' +
          '<div class="track"><i style="width:' + Math.round((x.score / max) * 100) + '%;background:' + col + '"></i></div></div></div>';
      }).join('');
      var failed = (j.competitors || []).filter(function (c) { return !c.ok; });
      var note = failed.length ? '<p class="cmp-wait">Could not read: ' + failed.map(function (c) { return esc(c.name); }).join(', ') + '</p>' : '';
      $('cmpResult').innerHTML = '<div class="cmp-rows">' + rows + '</div>' + note;
    })
    .catch(function () { go.disabled = false; go.textContent = 'Compare'; $('cmpResult').innerHTML = '<p class="cmp-wait">Network error.</p>'; });
}

function renderPrompts(r) {
  var el = $('promptsWrap'); if (!el) return;
  if (r.mode !== 'analyzed' || !r.prompts || !r.prompts.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="sub-h">Prompts to test yourself <span class="conf-overall">paste into ChatGPT or Perplexity</span></div>' +
    '<div class="kit"><p class="kit-lede">Ask these in an AI assistant and see whether it names you. This is the real-world check our paid engine automates.</p>' +
    '<div class="prompts">' + r.prompts.map(function (p) {
      return '<div class="prompt-row"><span>' + esc(p) + '</span><button class="kitbtn" onclick="copyPrompt(this)" data-p="' + esc(p) + '">Copy</button></div>';
    }).join('') + '</div></div>';
}
window.copyPrompt = function (btn) {
  var t = btn.getAttribute('data-p') || '';
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); });
  toast('Prompt copied.');
};

function renderTrend(r) {
  const tw = $('trendWrap'); if (!tw) return;
  const d = r.delta, hist = r.history || [];
  if (r.mode !== 'analyzed' || !d) { tw.innerHTML = ''; return; }
  const fmt = iso => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; } };
  if (d.verdict === 'First audit') {
    tw.innerHTML = `<div class="trend first"><span class="ti">◷</span><div><b>First audit saved.</b> We'll re-check this site every week so you can see whether you're winning or losing over time. Come back, or re-run anytime.</div></div>`;
    return;
  }
  const up = d.score > 0, flat = d.score === 0;
  const cls = d.verdict === 'Winning' ? 'win' : d.verdict === 'Slipping' ? 'lose' : 'hold';
  const arrow = up ? '▲' : flat ? '▬' : '▼';
  const sign = d.score > 0 ? '+' : '';
  const moverNames = (d.movers || []).map(m => { const s = SIGNALS.find(x => x.id === m.id); return s ? `${s.name} ${m.change > 0 ? '+' : ''}${m.change}` : ''; }).filter(Boolean);
  tw.innerHTML = `<div class="sub-h">Visibility over time</div>
    <div class="trend ${cls}">
      <div class="trend-head">
        <span class="verdict">${arrow} ${esc(d.verdict)}</span>
        <span class="vdelta">${sign}${d.score} pts since ${fmt(d.since)}</span>
      </div>
      <div class="spark">${sparkline(hist)}</div>
      ${moverNames.length ? `<div class="movers">Biggest movers: ${esc(moverNames.join(' · '))}</div>` : ''}
      <div class="trend-foot">${hist.length} audit${hist.length > 1 ? 's' : ''} on record · re-checked weekly</div>
    </div>`;
}
function sparkline(hist) {
  if (!hist || hist.length < 2) return '';
  const w = 320, h = 54, pad = 6;
  const xs = hist.map((_, i) => pad + i * (w - pad * 2) / (hist.length - 1));
  const ys = hist.map(p => h - pad - (Math.max(0, Math.min(100, p.score)) / 100) * (h - pad * 2));
  const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const last = hist[hist.length - 1].score, first = hist[0].score;
  const col = last >= first ? 'var(--ok)' : 'var(--bad)';
  const dots = xs.map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="2.5" fill="${col}"/>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

/* ---- render ---- */
window.shareReport = function (btn) {
  if (!state.report || typeof state.report.score !== 'number') { toast('Run an audit first.'); return; }
  btn.disabled = true; var orig = btn.textContent; btn.textContent = 'Creating link…';
  fetch('/api/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report: state.report }) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      btn.disabled = false; btn.textContent = orig;
      if (!j.ok || !j.url) { toast('Could not create link.'); return; }
      var w = $('shareWrap');
      w.innerHTML = '<div class="sharebox"><div class="sharebox-h">Your shareable report is live</div>' +
        '<div class="share-row"><input id="shareUrl" readonly value="' + esc(j.url) + '"><button class="btn btn-primary" onclick="copyShare()">Copy</button>' +
        '<a class="btn btn-ghost" href="' + esc(j.url) + '" target="_blank" rel="noopener">Open</a></div>' +
        '<p class="share-note">Anyone with this link can view the score, band and top fixes. Pasting it into Slack, X or LinkedIn shows a preview card.</p></div>';
      w.scrollIntoView({ behavior: 'smooth', block: 'center' });
    })
    .catch(function () { btn.disabled = false; btn.textContent = orig; toast('Network error.'); });
};
window.copyShare = function () {
  var i = $('shareUrl'); if (!i) return;
  if (navigator.clipboard) navigator.clipboard.writeText(i.value);
  else { i.select(); try { document.execCommand('copy'); } catch (e) {} }
  toast('Link copied.');
};

function renderWatch(r) {
  var el = $('watchWrap'); if (!el) return;
  if (r.mode !== 'analyzed' || !state.site) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="sub-h">Keep watch <span class="conf-overall">get alerted if your score drops</span></div>' +
    '<div class="watchcard">' +
    '<p class="cmp-lede">We re-audit this site on a schedule and message you if the score slips. Webhook works with Slack, Discord, Pabbly or Zapier; email needs SMTP set on your server.</p>' +
    '<div class="watch-grid">' +
    '<label>Re-scan<select id="wCad"><option value="daily">Daily</option><option value="weekly" selected>Weekly</option><option value="monthly">Monthly</option></select></label>' +
    '<label>Webhook URL<input id="wHook" type="text" placeholder="https://hooks.slack.com/..."></label>' +
    '<label>Email<input id="wMail" type="email" placeholder="you@example.com"></label>' +
    '</div>' +
    '<div class="watch-btns"><button class="btn btn-primary" id="wSub" onclick="subscribeWatch()">Start watching</button>' +
    '<button class="btn btn-ghost" id="wTest" onclick="testWatch()">Send test alert</button></div>' +
    '<div id="wMsg" class="watch-msg"></div></div>';
}
function watchPayload() {
  return { website: state.site, name: state.name || undefined, cadence: ($('wCad') || {}).value || 'weekly', webhook: ($('wHook') || {}).value || '', email: ($('wMail') || {}).value || '' };
}
window.subscribeWatch = function () {
  var b = $('wSub'); b.disabled = true; var o = b.textContent; b.textContent = 'Saving…';
  fetch('/api/monitor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(watchPayload()) })
    .then(function (r) { return r.json(); }).then(function (j) {
      b.disabled = false; b.textContent = o;
      var m = $('wMsg');
      if (!j.ok) { m.className = 'watch-msg err'; m.textContent = j.error || 'Could not start watching.'; return; }
      m.className = 'watch-msg ok'; m.textContent = 'Watching ' + j.monitor.cadence + '. We will alert ' + [j.monitor.hasWebhook ? 'your webhook' : '', j.monitor.hasEmail ? 'your email' : ''].filter(Boolean).join(' and ') + ' if the score drops.';
    }).catch(function () { b.disabled = false; b.textContent = o; $('wMsg').className = 'watch-msg err'; $('wMsg').textContent = 'Network error.'; });
};
window.testWatch = function () {
  var b = $('wTest'); b.disabled = true; var o = b.textContent; b.textContent = 'Sending…';
  fetch('/api/monitor/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(watchPayload()) })
    .then(function (r) { return r.json(); }).then(function (j) {
      b.disabled = false; b.textContent = o; var m = $('wMsg');
      if (j.ok) { m.className = 'watch-msg ok'; m.textContent = 'Test alert sent via ' + j.channels.join(' and ') + '. Check it arrived.'; }
      else { m.className = 'watch-msg err'; m.textContent = j.note || j.error || 'Nothing delivered.'; }
    }).catch(function () { b.disabled = false; b.textContent = o; $('wMsg').className = 'watch-msg err'; $('wMsg').textContent = 'Network error.'; });
};

function dcol(s) { return s >= 80 ? 'var(--ok)' : s >= 60 ? '#2E7D32' : s >= 35 ? 'var(--amber-deep)' : 'var(--bad)'; }
function renderDeep(r) {
  var el = $('deepWrap'); if (!el) return;
  if (r.mode !== 'analyzed' || !state.site) { el.innerHTML = ''; return; }
  if (state._deepReport) { renderDeepDashboard(state._deepReport); return; }
  el.innerHTML = '<div class="deepcta"><div class="deepcta-txt"><div class="deepcta-h">Go deeper: full site research report</div>' +
    '<p>Crawl up to 16 pages for a console-style technical, SEO and AI-readiness report, with every issue and a prioritized fix list.</p></div>' +
    '<button class="btn btn-signal" id="deepGo" onclick="runDeep()">Run deep research &rarr;</button></div>';
}
window.runDeep = function () {
  var el = $('deepWrap');
  el.innerHTML = '<div class="deeploading"><div class="dspin"></div><div><b>Deep research running</b><br><span id="deepStat" class="deepstat">crawling your pages…</span></div></div>';
  try {
    var es = new EventSource('/api/deep/stream?website=' + encodeURIComponent(state.site) + '&name=' + encodeURIComponent(state.name || ''));
    es.addEventListener('log', function (e) { try { var d = JSON.parse(e.data); var s = $('deepStat'); if (s && d.label) s.textContent = d.label; } catch (x) {} });
    es.addEventListener('done', function (e) { es.close(); try { var d = JSON.parse(e.data); if (!d.ok) { el.innerHTML = '<div class="deeperr">' + esc(d.note || 'Could not read that site.') + '</div>'; return; } state._deepReport = d; renderDeepDashboard(d); } catch (x) { fallbackDeep(); } });
    es.addEventListener('error', function () { es.close(); if (!state._deepReport) fallbackDeep(); });
  } catch (x) { fallbackDeep(); }
};
function fallbackDeep() {
  var el = $('deepWrap');
  fetch('/api/deep', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ website: state.site, name: state.name || '' }) })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (!d.ok) { el.innerHTML = '<div class="deeperr">' + esc(d.note || d.error || 'Deep research failed.') + '</div>'; return; } state._deepReport = d; renderDeepDashboard(d); })
    .catch(function () { el.innerHTML = '<div class="deeperr">Network error during deep research.</div>'; });
}
function renderDeepDashboard(d) {
  var el = $('deepWrap'); if (!el) return;
  var path = function (u) { try { var x = new URL(u); return x.pathname || '/'; } catch (e) { return u; } };
  var cats = [['Technical', d.categories.technical], ['Indexability', d.categories.indexability], ['Content', d.categories.content], ['AI-readiness', d.categories.ai]];
  var catRows = cats.map(function (c) {
    return '<div class="deep-cat"><span class="deep-cat-l">' + c[0] + '</span><div class="deep-cat-bar"><i style="width:' + c[1] + '%;background:' + dcol(c[1]) + '"></i></div><span class="deep-cat-s" style="color:' + dcol(c[1]) + '">' + c[1] + '</span></div>';
  }).join('');
  var sd = d.crawl.statusDist || {};
  var tiles = [
    ['Pages crawled', d.pagesCrawled], ['Indexable', d.index.indexable + '/' + d.pagesCrawled],
    ['Avg load', d.crawl.avgFetchMs + ' ms'], ['Avg weight', d.crawl.avgKb + ' KB'],
    ['Schema pages', d.schema.pagesWith], ['Alt coverage', d.media.altPct + '%'],
    ['Avg words', d.seo.avgWords], ['Internal links/pg', d.links.avgInternal]
  ];
  var tileHtml = tiles.map(function (t) { return '<div class="deep-tile"><div class="deep-tile-n">' + esc(String(t[1])) + '</div><div class="deep-tile-l">' + t[0] + '</div></div>'; }).join('');
  var statusHtml = ['2xx', '3xx', '4xx', '5xx', 'err'].filter(function (k) { return sd[k]; }).map(function (k) {
    var bad = k === '4xx' || k === '5xx' || k === 'err';
    return '<span class="deep-stat-chip ' + (bad ? 'bad' : 'ok') + '">' + sd[k] + ' ' + k + '</span>';
  }).join('');
  var groups = [['critical', 'Critical', 'bad'], ['warning', 'Needs attention', 'warn'], ['good', 'Passing', 'ok']];
  var issuesHtml = groups.map(function (g) {
    var list = (d.issues || []).filter(function (i) { return i.severity === g[0]; });
    if (!list.length) return '';
    return '<div class="deep-igroup"><div class="deep-igroup-h ' + g[2] + '">' + g[1] + ' <b>' + list.length + '</b></div>' +
      list.map(function (i) { return '<div class="deep-issue ' + g[2] + '"><span class="deep-area">' + esc(i.area) + '</span><div><div class="deep-it">' + esc(i.title) + '</div><div class="deep-id">' + esc(i.detail) + '</div></div></div>'; }).join('') + '</div>';
  }).join('');
  var fixHtml = (d.fixes || []).map(function (f) {
    return '<div class="deep-fix"><span class="deep-fixn">' + f.priority + '</span><div><div class="deep-it">' + esc(f.title) + ' <span class="deep-area">' + esc(f.area) + '</span></div><div class="deep-id">' + esc(f.action) + '</div></div></div>';
  }).join('');
  el.innerHTML = '<div class="sub-h">Deep research report <span class="conf-overall">site-wide crawl of ' + d.pagesCrawled + ' pages</span></div>' +
    '<div class="deepdash">' +
    '<div class="deep-top"><div class="deep-overall"><div class="deep-ovnum" style="color:' + dcol(d.overall) + '">' + d.overall + '</div><div class="deep-ovl">overall<br>health</div></div><div class="deep-cats">' + catRows + '</div></div>' +
    '<div class="deep-status">' + statusHtml + '<span class="deep-status-meta">crawled ' + esc(path(d.aiAccess.headlinePage) === '/' ? d.website.replace(/^https?:\/\//, '') : 'site') + ' · strongest page for AI: <b>' + esc(path(d.aiAccess.headlinePage)) + '</b></span></div>' +
    '<div class="deep-grid">' + tileHtml + '</div>' +
    '<div class="deep-section"><h4>Issues found</h4>' + (issuesHtml || '<p class="deep-id">No issues detected.</p>') + '</div>' +
    (fixHtml ? '<div class="deep-section"><h4>Prioritized fixes</h4>' + fixHtml + '</div>' : '') +
    '<p class="deep-note">' + esc(d.note) + '</p>' +
    '</div>';
}

function renderResults() {
  const r = state.report, s = r.score;
  const colors = { Cited: ['#1FA971', '#E6F7EF'], Visible: ['#1FA971', '#E6F7EF'], Emerging: ['#E8920A', '#FDF2E2'], Invisible: ['#E5484D', '#FDECEC'] };
  const [c, bg] = colors[r.band] || colors.Emerging;

  if (r.mode === 'analyzed') { $('modeNotice').style.display = 'block'; $('modeNotice').innerHTML = `<b>Site analysed</b> - we read ${esc((r.business && r.business.website) || state.site).replace(/^https?:\/\//, '')} on our server and scored your on-page signals.`; }
  else $('modeNotice').style.display = 'none';

  $('bandTag').textContent = r.band; $('bandTag').style.background = bg; $('bandTag').style.color = c;
  $('bandTitle').textContent = r.headline; $('bandDesc').textContent = r.summary;
  $('genName').textContent = (r.business && r.business.name) || state.name || 'your site';

  // visibility over time (saved audits + weekly re-scan)
  renderScan(r);
  renderDeep(r);
  renderTrend(r);
  renderAi(r);
  renderAuthority(r);
  renderCompare(r);
  renderPrompts(r);
  renderWatch(r);

  // what we detected (with evidence + confidence)
  const fw = $('foundWrap');
  if (r.mode === 'analyzed' && r.findings && r.findings.length) {
    fw.innerHTML = '<div class="sub-h">What we detected on your site' + (r.confidence ? ' <span class="conf-overall">read confidence ' + Math.round(r.confidence * 100) + '%</span>' : '') + '</div><div class="research-card foundcard"><ul>' +
      r.findings.map(f => {
        const chip = f.status ? '<span class="evchip ' + esc(f.status) + '">' + esc(f.status) + (f.conf ? ' · ' + esc(f.conf) : '') + '</span>' : '';
        const ev = f.ev ? '<div class="evidence">' + esc(f.ev) + '</div>' : '';
        return `<li class="${f.c}"><span class="mk">${f.c === 'ok' ? '✓' : f.c === 'no' ? '✕' : '•'}</span><span class="ftext">${esc(f.t)} ${chip}${ev}</span></li>`;
      }).join('') + '</ul></div>';
  } else fw.innerHTML = '';

  // gauge
  const arc = $('gaugeArc'), circ = 2 * Math.PI * 78;
  arc.style.strokeDasharray = circ; arc.style.stroke = c;
  setTimeout(() => arc.style.strokeDashoffset = circ * (1 - s / 100), 120);
  let n = 0; const num = $('scoreNum'); clearInterval(window._ct);
  window._ct = setInterval(() => { n += Math.max(1, Math.round(s / 40)); if (n >= s) { n = s; clearInterval(window._ct); } num.textContent = n; }, 22);

  // bars
  const bars = $('bars'); bars.innerHTML = '';
  (r.signals || []).forEach(sig => {
    const max = sig.max || 10, got = Math.max(0, Math.min(max, sig.score || 0)), pct = Math.round(got / max * 100);
    const col = pct >= 100 ? 'var(--ok)' : pct >= 50 ? 'var(--warn)' : 'var(--bad)';
    bars.insertAdjacentHTML('beforeend', `<div class="barrow"><div class="lab"><span>${esc(sig.name)}</span><span class="pct">${got}/${max}</span></div><div class="track"><i style="width:0;background:${col}"></i></div>${sig.note ? `<div class="barnote">${esc(sig.note)}</div>` : ''}</div>`);
  });
  setTimeout(() => document.querySelectorAll('#bars .track i').forEach((el, k) => { const sig = (r.signals || [])[k]; if (sig) el.style.width = Math.min(100, (sig.score || 0) / (sig.max || 10) * 100) + '%'; }), 240);

  // refine
  const rw = $('refineWrap');
  if (r.mode === 'analyzed' && state.unverified && state.unverified.length) {
    const rows = state.unverified.map(id => {
      const sig = SIGNALS.find(x => x.id === id); const cur = state.answers[id];
      const mk = v => `<button class="${cur === v ? 'sel' : ''}" data-v="${v}" onclick="refine('${id}','${v}')">${v === 'yes' ? 'Yes' : v === 'partial' ? 'Partly' : 'No'}</button>`;
      return `<div class="rr"><span class="ql">${esc(sig.name)} <span style="color:var(--muted);font-weight:500">(+${sig.w} pts)</span></span><div class="opts">${mk('yes')}${mk('partial')}${mk('no')}</div></div>`;
    }).join('');
    rw.innerHTML = `<div class="refine"><div class="rt">Optional: add ${state.unverified.length} signal${state.unverified.length > 1 ? 's' : ''} we can't see from your page</div><div class="rs">These live off your website, so we left them out of the scan. Tap to include them - your score updates instantly.</div>${rows}</div>`;
  } else rw.innerHTML = '';

  // fix plan
  const rm = $('roadmap'); rm.innerHTML = '';
  (r.fixes || []).forEach((f, i) => {
    rm.insertAdjacentHTML('beforeend', `<div class="fix"><div class="rank">${i + 1}</div><div class="body"><h4>${esc(f.title)}</h4><p>${esc(f.why)}</p><div class="act"><b>Do this:</b> ${esc(f.action)}</div><span class="tag ${f.effort === 'Quick win' ? 'quick' : 'med'}">${esc(f.effort)}</span></div></div>`);
  });

  // generated content
  const gw = $('genWrap'); gw.innerHTML = '';
  const faqHtml = (r.faq || []).map(o => `<div class="qa"><div class="qq">${esc(o.q)}</div><div class="aa">${esc(o.a)}</div></div>`).join('');
  gw.insertAdjacentHTML('beforeend', card('FAQ answers - paste into your pages', faqHtml, (r.faq || []).map(o => `Q: ${o.q}\nA: ${o.a}`).join('\n\n'), true));
  gw.insertAdjacentHTML('beforeend', card('FAQ schema - paste into your &lt;head&gt;', `<pre>${esc(r.faqSchema)}</pre>`, r.faqSchema));
  gw.insertAdjacentHTML('beforeend', card('Business schema - tells AI who &amp; where you are', `<pre>${esc(r.bizSchema)}</pre>`, r.bizSchema));

  // fix kit downloads (A2)
  renderKit(r);
}

function dl(filename, text) {
  var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}
function renderKit(r) {
  var el = $('kitWrap'); if (!el) return;
  if (r.mode !== 'analyzed' || !r.kit) { el.innerHTML = ''; return; }
  window._kit = {
    faqSchema: r.faqSchema, bizSchema: r.bizSchema, llmsTxt: r.kit.llmsTxt, robots: r.kit.robotsSnippet,
    faqText: (r.faq || []).map(function (o) { return 'Q: ' + o.q + '\nA: ' + o.a; }).join('\n\n'),
  };
  el.innerHTML = '<div class="sub-h">Fix kit - download &amp; apply</div>' +
    '<div class="kit"><p class="kit-lede">Ready-to-use files. Drop the schema into your &lt;head&gt;, save llms.txt and the robots rules at your site root.</p>' +
    '<div class="kit-btns">' +
    kitBtn('FAQ schema', 'faq-schema.html', 'faqSchema') +
    kitBtn('Business schema', 'business-schema.html', 'bizSchema') +
    kitBtn('llms.txt', 'llms.txt', 'llmsTxt') +
    kitBtn('robots.txt (AI bots)', 'robots-ai.txt', 'robots') +
    kitBtn('FAQ answers', 'faq.txt', 'faqText') +
    '<button class="kitbtn all" onclick="dlAll()">⤓ Download all</button>' +
    '</div></div>';
}
function kitBtn(label, file, key) {
  return '<button class="kitbtn" onclick="dl(\'' + file + '\', window._kit.' + key + ')">⤓ ' + label + '</button>';
}
function dlAll() {
  var k = window._kit;
  var md = '# AuditRank fix kit\n\n## FAQ schema (paste into <head>)\n\n' + k.faqSchema + '\n\n## Business schema (paste into <head>)\n\n' + k.bizSchema +
    '\n\n## llms.txt (save at /llms.txt)\n\n' + k.llmsTxt + '\n\n## robots.txt AI rules (add to /robots.txt)\n\n' + k.robots + '\n\n## FAQ answers\n\n' + k.faqText + '\n';
  dl('auditrank-fix-kit.md', md);
}

function card(title, inner, copyText, isFaq) {
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  window['_copy_' + id] = copyText;
  return `<div class="gen-card"><div class="gen-head"><h4>${title}</h4><button class="copy" onclick="copyEl('${id}',this)">Copy ${isFaq ? 'text' : 'code'}</button></div><div class="${isFaq ? 'faqblock' : 'gen-body'}">${inner}</div></div>`;
}
function copyEl(id, btn) {
  navigator.clipboard.writeText(window['_copy_' + id] || '').then(() => { btn.textContent = 'Copied ✓'; btn.classList.add('done'); setTimeout(() => { btn.textContent = btn.textContent.replace('Copied ✓', 'Copy'); btn.classList.remove('done'); }, 1600); });
}
function resetAll() {
  state.report = null; state._deepReport = null; state.answers = {}; state.unverified = [];
  $('f_name').value = ''; $('f_site').value = ''; if ($('f_html')) $('f_html').value = '';
  show('p_intake'); window.scrollTo({ top: 0, behavior: 'smooth' });
}
