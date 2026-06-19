import { lookup } from 'node:dns/promises';

// Server-side fetching with SSRF protection (G2). The server fetches arbitrary
// user-supplied URLs, so we must refuse internal/cloud-metadata targets.

const UA = 'Mozilla/5.0 (compatible; AuditRankBot/1.0; +https://auditrank.app/bot)';
const MAX_BYTES = 3_000_000;

function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) { // IPv6
    const x = ip.toLowerCase();
    return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x === '::';
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n))) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function assertSafe(rawUrl: string): Promise<URL> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('That does not look like a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https sites can be audited.');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') throw new Error('That host is not allowed.');
  // resolve and reject private/link-local IPs (blocks SSRF to internal + cloud metadata)
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('That host resolves to a non-public address and cannot be audited.');
  } catch (e: any) {
    if (e?.message?.includes('non-public')) throw e;
    throw new Error('Could not resolve that domain.');
  }
  return u;
}

async function get(url: string, timeoutMs = 12000): Promise<string | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*' }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || '0');
    if (len && len > MAX_BYTES) return null;
    const txt = await res.text();
    return txt.length > MAX_BYTES ? txt.slice(0, MAX_BYTES) : txt;
  } catch { return null; } finally { clearTimeout(to); }
}

export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
export function origin(u: string): string {
  try { return new URL(u).origin; } catch { return u.replace(/^(https?:\/\/[^/]+).*/, '$1'); }
}

export interface FetchResult {
  html: string | null; robotsTxt: string | null; sitemapXml: string | null; llmsTxt: string | null;
  finalUrl: string; error?: string; fetchMs: number;
}

export async function fetchPage(rawUrl: string): Promise<{ html: string | null; fetchMs: number }> {
  const url = normalizeUrl(rawUrl);
  let safe: URL;
  try { safe = await assertSafe(url); } catch { return { html: null, fetchMs: 0 }; }
  const t0 = Date.now();
  const html = await get(safe.toString());
  return { html, fetchMs: Date.now() - t0 };
}

export async function fetchSite(rawUrl: string): Promise<FetchResult> {
  const url = normalizeUrl(rawUrl);
  let safe: URL;
  try { safe = await assertSafe(url); } catch (e: any) {
    return { html: null, robotsTxt: null, sitemapXml: null, llmsTxt: null, finalUrl: url, error: e?.message || 'Blocked', fetchMs: 0 };
  }
  const t0 = Date.now();
  let html = await get(safe.toString());
  if (!html && safe.protocol === 'https:') { try { const alt = await assertSafe('http://' + safe.host + safe.pathname); html = await get(alt.toString()); } catch {} }
  const fetchMs = Date.now() - t0;
  const o = origin(url);
  const [robotsTxt, sitemapXml, llmsTxt] = html
    ? await Promise.all([get(o + '/robots.txt', 6000), get(o + '/sitemap.xml', 6000), get(o + '/llms.txt', 6000)])
    : [null, null, null];
  return { html, robotsTxt, sitemapXml, llmsTxt, finalUrl: url, fetchMs };
}
