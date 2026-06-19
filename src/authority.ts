import type { Authority, Entity, Finding, Ans } from './types.js';

// Off-page authority signals (Sprint 3), all free and no-key:
//  - entity presence in Wikidata (knowledge-graph recognition)
//  - domain age via RDAP (trust)
//  - indexable scale from the sitemap
// All network calls are best-effort with a short timeout and fail safe to "unknown"
// so an audit never hangs or breaks if these sources are unreachable.

async function getJson(url: string, ms = 5000): Promise<any | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'AuditRankBot/1.0' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(to); }
}

export async function lookupEntity(name: string): Promise<Entity> {
  if (!name || name.trim().length < 2) return { found: false };
  const j = await getJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&origin=*&limit=5&type=item`);
  if (!j || !Array.isArray(j.search) || !j.search.length) return { found: false };
  const lc = name.toLowerCase().trim();
  // guard against loose matches: require label equality or clear containment
  const hit = j.search.find((s: any) => (s.label || '').toLowerCase() === lc)
    || j.search.find((s: any) => { const l = (s.label || '').toLowerCase(); return l && (l.includes(lc) || lc.includes(l)) && Math.abs(l.length - lc.length) <= 6; });
  if (!hit) return { found: false };
  return { found: true, title: hit.label, description: hit.description || '', id: hit.id, url: hit.concepturi || `https://www.wikidata.org/wiki/${hit.id}` };
}

export async function domainAge(host: string): Promise<number | null> {
  const domain = (host || '').replace(/^www\./, '').split('/')[0];
  if (!domain || !domain.includes('.')) return null;
  const j = await getJson(`https://rdap.org/domain/${domain}`);
  if (!j || !Array.isArray(j.events)) return null;
  const reg = j.events.find((e: any) => /registration/i.test(e.eventAction || ''));
  if (!reg || !reg.eventDate) return null;
  const yrs = (Date.now() - new Date(reg.eventDate).getTime()) / (365.25 * 24 * 3600 * 1000);
  return yrs > 0 ? Math.round(yrs * 10) / 10 : null;
}

export function siteScale(sitemapXml: string | null): number | null {
  if (!sitemapXml) return null;
  const locs = (sitemapXml.match(/<loc>/gi) || []).length;
  return locs > 0 ? locs : null;
}

export async function assessAuthority(name: string, host: string, sitemapXml: string | null): Promise<Authority> {
  const [entity, age] = await Promise.all([
    lookupEntity(name).catch(() => ({ found: false } as Entity)),
    domainAge(host).catch(() => null),
  ]);
  const pages = siteScale(sitemapXml);
  const findings: Finding[] = [];
  findings.push(entity.found
    ? { c: 'ok', t: `Recognized entity: ${entity.title}`, ev: entity.description || entity.url || 'in Wikidata', conf: 'high', status: 'detected' }
    : { c: 'neutral', t: 'No public knowledge-graph entity found', ev: 'no close match in Wikidata', conf: 'med', status: 'unverified' });
  if (age != null) findings.push({ c: age >= 3 ? 'ok' : 'neutral', t: `Domain age ~${age} year${age >= 2 ? 's' : ''}`, ev: 'from RDAP registration date', conf: 'high', status: 'detected' });
  if (pages != null) findings.push({ c: pages >= 20 ? 'ok' : 'neutral', t: `Sitemap lists ~${pages} URL${pages === 1 ? '' : 's'}`, ev: 'counted from sitemap.xml', conf: 'high', status: 'detected' });

  let tier: Authority['tier'] = 'unknown';
  if (entity.found) tier = 'high';
  else if ((age ?? 0) >= 5 || (pages ?? 0) >= 50) tier = 'medium';
  else if (age != null || pages != null) tier = 'low';

  return { entity, domainAgeYears: age, indexablePages: pages, tier, findings };
}

/** Fold authority into the on-page answers. A recognized knowledge-graph entity is
 *  genuine earned recognition, so it counts toward the "mentions" signal. Conservative:
 *  only fires on a real entity match, so ordinary sites are unaffected. */
export function applyAuthority(answers: Record<string, Ans>, authority: Authority): Record<string, Ans> {
  if (authority.entity.found) answers.mentions = 'yes';
  return answers;
}
