import * as cheerio from 'cheerio';
import { fetchSite, fetchPageDetailed, normalizeUrl } from './fetchSite.js';
import { analyze, discoverPages } from './analyze.js';
import { assembleReport } from './score.js';
import type { Business } from './types.js';

export type Emit = (event: string, data: any) => void;
const MAX_PAGES = 16;

export interface PageData {
  url: string; status: number; redirected: boolean; fetchMs: number; bytes: number;
  title: string; titleLen: number; metaDesc: string; metaDescLen: number;
  h1Count: number; wordCount: number; imgCount: number; imgWithAlt: number;
  internalLinks: string[]; externalLinks: number; canonical: string | null;
  noindex: boolean; viewport: boolean; schemaTypes: string[]; https: boolean; ok: boolean;
}

export interface Issue { severity: 'critical' | 'warning' | 'good'; area: string; title: string; detail: string; count?: number; }
export interface DeepReport {
  ok: boolean; website: string; name: string; crawledAt: string; pagesCrawled: number;
  overall: number; categories: { technical: number; indexability: number; content: number; ai: number };
  crawl: { statusDist: Record<string, number>; avgFetchMs: number; avgKb: number; slowest: { url: string; ms: number }[]; heaviest: { url: string; kb: number }[] };
  seo: { titlesMissing: number; titlesDup: number; titlesLong: number; metaMissing: number; metaDup: number; metaLong: number; missingH1: number; multipleH1: number; thinPages: { url: string; words: number }[]; avgWords: number };
  media: { images: number; missingAlt: number; altPct: number };
  index: { noindex: number; canonicalized: number; nonHttps: number; indexable: number };
  schema: { pagesWith: number; types: string[] };
  links: { avgInternal: number; orphans: string[] };
  tech: { https: boolean; robots: boolean; sitemap: boolean; sitemapUrls: number; llms: boolean };
  aiAccess: { blocked: number; llms: boolean; headlinePage: string; band: string };
  issues: Issue[];
  fixes: { priority: number; area: string; title: string; action: string }[];
  note: string;
}

const norm = (u: string) => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, '') || x.origin; } catch { return u.replace(/\/$/, ''); } };
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export function extractPage(html: string, url: string, status: number, redirected: boolean, fetchMs: number, bytes: number): PageData {
  const $ = cheerio.load(html || '');
  const title = ($('head > title').first().text() || '').trim();
  const metaDesc = ($('meta[name="description"]').attr('content') || '').trim();
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const canonical = $('link[rel="canonical"]').attr('href') || null;
  const schemaTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, s) => {
    const t = $(s).contents().text(); const m = t.match(/"@type"\s*:\s*"([^"]+)"/g);
    if (m) m.forEach(x => { const v = x.replace(/.*"([^"]+)"$/, '$1'); if (!schemaTypes.includes(v)) schemaTypes.push(v); });
  });
  const imgs = $('img');
  const imgWithAlt = imgs.filter((_, e) => (($(e).attr('alt') || '').trim().length > 0)).length;
  const h1Count = $('h1').length;
  const viewport = $('meta[name="viewport"]').length > 0;
  const h = host(url);
  const internal: string[] = []; let external = 0;
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let abs: string; try { abs = new URL(href, url).toString(); } catch { return; }
    if (host(abs) === h) internal.push(norm(abs)); else if (/^https?:/i.test(abs)) external++;
  });
  // count only visible copy, not script/style/template text
  $('script, style, noscript, template').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const words = bodyText ? bodyText.split(' ').length : 0;
  return {
    url: norm(url), status, redirected, fetchMs, bytes,
    title, titleLen: title.length, metaDesc, metaDescLen: metaDesc.length,
    h1Count, wordCount: words,
    imgCount: imgs.length, imgWithAlt,
    internalLinks: Array.from(new Set(internal)), externalLinks: external,
    canonical: canonical ? norm(canonical) : null,
    noindex: /noindex/.test(robotsMeta), viewport,
    schemaTypes, https: url.startsWith('https:'), ok: status >= 200 && status < 300 && !!html,
  };
}

function clamp(n: number) { return Math.max(0, Math.min(100, Math.round(n))); }

