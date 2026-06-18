import { fetchSite, normalizeUrl } from './fetchSite.js';
import { analyze } from './analyze.js';
import { assembleReport } from './score.js';
import { allSiteRecords, saveSnapshot, getHistory, computeDelta } from './store.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Fire an alert webhook (A1) when a re-scan moves the score meaningfully. */
async function alert(website: string, name: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK;
  if (!url) return;
  const d = computeDelta(getHistory(website));
  if (!d || d.verdict === 'First audit' || d.verdict === 'Holding') return;
  try {
    await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `AuditRank: ${name} is ${d.verdict} (${d.score > 0 ? '+' : ''}${d.score} pts) — ${website}`, website, name, verdict: d.verdict, delta: d.score }),
    });
  } catch { /* alerts are best-effort */ }
}

/** Re-audit one site server-side and store a fresh snapshot. */
export async function rescanSite(name: string, website: string): Promise<{ ok: boolean; score?: number }> {
  try {
    const { html, robotsTxt, sitemapXml, finalUrl } = await fetchSite(website);
    if (!html) return { ok: false };
    const detection = analyze(html, normalizeUrl(finalUrl), robotsTxt, sitemapXml);
    const r = assembleReport({ name, website }, detection, 'analyzed', true);
    const signals: Record<string, number> = {};
    r.signals.forEach(s => { signals[s.id] = s.score; });
    saveSnapshot(name, website, r.score, r.band, signals);
    await alert(website, name);
    return { ok: true, score: r.score };
  } catch { return { ok: false }; }
}

/** Re-scan every tracked site whose latest snapshot is older than a week. */
export async function rescanDue(): Promise<{ scanned: number; due: number }> {
  const recs = allSiteRecords();
  let scanned = 0, due = 0;
  for (const rec of recs) {
    const last = rec.snapshots[rec.snapshots.length - 1];
    if (!last || Date.now() - new Date(last.at).getTime() >= WEEK_MS) {
      due++;
      const res = await rescanSite(rec.name, rec.website);
      if (res.ok) scanned++;
    }
  }
  return { scanned, due };
}

/** Internal scheduler for always-on hosts (VPS, container that doesn't sleep).
 *  On Cloud Run (scales to zero) use POST /api/cron/rescan via Cloud Scheduler instead. */
export function startScheduler() {
  const everyHours = 6;
  setInterval(() => { rescanDue().then(r => { if (r.scanned) console.log(`  [scheduler] re-scanned ${r.scanned}/${r.due} due sites`); }).catch(() => {}); }, everyHours * 60 * 60 * 1000);
}

export { getHistory };
