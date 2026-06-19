import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchSite, normalizeUrl } from './fetchSite.js';
import { analyze } from './analyze.js';
import { assembleReport, score, starterFAQ, buildSchemas } from './score.js';
import type { Ans, Business, Report } from './types.js';
import { saveSnapshot, getHistory, computeDelta, listSites, saveSharedReport, getSharedReport, upsertMonitor, getMonitor, listMonitors, stopMonitor } from './store.js';
import { rescanDue, startScheduler } from './rescan.js';
import { runAudit, quickScore } from './audit.js';
import { buildShareCard, buildSharePage } from './share.js';
import { sendWebhook, sendEmail, isSafeWebhook, type AlertPayload } from './alerts.js';

// simple in-memory per-IP rate limit (G2)
const HITS = new Map<string, number[]>();
function rateLimited(ip: string, max = 30, windowMs = 60000): boolean {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now); HITS.set(ip, arr);
  return arr.length > max;
}
function clientIp(req: any): string { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown'; }

// Save a snapshot and attach trend (history + winning/losing verdict) to a report.
function withTrend(report: Report) {
  const signals: Record<string, number> = {};
  report.signals.forEach(s => { signals[s.id] = s.score; });
  if (report.mode === 'analyzed' && report.business.website) {
    saveSnapshot(report.business.name, report.business.website, report.score, report.band, signals);
  }
  const snaps = report.business.website ? getHistory(report.business.website) : [];
  return { ...report, history: snaps.map(s => ({ at: s.at, score: s.score })), delta: computeDelta(snaps) };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(resolve(__dirname, '../public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'auditrank-app' }));
app.get('/api/version', (_req, res) => res.json({ ok: true, name: 'auditrank-app', version: '1.3.0', features: ['ai-crawler-readiness', 'evidence-confidence', 'live-stream', 'fix-kit', 'monitoring', 'ssrf-guard', 'multi-page-crawl', 'page-type-framing', 'off-page-authority', 'benchmarks', 'competitor-comparison', 'prompt-intelligence', 'shareable-report', 'scheduled-rescan', 'drop-alerts'] }));

/** Run a full zero-key audit: fetch the site server-side, analyze, score, return report. */
app.post('/api/audit', async (req, res) => {
  try {
    if (rateLimited(clientIp(req))) return res.status(429).json({ ok: false, error: 'Too many audits, please wait a minute.' });
    const name = String(req.body?.name || '').trim();
    const website = String(req.body?.website || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Business name is required.' });
    const report = await runAudit({ name, website: website || undefined });
    if ((report as any).readError) {
      return res.json({ ...report, message: (report as any).message });
    }
    return res.json(report.mode === 'analyzed' ? withTrend(report) : report);
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: 'Audit failed: ' + (e?.message || 'unknown') });
  }
});

/** Live streaming audit (V1 theater) via Server-Sent Events. */
app.get('/api/audit/stream', async (req, res) => {
  if (rateLimited(clientIp(req))) { res.status(429).end(); return; }
  const name = String(req.query.name || '').trim();
  const website = String(req.query.website || '').trim();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (event: string, data: any) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    if (!name) { emit('error', { message: 'Business name is required.' }); return res.end(); }
    const report = await runAudit({ name, website: website || undefined }, emit);
    const final = (report as any).readError ? report : (report.mode === 'analyzed' ? withTrend(report) : report);
    emit('done', final);
  } catch (e: any) {
    emit('error', { message: 'Audit failed: ' + (e?.message || 'unknown') });
  } finally { res.end(); }
});

/** Analyze HTML pasted by the user (when their site blocks automated reads). */
app.post('/api/audit-html', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const website = String(req.body?.website || '').trim();
    const html = String(req.body?.html || '');
    if (!name) return res.status(400).json({ ok: false, error: 'Business name is required.' });
    if (html.length < 200) return res.status(400).json({ ok: false, error: 'Paste more of the page HTML.' });
    const detection = analyze(html, normalizeUrl(website || 'https://example.com'), null, null, null, 0);
    return res.json(withTrend(assembleReport({ name, website: website || undefined }, detection, 'analyzed', true)));
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: 'Analysis failed: ' + (e?.message || 'unknown') });
  }
});