export async function deepResearch(business: Business, emit: Emit = () => {}): Promise<DeepReport> {
  const website = business.website!;
  let dispHost = website; try { dispHost = new URL(normalizeUrl(website)).host; } catch {}
  emit('log', { key: 'connect', label: `Connecting to ${dispHost}`, state: 'run' });
  const home = await fetchSite(website);
  if (!home.html) {
    emit('log', { key: 'connect', label: `Could not read ${dispHost}`, state: 'fail' });
    return emptyReport(business, "We couldn't read that site automatically. It may block bots or be unreachable.");
  }
  emit('log', { key: 'connect', label: `Connected to ${dispHost}`, state: 'done' });

  const homeUrl = normalizeUrl(home.finalUrl);
  const candidates = [homeUrl, ...discoverPages(home.html, home.sitemapXml, homeUrl)];
  const urls = Array.from(new Set(candidates.map(norm))).slice(0, MAX_PAGES);
  emit('log', { key: 'crawl', label: `Crawling ${urls.length} pages`, state: 'run' });

  const pages: PageData[] = [];
  let bestScore = 0, bestBand = 'Invisible', bestPage = homeUrl, blocked = 0;
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    const f = u === norm(homeUrl) ? { status: 200, html: home.html, finalUrl: homeUrl, fetchMs: home.fetchMs, bytes: home.html.length, redirected: false } : await fetchPageDetailed(u);
    const pd = extractPage(f.html || '', f.finalUrl || u, f.status, f.redirected, f.fetchMs, f.bytes);
    pages.push(pd);
    if (f.html) {
      const det = analyze(f.html, u, home.robotsTxt, home.sitemapXml, home.llmsTxt, f.fetchMs);
      const r = assembleReport(business, det, 'analyzed', true);
      if (r.score > bestScore) { bestScore = r.score; bestBand = r.band; bestPage = u; }
      blocked = det.aiAccess.majorBlocked;
    }
    emit('log', { key: 'p' + i, label: `Scanned ${new URL(u).pathname || '/'} (${f.status || 'err'})`, state: 'done' });
  }
  emit('log', { key: 'crawl', label: `Crawled ${pages.length} pages`, state: 'done' });
  emit('log', { key: 'analyze', label: 'Building report', state: 'run' });

  const okPages = pages.filter(p => p.ok);
  const n = okPages.length || 1;
  // crawl health
  const statusDist: Record<string, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, err: 0 };
  pages.forEach(p => { const s = p.status; statusDist[s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : s >= 200 ? '2xx' : 'err']++; });
  const avgFetchMs = Math.round(pages.reduce((a, p) => a + p.fetchMs, 0) / pages.length);
  const avgKb = Math.round(pages.reduce((a, p) => a + p.bytes, 0) / pages.length / 1024);
  const slowest = [...pages].sort((a, b) => b.fetchMs - a.fetchMs).slice(0, 3).map(p => ({ url: p.url, ms: p.fetchMs }));
  const heaviest = [...pages].sort((a, b) => b.bytes - a.bytes).slice(0, 3).map(p => ({ url: p.url, kb: Math.round(p.bytes / 1024) }));

  // seo
  const titleMap: Record<string, number> = {}, metaMap: Record<string, number> = {};
  okPages.forEach(p => { if (p.title) titleMap[p.title] = (titleMap[p.title] || 0) + 1; if (p.metaDesc) metaMap[p.metaDesc] = (metaMap[p.metaDesc] || 0) + 1; });
  const titlesMissing = okPages.filter(p => !p.title).length;
  const titlesDup = Object.values(titleMap).filter(c => c > 1).reduce((a, c) => a + c, 0);
  const titlesLong = okPages.filter(p => p.titleLen > 60).length;
  const metaMissing = okPages.filter(p => !p.metaDesc).length;
  const metaDup = Object.values(metaMap).filter(c => c > 1).reduce((a, c) => a + c, 0);
  const metaLong = okPages.filter(p => p.metaDescLen > 160).length;
  const missingH1 = okPages.filter(p => p.h1Count === 0).length;
  const multipleH1 = okPages.filter(p => p.h1Count > 1).length;
  const thinPages = okPages.filter(p => p.wordCount < 200).map(p => ({ url: p.url, words: p.wordCount })).slice(0, 8);
  const avgWords = Math.round(okPages.reduce((a, p) => a + p.wordCount, 0) / n);

  // media
  const images = okPages.reduce((a, p) => a + p.imgCount, 0);
  const withAlt = okPages.reduce((a, p) => a + p.imgWithAlt, 0);
  const missingAlt = images - withAlt;
  const altPct = images ? Math.round((withAlt / images) * 100) : 100;

  // indexability
  const noindex = okPages.filter(p => p.noindex).length;
  const canonicalized = okPages.filter(p => p.canonical && p.canonical !== p.url).length;
  const nonHttps = pages.filter(p => !p.https).length;
  const indexable = okPages.filter(p => !p.noindex).length;

  // schema
  const typesSet = new Set<string>(); let pagesWithSchema = 0;
  okPages.forEach(p => { if (p.schemaTypes.length) { pagesWithSchema++; p.schemaTypes.forEach(t => typesSet.add(t)); } });

  // linking + orphans
  const allInternal = new Set<string>();
  okPages.forEach(p => p.internalLinks.forEach(l => allInternal.add(l)));
  const orphans = okPages.filter(p => p.url !== norm(homeUrl) && !allInternal.has(p.url)).map(p => p.url).slice(0, 8);
  const avgInternal = Math.round(okPages.reduce((a, p) => a + p.internalLinks.length, 0) / n);

  // sitemap url count
  const sitemapUrls = home.sitemapXml ? (home.sitemapXml.match(/<loc>/gi) || []).length : 0;

  // category scores
  const technical = clamp(100
    - (nonHttps > 0 ? 25 : 0)
    - (!home.robotsTxt ? 10 : 0)
    - (!home.sitemapXml ? 12 : 0)
    - (statusDist['4xx'] + statusDist['5xx'] + statusDist.err) * 8
    - (avgFetchMs > 1500 ? 12 : avgFetchMs > 800 ? 6 : 0)
    - (avgKb > 400 ? 8 : 0)
    - (okPages.filter(p => !p.viewport).length > 0 ? 8 : 0));
  const indexability = clamp(100
    - (noindex / n) * 60
    - (canonicalized / n) * 15
    - (nonHttps > 0 ? 15 : 0)
    - (!home.sitemapXml ? 10 : 0));
  const content = clamp(100
    - (titlesMissing / n) * 30 - (titlesDup / n) * 12 - titlesLong * 2
    - (metaMissing / n) * 20 - (metaDup / n) * 8
    - (missingH1 / n) * 15
    - (thinPages.length / n) * 20
    - (100 - altPct) * 0.15);
  const ai = bestScore;
  const overall = clamp(technical * 0.3 + indexability * 0.25 + content * 0.25 + ai * 0.2);

  // issues
  const issues: Issue[] = [];
  const crit = statusDist['4xx'] + statusDist['5xx'] + statusDist.err;
  if (crit) issues.push({ severity: 'critical', area: 'Crawl', title: `${crit} page${crit > 1 ? 's' : ''} returned an error`, detail: 'Broken or unreachable pages waste crawl budget and lose rankings.', count: crit });
  if (nonHttps) issues.push({ severity: 'critical', area: 'Technical', title: `${nonHttps} page${nonHttps > 1 ? 's' : ''} not served over HTTPS`, detail: 'HTTPS is a baseline trust and ranking signal.', count: nonHttps });
  if (titlesMissing) issues.push({ severity: 'critical', area: 'Content', title: `${titlesMissing} page${titlesMissing > 1 ? 's' : ''} missing a title tag`, detail: 'The title is the single most important on-page SEO element.', count: titlesMissing });
  if (noindex) issues.push({ severity: 'critical', area: 'Indexability', title: `${noindex} page${noindex > 1 ? 's' : ''} set to noindex`, detail: 'These pages are excluded from search results. Confirm that is intended.', count: noindex });
  if (metaMissing) issues.push({ severity: 'warning', area: 'Content', title: `${metaMissing} page${metaMissing > 1 ? 's' : ''} missing a meta description`, detail: 'Meta descriptions shape your search snippet and click-through rate.', count: metaMissing });
  if (titlesDup) issues.push({ severity: 'warning', area: 'Content', title: `${titlesDup} pages share a duplicate title`, detail: 'Duplicate titles confuse engines about which page to rank.', count: titlesDup });
  if (missingH1) issues.push({ severity: 'warning', area: 'Content', title: `${missingH1} page${missingH1 > 1 ? 's' : ''} missing an H1`, detail: 'A clear H1 tells engines and readers the main topic.', count: missingH1 });
  if (thinPages.length) issues.push({ severity: 'warning', area: 'Content', title: `${thinPages.length} thin page${thinPages.length > 1 ? 's' : ''} (under 200 words)`, detail: 'Thin pages rarely get cited or ranked. Expand or consolidate them.', count: thinPages.length });
  if (missingAlt) issues.push({ severity: 'warning', area: 'Media', title: `${missingAlt} image${missingAlt > 1 ? 's' : ''} missing alt text`, detail: 'Alt text aids accessibility and image search.', count: missingAlt });
  if (orphans.length) issues.push({ severity: 'warning', area: 'Links', title: `${orphans.length} orphan page${orphans.length > 1 ? 's' : ''} found`, detail: 'Pages not linked from elsewhere are hard for engines to discover.', count: orphans.length });
  if (blocked) issues.push({ severity: 'warning', area: 'AI', title: `${blocked} major AI crawler${blocked > 1 ? 's' : ''} blocked`, detail: 'Blocked AI crawlers cannot read or recommend your site.', count: blocked });
  if (!home.sitemapXml) issues.push({ severity: 'warning', area: 'Technical', title: 'No sitemap.xml found', detail: 'A sitemap helps engines discover all your pages.' });
  // positives
  if (!nonHttps) issues.push({ severity: 'good', area: 'Technical', title: 'Every page served over HTTPS', detail: 'Secure by default.' });
  if (home.sitemapXml) issues.push({ severity: 'good', area: 'Technical', title: `Sitemap found with ${sitemapUrls} URL${sitemapUrls === 1 ? '' : 's'}`, detail: 'Good discoverability.' });
  if (pagesWithSchema) issues.push({ severity: 'good', area: 'Schema', title: `${pagesWithSchema} page${pagesWithSchema > 1 ? 's' : ''} use structured data`, detail: `Types: ${Array.from(typesSet).slice(0, 6).join(', ')}.` });
  if (home.llmsTxt) issues.push({ severity: 'good', area: 'AI', title: 'llms.txt present', detail: 'You guide AI crawlers explicitly.' });
  if (altPct === 100 && images) issues.push({ severity: 'good', area: 'Media', title: 'All images have alt text', detail: 'Fully accessible imagery.' });

  // prioritized fixes (from non-good issues)
  const sevRank = { critical: 0, warning: 1, good: 2 } as const;
  const fixes = issues.filter(i => i.severity !== 'good')
    .sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (b.count || 1) - (a.count || 1))
    .map((i, idx) => ({ priority: idx + 1, area: i.area, title: i.title, action: fixFor(i) }));

  emit('log', { key: 'analyze', label: 'Report ready', state: 'done' });
  return {
    ok: true, website, name: business.name, crawledAt: new Date().toISOString(), pagesCrawled: pages.length,
    overall, categories: { technical, indexability, content, ai },
    crawl: { statusDist, avgFetchMs, avgKb, slowest, heaviest },
    seo: { titlesMissing, titlesDup, titlesLong, metaMissing, metaDup, metaLong, missingH1, multipleH1, thinPages, avgWords },
    media: { images, missingAlt, altPct },
    index: { noindex, canonicalized, nonHttps, indexable },
    schema: { pagesWith: pagesWithSchema, types: Array.from(typesSet).slice(0, 10) },
    links: { avgInternal, orphans },
    tech: { https: !nonHttps, robots: !!home.robotsTxt, sitemap: !!home.sitemapXml, sitemapUrls, llms: !!home.llmsTxt },
    aiAccess: { blocked, llms: !!home.llmsTxt, headlinePage: bestPage, band: bestBand },
    issues, fixes,
    note: 'Independent crawl-based analysis. Real search queries, clicks, average position and index coverage come from Google Search Console, which needs the verified owner to connect it (planned for the connected tier).',
  };
}

