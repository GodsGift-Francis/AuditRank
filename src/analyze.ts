import * as cheerio from 'cheerio';
import type { Detection, Ans, Finding, AiAccess, AiBot } from './types.js';

const AI_BOTS: { name: string; ua: string; major?: boolean }[] = [
  { name: 'ChatGPT (GPTBot)', ua: 'gptbot', major: true },
  { name: 'ChatGPT-User', ua: 'chatgpt-user' },
  { name: 'OpenAI Search', ua: 'oai-searchbot' },
  { name: 'Claude (ClaudeBot)', ua: 'claudebot', major: true },
  { name: 'Perplexity', ua: 'perplexitybot', major: true },
  { name: 'Google AI (Google-Extended)', ua: 'google-extended', major: true },
  { name: 'Apple (Applebot-Extended)', ua: 'applebot-extended' },
  { name: 'Common Crawl (CCBot)', ua: 'ccbot' },
];

interface RGroup { agents: string[]; dis: string[]; allow: string[]; }
function parseRobots(txt: string): RGroup[] {
  const groups: RGroup[] = []; let cur: RGroup | null = null; let lastAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(); const val = line.slice(i + 1).trim();
    if (key === 'user-agent') { if (!cur || !lastAgent) { cur = { agents: [], dis: [], allow: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastAgent = true; }
    else if (key === 'disallow') { if (cur) cur.dis.push(val); lastAgent = false; }
    else if (key === 'allow') { if (cur) cur.allow.push(val); lastAgent = false; }
    else lastAgent = false;
  }
  return groups;
}
function botAllowed(groups: RGroup[], ua: string): { allowed: boolean; matched: string } {
  if (!groups.length) return { allowed: true, matched: 'no robots.txt' };
  let g = groups.find(x => x.agents.includes(ua));
  let matched = ua;
  if (!g) { g = groups.find(x => x.agents.includes('*')); matched = '*'; }
  if (!g) return { allowed: true, matched: 'default' };
  const blocked = g.dis.some(d => d === '/' || d === '/*') && !g.allow.some(a => a === '/');
  return { allowed: !blocked, matched };
}

export function analyze(html: string, url: string, robotsTxt: string | null, sitemapXml: string | null, llmsTxt: string | null, fetchMs = 0): Detection {
  const $ = cheerio.load(html);
  const raw = html;
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim() || $.text();

  const heads = $('h1,h2,h3,h4').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const qHead = heads.filter(h => /\?\s*$/.test(h) || /^(how|what|why|when|where|can|do|does|is|are|should|which)\b/i.test(h));

  const faqSchema = /"@type"\s*:\s*"FAQPage"/i.test(raw);
  const ldCount = $('script[type="application/ld+json"]').length;
  const ldTypes = [...new Set((raw.match(/"@type"\s*:\s*"([^"]+)"/g) || []).map(m => m.replace(/.*"([^"]+)"$/, '$1')))];
  const hasLocalOrg = /"@type"\s*:\s*"(LocalBusiness|Organization|Store|ProfessionalService)"/i.test(raw);
  const faqLink = $('a[href*="faq" i]').length > 0 || /frequently asked/i.test(raw);

  const numbers = (bodyText.match(/\b\d[\d,.]*\b/g) || []).length;
  const prices = (bodyText.match(/[$£€₵₦]\s?\d|\b\d+(\.\d+)?\s?%|\b(?:ghs|usd|eur|gbp|ngn|zar|kes|cad|aud|gh₵)\s?\d/gi) || []).length;
  const yr = new Date().getFullYear();
  const recentYear = new RegExp(`\\b(${yr}|${yr - 1})\\b`).test(raw);
  const lastUpdated = /last updated|updated on|last modified|datemodified/i.test(raw);

  const aboutLink = $('a[href*="about" i]').length > 0 || /about us/i.test(raw);
  const hasTel = $('a[href^="tel:"]').length > 0 || /\b\+?\d[\d\s().-]{8,}\d\b/.test(bodyText);
  const hasEmail = $('a[href^="mailto:"]').length > 0 || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(raw);
  const hasAddr = /\b\d{1,5}\s+[\w.]+\s+\w+(\s\w+)*\s*(st|street|ave|avenue|rd|road|blvd|lane|ln|dr|drive|suite|ste|way|court|ct)\b/i.test(bodyText);

  const isHttps = url.startsWith('https');
  const viewport = $('meta[name="viewport" i]').length > 0;
  const title = ($('title').first().text() || '').trim();
  const metaDesc = $('meta[name="description" i]').attr('content') || '';
  const noindex = /noindex/i.test($('meta[name="robots" i]').attr('content') || '');
  const words = bodyText.split(/\s+/).filter(Boolean).length;

  const imgEls = $('img');
  const imgN = imgEls.length + $('picture').filter((_, p) => $(p).find('img').length === 0).length;
  let altN = 0;
  imgEls.each((_, im) => { const a = ($(im).attr('alt') || $(im).attr('aria-label') || $(im).attr('title') || '').trim(); if (a) altN++; });
  const bgImgN = (raw.match(/background(-image)?\s*:\s*url\(/gi) || []).length;
  const anyImagery = imgN > 0 || bgImgN > 0;
  const altRatio = imgEls.length ? altN / imgEls.length : 1;
  const altOK = imgEls.length === 0 ? true : altRatio >= 0.6;

  const htmlKB = Math.round(raw.length / 1024);
  const scriptN = $('script').length;
  const cssN = $('link[rel="stylesheet"]').length;
  const heavy = htmlKB > 700 || scriptN > 35;

  let robotsState: 'ok' | 'blocked' | 'unknown' = 'unknown';
  let sitemapState: 'present' | 'missing' | 'unknown' = 'unknown';
  let robotsHasSitemap = false;
  if (robotsTxt != null) { robotsState = /disallow:\s*\/\s*(\n|\r|$)/i.test(robotsTxt) ? 'blocked' : 'ok'; robotsHasSitemap = /sitemap:\s*https?:/i.test(robotsTxt); }
  if (sitemapXml != null) sitemapState = /<urlset|<sitemapindex|<\?xml/i.test(sitemapXml) ? 'present' : 'missing';
  else if (robotsHasSitemap) sitemapState = 'present';
  const robotsOK = robotsState !== 'blocked';
  const sitemapOK = sitemapState === 'present';

  // ---- F1: AI-crawler readiness ----
  const groups = robotsTxt != null ? parseRobots(robotsTxt) : [];
  const bots: AiBot[] = AI_BOTS.map(b => { const r = botAllowed(groups, b.ua); return { name: b.name, allowed: r.allowed, matched: r.matched }; });
  const majorBlocked = AI_BOTS.filter((b, i) => b.major && !bots[i].allowed).length;
  const llmsPresent = !!(llmsTxt && llmsTxt.trim().length > 0 && !/^\s*</.test(llmsTxt));
  const aiAccess: AiAccess = { bots, llmsTxt: llmsPresent, majorBlocked, checked: robotsTxt != null || true };

  // ---- answers ----
  const a: Record<string, Ans> = {};
  a.faq = faqSchema || qHead.length >= 4 ? 'yes' : (qHead.length >= 1 || faqLink) ? 'partial' : 'no';
  a.schema = (faqSchema || hasLocalOrg) ? (ldCount >= 2 || faqSchema ? 'yes' : 'partial') : (ldCount >= 1 ? 'partial' : 'no');
  a.facts = (prices >= 3 && numbers >= 12) ? 'yes' : (numbers >= 6 ? 'partial' : 'no');
  a.fresh = (lastUpdated && recentYear) ? 'yes' : (recentYear ? 'partial' : 'no');
  const idScore = (aboutLink ? 1 : 0) + ((hasTel || hasEmail) ? 1 : 0) + (hasAddr ? 1 : 0);
  a.identity = idScore >= 3 ? 'yes' : (idScore >= 1 ? 'partial' : 'no');
  a.convo = qHead.length >= 4 ? 'yes' : (qHead.length >= 2 ? 'partial' : 'no');
  const techChecks = [isHttps, viewport, !!title, !!metaDesc, !noindex, words > 150, altOK, !heavy, majorBlocked === 0];
  if (robotsState !== 'unknown') techChecks.push(robotsOK);
  if (sitemapState !== 'unknown') techChecks.push(sitemapOK);
  const techRatio = techChecks.filter(Boolean).length / techChecks.length;
  a.tech = techRatio >= 0.8 ? 'yes' : (techRatio >= 0.5 ? 'partial' : 'no');
  a.mentions = null; a.gbp = null;

  // ---- findings with evidence + confidence (F2) ----
  const F: Finding[] = [];
  const add = (c: Finding['c'], t: string, ev: string, conf: Finding['conf'], status: Finding['status']) => F.push({ c, t, ev, conf, status });
  add(faqSchema ? 'ok' : (qHead.length || faqLink) ? 'neutral' : 'no',
    faqSchema ? 'FAQ schema detected on the page' : (qHead.length || faqLink) ? 'Some Q&A-style content, but no FAQ schema' : 'No FAQ / Q&A content detected',
    `${qHead.length} question-style heading${qHead.length === 1 ? '' : 's'}${faqSchema ? ', FAQPage schema present' : ''}`, 'high', 'detected');
  add(ldCount ? 'ok' : 'no', ldCount ? `Schema markup found: ${ldCount} block${ldCount > 1 ? 's' : ''}` : 'No structured data (schema) found',
    ldTypes.length ? ldTypes.slice(0, 6).join(', ') : 'no JSON-LD blocks', 'high', 'detected');
  add((prices >= 3 && numbers >= 12) ? 'ok' : (numbers >= 6 ? 'neutral' : 'no'),
    (prices >= 3 && numbers >= 12) ? 'Plenty of specific numbers/prices' : (numbers >= 6 ? 'Some numbers found; few concrete prices/stats' : 'Very few concrete facts or numbers'),
    `${numbers} numbers, ${prices} prices/percentages in body text`, 'med', 'inferred');
  add((lastUpdated && recentYear) ? 'ok' : (recentYear ? 'neutral' : 'no'),
    (lastUpdated && recentYear) ? 'A recent "last updated" date is shown' : (recentYear ? 'A recent year appears, but no clear "updated" date' : 'No recent date / freshness signal'),
    `${recentYear ? 'recent year present' : 'no recent year'}; ${lastUpdated ? '"updated" wording present' : 'no "updated" wording'}`, 'med', 'inferred');
  add(idScore >= 2 ? 'ok' : 'no', idScore >= 2 ? 'Identity signals found (About / contact)' : 'Weak identity signals (add About + contact)',
    `${aboutLink ? 'About link' : 'no About'}; ${(hasTel || hasEmail) ? 'contact found' : 'no contact'}; ${hasAddr ? 'address found' : 'no address'}`, 'high', 'detected');
  // AI-crawler readiness (the headline F1 findings)
  add(majorBlocked === 0 ? 'ok' : 'no', majorBlocked === 0 ? 'Major AI crawlers are allowed to read your site' : `Blocking ${majorBlocked} major AI crawler${majorBlocked > 1 ? 's' : ''}`,
    bots.filter(b => !b.allowed).length ? 'blocked: ' + bots.filter(b => !b.allowed).map(b => b.name).join(', ') : 'GPTBot, ClaudeBot, PerplexityBot, Google-Extended all permitted', 'high', 'detected');
  add(llmsPresent ? 'ok' : 'neutral', llmsPresent ? 'llms.txt found (guides AI crawlers)' : 'No llms.txt (optional, emerging standard)',
    llmsPresent ? '/llms.txt served' : '/llms.txt not found', 'high', 'detected');
  add(isHttps && viewport ? 'ok' : (isHttps || viewport ? 'neutral' : 'no'), `Technical: ${isHttps ? 'HTTPS ' : 'no-HTTPS '}· ${viewport ? 'mobile-ready' : 'no viewport'} · ${title ? 'title set' : 'no title'}`,
    `https=${isHttps}, viewport=${viewport}, title=${!!title}, meta-desc=${!!metaDesc}, noindex=${noindex}`, 'high', 'detected');
  add(!anyImagery ? 'neutral' : (imgEls.length === 0 ? 'ok' : altRatio >= 0.8 ? 'ok' : altRatio >= 0.4 ? 'neutral' : 'no'),
    !anyImagery ? 'No images detected' : (imgEls.length === 0 ? `${bgImgN} CSS background image${bgImgN !== 1 ? 's' : ''}` : `Images: ${imgEls.length} found, ${altN} with alt (${Math.round(altRatio * 100)}%)`),
    `${imgEls.length} <img>, ${altN} with alt text, ${bgImgN} CSS backgrounds`, 'high', 'detected');
  add(heavy ? 'no' : 'ok', `Page weight ~${htmlKB} KB · ${scriptN} scripts · ${cssN} stylesheets — ${heavy ? 'heavy' : 'light'}`,
    `${htmlKB} KB HTML, ${scriptN} script tags, ${cssN} stylesheets`, 'med', 'inferred');
  if (fetchMs > 0) add(fetchMs < 800 ? 'ok' : fetchMs < 2500 ? 'neutral' : 'no',
    `Server responded in ~${fetchMs} ms`, `measured time to fetch the HTML: ${fetchMs} ms`, 'high', 'detected');
  add((robotsState === 'unknown' && sitemapState === 'unknown') ? 'neutral' : (robotsOK && sitemapOK ? 'ok' : 'neutral'),
    `Crawlability: robots.txt ${robotsState === 'unknown' ? '—' : robotsState === 'blocked' ? 'blocks crawlers ✕' : 'ok'} · sitemap.xml ${sitemapState === 'unknown' ? '—' : sitemapState}`,
    `robots.txt ${robotsTxt != null ? 'fetched' : 'not found'}, sitemap.xml ${sitemapXml != null ? 'fetched' : 'not found'}`, 'high', 'detected');

  const what = (metaDesc || title || '').slice(0, 160);
  const city = guessCity(bodyText);
  const confidence = words > 200 ? 0.92 : (words > 60 ? 0.78 : 0.6);

  // page-type classification (Sprint 1)
  const hasSearch = $('input[type="search"]').length > 0 || $('[role="search"]').length > 0 || $('form[action*="search" i]').length > 0 || $('input[name="q"]').length > 0;
  const isArticle = /"@type"\s*:\s*"(NewsArticle|Article|BlogPosting)"/i.test(raw) || $('article').length > 0;
  const isProduct = /"@type"\s*:\s*"Product"/i.test(raw) || /\badd to cart\b|\bbuy now\b/i.test(bodyText);
  const contentful = faqSchema || qHead.length >= 2 || ldCount >= 1 || isArticle || isProduct || numbers >= 8;
  let pageType = 'home';
  if (words < 90 && hasSearch && !contentful) pageType = 'search-tool';
  else if (words < 120 && !contentful) pageType = 'thin';
  else if (isProduct) pageType = 'product';
  else if (isArticle) pageType = 'article';

  return { answers: a, findings: F, profile: { what, city, country: '' }, aiAccess, confidence, pageType };
}

const KEY_PATH = /(about|faq|service|product|pricing|menu|blog|news|article|portfolio|work|team|contact|listing|propert|home-for|for-sale|for-rent)/i;
function toAbs(href: string, base: string): string | null {
  try { return new URL(href, base).toString(); } catch { return null; }
}
function stripHash(u: string): string { return u.split('#')[0].replace(/\/$/, '') || u; }
function sameHost(u: string, originUrl: string): boolean {
  try { return new URL(u).host.replace(/^www\./, '') === new URL(originUrl).host.replace(/^www\./, ''); } catch { return false; }
}

/** Discover same-site candidate pages from the sitemap and on-page nav links (Sprint 2 / F4). */
export function discoverPages(html: string, sitemapXml: string | null, currentUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const cur = stripHash(currentUrl);
  const push = (u: string | null) => {
    if (!u) return;
    const s = stripHash(u);
    if (s === cur || seen.has(s)) return;
    if (!sameHost(s, currentUrl)) return;
    if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|ico|css|js|zip|mp4|xml|woff2?|txt)(\?|$)/i.test(s)) return;
    if (/^(mailto:|tel:|javascript:)/i.test(u)) return;
    seen.add(s); out.push(s);
  };
  // sitemap first, key pages prioritized
  if (sitemapXml) {
    const locs = [...sitemapXml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1].trim());
    locs.sort((x, y) => (KEY_PATH.test(y) ? 1 : 0) - (KEY_PATH.test(x) ? 1 : 0));
    locs.forEach(push);
  }
  // then nav links, key pages prioritized
  try {
    const $ = cheerio.load(html);
    const links = $('a[href]').map((_, a) => toAbs($(a).attr('href') || '', currentUrl)).get().filter(Boolean) as string[];
    links.sort((x, y) => (KEY_PATH.test(y) ? 1 : 0) - (KEY_PATH.test(x) ? 1 : 0));
    links.forEach(push);
  } catch { /* ignore */ }
  return out;
}

function guessCity(text: string): string {
  const m = text.match(/\b(?:in|serving|based in|located in)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/);
  return m ? m[1] : '';
}
