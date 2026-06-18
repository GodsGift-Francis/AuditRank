import { fetchSite, normalizeUrl } from './fetchSite.js';
import { analyze } from './analyze.js';
import { assembleReport } from './score.js';
import type { Business, Report } from './types.js';

export type Emit = (event: string, data: any) => void;
export type AuditResult = Report & { readError?: boolean; message?: string };

/** One audit code path. Pass `emit` to stream live progress (V1 theater). */
export async function runAudit(business: Business, emit: Emit = () => {}): Promise<AuditResult> {
  if (!business.website) { return assembleReport(business, null, 'self', false); }

  let host = business.website;
  try { host = new URL(normalizeUrl(business.website)).host; } catch { /* keep */ }

  emit('log', { key: 'connect', label: `Connecting to ${host}`, state: 'run' });
  const { html, robotsTxt, sitemapXml, llmsTxt, finalUrl, error, fetchMs } = await fetchSite(business.website);

  if (!html) {
    emit('log', { key: 'connect', label: `Could not read ${host}`, state: 'fail' });
    const r = assembleReport(business, null, 'self', false) as AuditResult;
    r.readError = true; r.message = error || "We couldn't read that site automatically. It may block bots or be unreachable.";
    return r;
  }

  emit('log', { key: 'connect', label: `Connected to ${host}`, state: 'done' });
  emit('log', { key: 'fetch', label: `Read the page (${Math.round(html.length / 1024)} KB in ${fetchMs} ms)`, state: 'done' });
  emit('log', { key: 'crawl', label: 'Checked robots.txt, sitemap.xml and llms.txt', state: 'done', detail: { robots: robotsTxt != null, sitemap: sitemapXml != null, llms: llmsTxt != null } });
  emit('log', { key: 'analyze', label: 'Analyzing your visibility signals', state: 'run' });

  const detection = analyze(html, normalizeUrl(finalUrl), robotsTxt, sitemapXml, llmsTxt, fetchMs);
  detection.findings.forEach(f => emit('finding', f));

  emit('log', { key: 'analyze', label: 'Analyzed 9 visibility signals', state: 'done' });
  const mb = detection.aiAccess.majorBlocked;
  emit('log', { key: 'aibots', label: mb === 0 ? 'AI crawlers: all major bots allowed' : `AI crawlers: ${mb} major bot${mb > 1 ? 's' : ''} blocked`, state: mb === 0 ? 'done' : 'warn' });
  emit('log', { key: 'score', label: 'Scoring', state: 'run' });

  const report = assembleReport(business, detection, 'analyzed', true);
  emit('log', { key: 'score', label: `Scored ${report.score} / 100 (${report.band})`, state: 'done' });
  return report;
}