/** Recompute score + fixes when the user refines the off-site signals (no re-fetch). */
app.post('/api/score', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const website = String(req.body?.website || '').trim();
    const answers = (req.body?.answers || {}) as Record<string, Ans>;
    const business: Business = { name, website: website || undefined };
    const out = score(business, answers, 'analyzed', true);
    const faq = starterFAQ(business);
    const { faqSchema, bizSchema } = buildSchemas(business, { what: '', city: '', country: '' }, faq);
    return res.json({ ok: true, ...out, faq, faqSchema, bizSchema });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'score failed' });
  }
});

/** Competitor comparison / share-of-voice (homepage-only, fair + fast). */
app.post('/api/compare', async (req, res) => {
  try {
    if (rateLimited(clientIp(req), 12)) return res.status(429).json({ ok: false, error: 'Too many comparisons, please wait a minute.' });
    const name = String(req.body?.name || 'You').trim();
    const website = String(req.body?.website || '').trim();
    if (!website) return res.status(400).json({ ok: false, error: 'Your website is required.' });
    const urls: string[] = Array.isArray(req.body?.competitors) ? req.body.competitors.map((u: any) => String(u).trim()).filter(Boolean).slice(0, 3) : [];
    const label = (u: string) => { try { return new URL(u.startsWith('http') ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch { return u; } };
    const you = await quickScore(name, website);
    const competitors = [];
    for (const u of urls) competitors.push(await quickScore(label(u), u));
    const ranked = [{ ...you, you: true }, ...competitors.map(c => ({ ...c, you: false }))].filter(x => x.ok).sort((a, b) => (b.score || 0) - (a.score || 0));
    return res.json({ ok: true, you, competitors, ranked });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: 'Comparison failed: ' + (e?.message || 'unknown') });
  }
});

/** Audit history for one site. */
app.get('/api/history', (req, res) => {
  const website = String(req.query.website || '');
  if (!website) return res.status(400).json({ ok: false, error: 'website required' });
  const snaps = getHistory(website);
  return res.json({ ok: true, website, history: snaps, delta: computeDelta(snaps) });
});

/** All tracked sites with latest score + last change (powers the dashboard). */
app.get('/api/sites', (_req, res) => res.json({ ok: true, sites: listSites() }));

/** Weekly re-scan trigger for Cloud Scheduler (Cloud Run sleeps, so the internal
 *  scheduler won't fire there). Protect with RESCAN_TOKEN if set. */
app.post('/api/cron/rescan', async (req, res) => {
  const token = process.env.RESCAN_TOKEN;
  if (token && req.get('x-rescan-token') !== token) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const out = await rescanDue();
  return res.json({ ok: true, ...out });
});

/** Minimal tracked-sites dashboard (no accounts). */
function reqOrigin(req: any): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Create a shareable link for a completed report. */
app.post('/api/share', (req, res) => {
  try {
    const report = req.body?.report;
    if (!report || typeof report.score !== 'number') return res.status(400).json({ ok: false, error: 'A completed report is required.' });
    const id = saveSharedReport(report);
    return res.json({ ok: true, id, url: `${reqOrigin(req)}/r/${id}` });
  } catch { return res.status(500).json({ ok: false, error: 'Could not create share link.' }); }
});

app.get('/api/shared/:id', (req, res) => {
  const r = getSharedReport(req.params.id);
  if (!r) return res.status(404).json({ ok: false, error: 'not found' });
  return res.json({ ok: true, report: r });
});

/** Branded SVG social card (zero-dependency). */
app.get('/r/:id/card.svg', (req, res) => {
  const r = getSharedReport(req.params.id);
  if (!r) return res.status(404).send('not found');
  res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=86400');
  return res.send(buildShareCard(r));
});

/** PNG version for OG unfurl. Uses @resvg/resvg-js if present, else falls back to SVG. */
app.get('/r/:id/card.png', async (req, res) => {
  const r = getSharedReport(req.params.id);
  if (!r) return res.status(404).send('not found');
  const svg = buildShareCard(r);
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=86400');
    return res.send(png);
  } catch {
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
    return res.send(svg);
  }
});

