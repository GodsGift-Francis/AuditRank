import type { Report } from './types.js';

// Shareable report (V3): a branded 1200x630 social card (zero-dependency SVG) plus a
// crawlable public page with Open Graph / Twitter meta so links unfurl nicely.

const esc = (s: string) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function arcColor(score: number): string {
  if (score >= 80) return '#1FA971';
  if (score >= 60) return '#FFB020';
  if (score >= 35) return '#E8920A';
  return '#E5484D';
}

function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines: string[] = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > perLine) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1,3}$/, '…');
  return lines;
}

/** 1200x630 Open Graph card for a report. Pure SVG, no fonts/binaries required. */
export function buildShareCard(r: Report): string {
  const score = Math.max(0, Math.min(100, Math.round(r.score || 0)));
  const band = esc(r.band || '');
  const name = esc((r.business?.name || 'This site').slice(0, 38));
  const col = arcColor(score);
  const R = 132, CIRC = 2 * Math.PI * R, dash = (score / 100) * CIRC;
  const headlineLines = wrap(r.headline || 'AI search visibility audit', 30, 2);
  const cx = 250, cy = 315;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="Inter, Segoe UI, system-ui, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#15163a"/><stop offset="1" stop-color="#0f1024"/></linearGradient>
    <radialGradient id="glow" cx="20%" cy="50%" r="55%"><stop offset="0" stop-color="${col}" stop-opacity="0.22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(64,60)">
    <rect width="34" height="34" rx="10" fill="#ffffff"/>
    <circle cx="17" cy="17" r="8" fill="#FFB020"/>
    <text x="48" y="25" fill="#ffffff" font-size="26" font-weight="800" letter-spacing="-0.5">AuditRank</text>
    <text x="190" y="24" fill="rgba(255,255,255,0.5)" font-size="13" font-weight="600" letter-spacing="2" font-family="JetBrains Mono, monospace">AI SEARCH VISIBILITY</text>
  </g>
  <g transform="translate(${cx},${cy})">
    <circle r="${R}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="20"/>
    <circle r="${R}" fill="none" stroke="${col}" stroke-width="20" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${CIRC.toFixed(1)}" transform="rotate(-90)"/>
    <text text-anchor="middle" y="6" fill="#ffffff" font-size="104" font-weight="800" letter-spacing="-3">${score}</text>
    <text text-anchor="middle" y="48" fill="rgba(255,255,255,0.55)" font-size="20" font-weight="600" font-family="JetBrains Mono, monospace">/ 100</text>
  </g>
  <g transform="translate(470,210)">
    <rect width="${22 + band.length * 12}" height="38" rx="19" fill="${col}"/>
    <text x="${(22 + band.length * 12) / 2}" y="25" text-anchor="middle" fill="#1a1206" font-size="16" font-weight="800" letter-spacing="1">${band.toUpperCase()}</text>
    <text x="0" y="92" fill="#ffffff" font-size="34" font-weight="800">${name}</text>
    ${headlineLines.map((l, i) => `<text x="0" y="${140 + i * 36}" fill="rgba(255,255,255,0.8)" font-size="26" font-weight="500">${esc(l)}</text>`).join('')}
  </g>
  <text x="64" y="588" fill="rgba(255,255,255,0.45)" font-size="17" font-family="JetBrains Mono, monospace">How ready is your site to be cited by AI? Find out free at auditrank</text>
</svg>`;
}

/** Crawlable, self-contained public report page with OG/Twitter meta. */
export function buildSharePage(id: string, r: Report, origin: string): string {
  const score = Math.round(r.score || 0);
  const name = r.business?.name || 'This site';
  const band = r.band || '';
  const headline = r.headline || 'AI search visibility audit';
  const title = `${name} scored ${score}/100 on AI search visibility`;
  const desc = (r.summary || headline).slice(0, 180);
  const img = `${origin}/r/${esc(id)}/card.png`;
  const fixes = (r.fixes || []).slice(0, 3);
  const col = arcColor(score);
  const R = 78, CIRC = 2 * Math.PI * R, dash = (score / 100) * CIRC;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${origin}/r/${esc(id)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${img}">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;800&family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#14152E;--indigo:#1C2050;--amber:#FFB020;--paper:#F4F5F8;--line:#E6E8F1;--muted:#6A6F86;--ink-soft:#3A3D55}
*{box-sizing:border-box;margin:0}body{font-family:Inter,system-ui,sans-serif;background:var(--paper);color:var(--ink);line-height:1.55}
.wrap{max-width:760px;margin:0 auto;padding:34px 22px 60px}
.brand{display:flex;align-items:center;gap:10px;font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:19px;color:var(--ink)}
.brand .d{width:28px;height:28px;border-radius:8px;background:var(--ink);display:grid;place-items:center}.brand .d span{width:11px;height:11px;border-radius:50%;background:var(--amber)}
.hero{margin-top:24px;background:linear-gradient(135deg,#15163a,#1d1f4a);color:#fff;border-radius:18px;padding:30px;display:flex;gap:28px;align-items:center;flex-wrap:wrap}
.g{position:relative;width:180px;height:180px;flex:none}.g svg{transform:rotate(-90deg)}.g .n{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
.g .n b{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:56px;line-height:1}.g .n small{font-family:'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,.55);letter-spacing:2px}
.hero .info{flex:1;min-width:220px}
.band{display:inline-block;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:5px 12px;border-radius:100px;background:${col};color:#1a1206;margin-bottom:12px}
.hero h1{font-family:'Bricolage Grotesque',sans-serif;font-size:25px;font-weight:800;margin-bottom:8px}
.hero p{color:rgba(255,255,255,.78);font-size:14.5px}
h2{font-family:'JetBrains Mono',monospace;font-size:11.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin:34px 0 14px}
.fix{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:10px}
.fix h3{font-size:15px;font-weight:700;margin-bottom:4px}.fix p{font-size:13.5px;color:var(--ink-soft)}
.cta{display:inline-block;margin-top:26px;background:linear-gradient(135deg,var(--amber),#E8920A);color:#231a02;font-weight:700;font-size:15px;padding:14px 26px;border-radius:11px;text-decoration:none}
footer{margin-top:40px;color:var(--muted);font-size:12.5px;text-align:center}
</style></head><body><div class="wrap">
<div class="brand"><span class="d"><span></span></span> AuditRank</div>
<div class="hero">
  <div class="g"><svg width="180" height="180" viewBox="0 0 180 180">
    <circle cx="90" cy="90" r="${R}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="14"/>
    <circle cx="90" cy="90" r="${R}" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${CIRC.toFixed(1)}"/>
  </svg><div class="n"><b>${score}</b><small>/ 100</small></div></div>
  <div class="info"><span class="band">${esc(band)}</span><h1>${esc(name)}: ${esc(headline)}</h1><p>${esc(r.summary || '')}</p></div>
</div>
${fixes.length ? `<h2>Top fixes</h2>${fixes.map((f: any) => `<div class="fix"><h3>${esc(f.title || f.h || '')}</h3><p>${esc(f.why || f.p || f.detail || '')}</p></div>`).join('')}` : ''}
<a class="cta" href="${origin}/">Run your own free audit &rarr;</a>
<footer>AuditRank measures how ready a page is to be cited by AI assistants. Scores reflect AI-citability, not a site's size or fame.</footer>
</div></body></html>`;
}
