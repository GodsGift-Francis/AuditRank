/* AuditRank web app — talks to the server API; no analysis happens in the browser. */
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
  mentions: "Is your business mentioned on other sites — directories, reviews, press, forums?",
  fresh: "Is your key content updated regularly with a visible \u201clast updated\u201d date?",
  identity: "Is it clear who you are — real name, About page, contact details?",
  convo: "Is your content written the way people actually ask — full questions, plain answers?",
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
  state.name = name; state.site = site; state.report = null;
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
    .catch(function () { stopLoading(); toast('Network error — is the server running?'); show('p_intake'); });
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
  $('auditLede').textContent = 'Answer honestly — this scores how AI sees you.';
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
function renderResults() {
  const r = state.report, s = r.score;
  const colors = { Cited: ['#1FA971', '#E6F7EF'], Visible: ['#1FA971', '#E6F7EF'], Emerging: ['#E8920A', '#FDF2E2'], Invisible: ['#E5484D', '#FDECEC'] };
  const [c, bg] = colors[r.band] || colors.Emerging;

  if (r.mode === 'analyzed') { $('modeNotice').style.display = 'block'; $('modeNotice').innerHTML = `<b>Site analysed</b> — we read ${esc((r.business && r.business.website) || state.site).replace(/^https?:\/\//, '')} on our server and scored your on-page signals.`; }
  else $('modeNotice').style.display = 'none';

  $('bandTag').textContent = r.band; $('bandTag').style.background = bg; $('bandTag').style.color = c;
  $('bandTitle').textContent = r.headline; $('bandDesc').textContent = r.summary;
  $('genName').textContent = (r.business && r.business.name) || state.name || 'your site';

  // visibility over time (saved audits + weekly re-scan)
  renderScan(r);
  renderTrend(r);
  renderAi(r);
  renderAuthority(r);

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
    rw.innerHTML = `<div class="refine"><div class="rt">Optional: add ${state.unverified.length} signal${state.unverified.length > 1 ? 's' : ''} we can't see from your page</div><div class="rs">These live off your website, so we left them out of the scan. Tap to include them — your score updates instantly.</div>${rows}</div>`;
  } else rw.innerHTML = '';

  // fix plan
  const rm = $('roadmap'); rm.innerHTML = '';
  (r.fixes || []).forEach((f, i) => {
    rm.insertAdjacentHTML('beforeend', `<div class="fix"><div class="rank">${i + 1}</div><div class="body"><h4>${esc(f.title)}</h4><p>${esc(f.why)}</p><div class="act"><b>Do this:</b> ${esc(f.action)}</div><span class="tag ${f.effort === 'Quick win' ? 'quick' : 'med'}">${esc(f.effort)}</span></div></div>`);
  });

  // generated content
  const gw = $('genWrap'); gw.innerHTML = '';
  const faqHtml = (r.faq || []).map(o => `<div class="qa"><div class="qq">${esc(o.q)}</div><div class="aa">${esc(o.a)}</div></div>`).join('');
  gw.insertAdjacentHTML('beforeend', card('FAQ answers — paste into your pages', faqHtml, (r.faq || []).map(o => `Q: ${o.q}\nA: ${o.a}`).join('\n\n'), true));
  gw.insertAdjacentHTML('beforeend', card('FAQ schema — paste into your &lt;head&gt;', `<pre>${esc(r.faqSchema)}</pre>`, r.faqSchema));
  gw.insertAdjacentHTML('beforeend', card('Business schema — tells AI who &amp; where you are', `<pre>${esc(r.bizSchema)}</pre>`, r.bizSchema));

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
  el.innerHTML = '<div class="sub-h">Fix kit — download &amp; apply</div>' +
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
  state.report = null; state.answers = {}; state.unverified = [];
  $('f_name').value = ''; $('f_site').value = ''; if ($('f_html')) $('f_html').value = '';
  show('p_intake'); window.scrollTo({ top: 0, behavior: 'smooth' });
}