function fixFor(i: Issue): string {
  const map: Record<string, string> = {
    'Crawl': 'Find the failing URLs in the crawl, fix the broken links or restore the pages, and return a clean 200 or a correct redirect.',
    'Technical': i.title.includes('sitemap') ? 'Generate an XML sitemap, list it in robots.txt, and submit it in Search Console.' : 'Serve every page over HTTPS and force-redirect http to https site-wide.',
    'Content': i.title.includes('title') ? 'Write a unique, descriptive title (50 to 60 characters) for each page.' : i.title.includes('meta') ? 'Add a unique 140 to 160 character meta description that earns the click.' : i.title.includes('H1') ? 'Add one clear H1 per page stating its main topic.' : 'Expand thin pages to genuinely useful depth or merge them into a stronger page.',
    'Media': 'Add concise, descriptive alt text to every meaningful image.',
    'Links': 'Link to orphan pages from relevant navigation or related content so they can be discovered.',
    'Indexability': 'Review noindex tags and remove them from any page that should rank.',
    'AI': 'Allow GPTBot, ClaudeBot, PerplexityBot and Google-Extended in robots.txt so AI engines can read you.',
  };
  return map[i.area] || 'Review and resolve the flagged pages.';
}

function emptyReport(business: Business, note: string): DeepReport {
  return {
    ok: false, website: business.website || '', name: business.name, crawledAt: new Date().toISOString(), pagesCrawled: 0,
    overall: 0, categories: { technical: 0, indexability: 0, content: 0, ai: 0 },
    crawl: { statusDist: {}, avgFetchMs: 0, avgKb: 0, slowest: [], heaviest: [] },
    seo: { titlesMissing: 0, titlesDup: 0, titlesLong: 0, metaMissing: 0, metaDup: 0, metaLong: 0, missingH1: 0, multipleH1: 0, thinPages: [], avgWords: 0 },
    media: { images: 0, missingAlt: 0, altPct: 0 }, index: { noindex: 0, canonicalized: 0, nonHttps: 0, indexable: 0 },
    schema: { pagesWith: 0, types: [] }, links: { avgInternal: 0, orphans: [] },
    tech: { https: false, robots: false, sitemap: false, sitemapUrls: 0, llms: false },
    aiAccess: { blocked: 0, llms: false, headlinePage: '', band: '' }, issues: [], fixes: [], note,
  };
}
