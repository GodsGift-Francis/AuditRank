import { fetchSite, fetchPage, normalizeUrl } from './fetchSite.js';
import { analyze, discoverPages } from './analyze.js';
import { assembleReport } from './score.js';
import { assessAuthority, applyAuthority } from './authority.js';
import type { Business, Report } from './types.js';

/** Fast homepage-only score, used for fair side-by-side competitor comparison. */
export async function quickScore(name: string, website: string): Promise<{ name: string; website: string; ok: boolean; score?: number; band?: string }> {
  try {
    const { html, robotsTxt, sitemapXml, llmsTxt, finalUrl, fetchMs } = await fetchSite(website);
    if (!html) return { name, website, ok: false };
    const det = analyze(html, normalizeUrl(finalUrl), robotsTxt, sitemapXml, llmsTxt, fetchMs);
    const r = assembleReport({ name, website }, det, 'analyzed', true);
    return { name, website, ok: true, score: r.score, band: r.band };
  } catch { return { name, website, ok: false }; }
}

/** Suggested buyer-intent prompts to test in AI engines (prompt-intelligence, no-key). */
export function suggestPrompts(name: string, what: string, city: string): string[] {
  let cat = (what || '').trim();
  if (name) cat = cat.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  const GENERIC = /^(blog|home|homepage|news|about|contact|welcome|index|page|untitled)$/i;
  const segs = cat.split(/[|\-–—:·•]+/).map(s => s.trim()).filter(s => s && !GENERIC.test(s));
  cat = (segs.sort((a, b) => b.length - a.length)[0] || '').replace(/[.!?].*$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (cat.length < 4) cat = 'this kind of business';
  const catLc = cat.charAt(0).toLowerCase() + cat.slice(1);
  const where = city && !new RegExp(city, 'i').test(cat) ? ` in ${city}` : '';
  return [
    `What are the best options for ${catLc}${where}?`,
    `Who are the top providers${where}, and why?`,
    `Is ${name} a good choice? What do people say about them?`,
    `Compare ${name} with its main competitors${where}.`,
    `How much should I expect to pay for ${catLc}${where}?`,
  ];
}

export type Emit = (event: string, data: any) => void;
export type AuditResult = Report & { readError?: boolean; message?: string };

const MAX_EXTRA = 4; // homepage + up to 4 more = 5 pages

function shortPath(u: string): string {
  try { const x = new URL(u); return (x.pathname === '/' || !x.pathname) ? x.host.replace(/^www\./, '') : x.pathname; } catch { return u; }
}

/** One audit code path. Crawls a few key pages and headlines the strongest (F4).
 *  Pass `emit` to stream live progress (V1 theater). */
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
  emit('log', { key: 'fetch', label: `Read the homepage (${Math.round(html.length / 1024)} KB in ${fetchMs} ms)`, state: 'done' });
  emit('log', { key: 'crawl', label: 'Checked robots.txt, sitemap.xml and llms.txt', state: 'done', detail: { robots: robotsTxt != null, sitemap: sitemapXml != null, llms: llmsTxt != null } });

  const homeUrl = normalizeUrl(finalUrl);
  const homeDet = analyze(html, homeUrl, robotsTxt, sitemapXml, llmsTxt, fetchMs);
  const pages: { url: string; det: ReturnType<typeof analyze> }[] = [{ url: homeUrl, det: homeDet }];

  // discover + scan a few more key pages so we judge the site, not just the homepage
  const candidates = discoverPages(html, sitemapXml, homeUrl).slice(0, MAX_EXTRA);
  if (candidates.length) emit('log', { key: 'pages', label: `Found ${candidates.length} more page${candidates.length > 1 ? 's' : ''} to check`, state: 'run' });
  for (const u of candidates) {
    const { html: ph, fetchMs: pm } = await fetchPage(u);
    if (!ph) continue;
    pages.push({ url: u, det: analyze(ph, u, robotsTxt, sitemapXml, llmsTxt, pm) });
    emit('log', { key: 'page_' + pages.length, label: `Scanned ${shortPath(u)}`, state: 'done' });
  }
  emit('log', { key: 'pages', label: `Scanned ${pages.length} page${pages.length > 1 ? 's' : ''} across the site`, state: 'done' });

  emit('log', { key: 'analyze', label: 'Analyzing visibility signals across your pages', state: 'run' });
  const scored = pages.map(p => ({ url: p.url, det: p.det, report: assembleReport(business, p.det, 'analyzed', true) }));
  scored.sort((a, b) => b.report.score - a.report.score);
  const best = scored[0];

  best.det.findings.forEach(f => emit('finding', f));
  emit('log', { key: 'analyze', label: `Analyzed signals (strongest page: ${shortPath(best.url)})`, state: 'done' });

  const mb = homeDet.aiAccess.majorBlocked;
  emit('log', { key: 'aibots', label: mb === 0 ? 'AI crawlers: all major bots allowed' : `AI crawlers: ${mb} major bot${mb > 1 ? 's' : ''} blocked`, state: mb === 0 ? 'done' : 'warn' });

  // off-page authority (Sprint 3): best-effort, fails safe to "unknown" offline
  emit('log', { key: 'authority', label: 'Checking off-page authority (entity, domain age)', state: 'run' });
  const authority = await assessAuthority(business.name, host, sitemapXml);
  applyAuthority(best.det.answers, authority);
  emit('log', { key: 'authority', label: authority.tier === 'unknown' ? 'Authority check skipped (source unreachable)' : `Authority: ${authority.tier}${authority.entity.found ? ' (recognized entity)' : ''}`, state: authority.tier === 'unknown' ? 'warn' : 'done' });

  emit('log', { key: 'score', label: 'Scoring', state: 'run' });
  const report = assembleReport(business, best.det, 'analyzed', true) as AuditResult;
  report.authority = authority;
  report.prompts = suggestPrompts(business.name, best.det.profile.what, best.det.profile.city);
  const thin = best.det.pageType === 'thin' || best.det.pageType === 'search-tool';
  report.scan = {
    pages: scored.map(s => ({ url: s.url, score: s.report.score })),
    representative: best.url,
    pageType: best.det.pageType,
    note: thin
      ? "Your strongest page has little citable text content, so the score is low. AuditRank measures how ready a page is to be cited by AI, not a site's size or fame. Point it at a content page (a service, product, or article page) for a fuller picture."
      : undefined,
  };
  emit('log', { key: 'score', label: `Scored ${report.score} / 100 (${report.band}) on your strongest page`, state: 'done' });
  return report;
}
