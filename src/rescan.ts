import { fetchSite, normalizeUrl } from './fetchSite.js';
import { analyze } from './analyze.js';
import { assembleReport } from './score.js';
import { saveSnapshot, getHistory, listMonitors, markMonitorRun } from './store.js';
import { notify } from './alerts.js';

const CADENCE_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** Re-audit one site server-side and store a fresh snapshot (no alerting here). */
export async function rescanSite(name: string, website: string): Promise<{ ok: boolean; score?: number }> {
  try {
    const { html, robotsTxt, sitemapXml, llmsTxt, finalUrl, fetchMs } = await fetchSite(website);
    if (!html) return { ok: false };
    const detection = analyze(html, normalizeUrl(finalUrl), robotsTxt, sitemapXml, llmsTxt, fetchMs);
    const r = assembleReport({ name, website }, detection, 'analyzed', true);
    const signals: Record<string, number> = {};
    r.signals.forEach(s => { signals[s.id] = s.score; });
    saveSnapshot(name, website, r.score, r.band, signals);
    return { ok: true, score: r.score };
  } catch { return { ok: false }; }
}

/** Re-scan every enabled monitor that is due per its cadence, then alert on drops. */
export async function rescanDue(): Promise<{ scanned: number; due: number; alerted: number }> {
  const monitors = listMonitors().filter(m => m.enabled);
  let scanned = 0, due = 0, alerted = 0;
  for (const m of monitors) {
    const last = m.lastRunAt ? new Date(m.lastRunAt).getTime() : 0;
    const interval = CADENCE_MS[m.cadence] || CADENCE_MS.weekly;
    if (Date.now() - last < interval) continue;
    due++;
    const prevHist = getHistory(m.website);
    const prevScore = prevHist.length ? prevHist[prevHist.length - 1].score : null;
    const res = await rescanSite(m.name, m.website);
    if (!res.ok) { markMonitorRun(m.website, false); continue; }
    scanned++;
    const hist = getHistory(m.website);
    const cur = hist[hist.length - 1];
    const n = await notify(m, prevScore, cur);
    if (n.alerted) alerted++;
    markMonitorRun(m.website, n.alerted, cur.score);
  }
  return { scanned, due, alerted };
}

/** Internal scheduler for always-on hosts. On scale-to-zero hosts (Cloud Run),
 *  call POST /api/cron/rescan from Cloud Scheduler instead. */
export function startScheduler() {
  const everyHours = 6;
  setInterval(() => {
    rescanDue().then(r => { if (r.scanned) console.log(`  [scheduler] re-scanned ${r.scanned}/${r.due} due, ${r.alerted} alerts sent`); }).catch(() => {});
  }, everyHours * 60 * 60 * 1000);
}

export { getHistory };