/** Public, crawlable report page. */
app.get('/r/:id', (req, res) => {
  const r = getSharedReport(req.params.id);
  if (!r) return res.status(404).type('html').send('<h1 style="font-family:sans-serif;padding:40px">Report not found</h1><p style="font-family:sans-serif;padding:0 40px">This share link has expired or never existed.</p>');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(buildSharePage(req.params.id, r, reqOrigin(req)));
});

/** Subscribe a site to scheduled re-scans + drop alerts. */
app.post('/api/monitor', (req, res) => {
  try {
    const website = String(req.body?.website || '').trim();
    if (!website) return res.status(400).json({ ok: false, error: 'website required' });
    const cadence = ['daily', 'weekly', 'monthly'].includes(req.body?.cadence) ? req.body.cadence : 'weekly';
    const webhook = req.body?.webhook ? String(req.body.webhook).trim() : undefined;
    const email = req.body?.email ? String(req.body.email).trim() : undefined;
    if (webhook && !isSafeWebhook(webhook)) return res.status(400).json({ ok: false, error: 'That webhook URL is not allowed (must be a public http/https endpoint).' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'That email address looks invalid.' });
    if (!webhook && !email && !process.env.ALERT_WEBHOOK) return res.status(400).json({ ok: false, error: 'Add a webhook URL or email so we have somewhere to send alerts.' });
    const m = upsertMonitor({ website, name: String(req.body?.name || '').trim() || undefined, cadence, webhook, email });
    return res.json({ ok: true, monitor: { website: m.website, name: m.name, cadence: m.cadence, hasWebhook: !!m.webhook, hasEmail: !!m.email, enabled: m.enabled } });
  } catch { return res.status(500).json({ ok: false, error: 'Could not save monitor.' }); }
});

app.post('/api/monitor/stop', (req, res) => {
  const ok = stopMonitor(String(req.body?.website || ''));
  return res.json({ ok });
});

function maskWebhook(u?: string): string | null { if (!u) return null; try { return new URL(u).host; } catch { return 'set'; } }
function maskEmail(e?: string): string | null { if (!e) return null; return e.replace(/^(.).*(@.*)$/, '$1***$2'); }

app.get('/api/monitors', (_req, res) => {
  const list = listMonitors().map(m => ({ website: m.website, name: m.name, cadence: m.cadence, enabled: m.enabled, webhook: maskWebhook(m.webhook), email: maskEmail(m.email), lastRunAt: m.lastRunAt || null, lastAlertAt: m.lastAlertAt || null }));
  return res.json({ ok: true, monitors: list });
});

/** Send a sample alert now so the user can confirm delivery. */
app.post('/api/monitor/test', async (req, res) => {
  try {
    const website = String(req.body?.website || '').trim();
    const existing = website ? getMonitor(website) : null;
    const webhook = (req.body?.webhook ? String(req.body.webhook).trim() : '') || existing?.webhook || process.env.ALERT_WEBHOOK || '';
    const email = (req.body?.email ? String(req.body.email).trim() : '') || existing?.email || '';
    if (!webhook && !email) return res.status(400).json({ ok: false, error: 'Add a webhook or email to test.' });
    const hist = website ? getHistory(website) : [];
    const score = hist.length ? hist[hist.length - 1].score : 50;
    const payload: AlertPayload = { website: website || 'example.com', name: existing?.name || 'Your site', score, prevScore: score + 6, delta: -6, kind: 'drop', band: hist.length ? hist[hist.length - 1].band : 'Emerging', at: new Date().toISOString() };
    const channels: string[] = [];
    if (webhook && await sendWebhook(webhook, payload)) channels.push('webhook');
    if (email && await sendEmail(email, payload)) channels.push('email');
    return res.json({ ok: channels.length > 0, channels, note: channels.length ? undefined : 'Nothing delivered. Check the webhook URL, or note that email needs SMTP env vars on the server.' });
  } catch { return res.status(500).json({ ok: false, error: 'Test failed.' }); }
});

app.get('/dashboard', (_req, res) => res.sendFile(resolve(__dirname, '../public/dashboard.html')));

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => { console.log(`\n  AuditRank app running -> http://localhost:${PORT}\n`); startScheduler(); });
