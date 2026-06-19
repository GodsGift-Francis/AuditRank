import { analyze, discoverPages } from '../src/analyze.js';
import { assembleReport, buildKit } from '../src/score.js';
import { applyAuthority, siteScale } from '../src/authority.js';
import { suggestPrompts } from '../src/audit.js';
import { buildShareCard, buildSharePage } from '../src/share.js';
import { saveSharedReport, getSharedReport, upsertMonitor, getMonitor, stopMonitor } from '../src/store.js';
import { shouldAlert, buildAlertText, isSafeWebhook } from '../src/alerts.js';

// Golden-fixture regression tests (A3). Run: npm test
// These lock the analyzer's behavior so detection never silently regresses.

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- Fixture 1: a strong, AI-ready page ----
const strong = `<!doctype html><html><head>
<title>Acme Roofing — Accra's trusted roofers</title>
<meta name="description" content="Acme Roofing installs and repairs roofs in Accra. From GHS 5,000. Family-owned since 2009.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Acme Roofing"}</script>
</head><body>
<h1>Acme Roofing</h1>
<h2>How much does a new roof cost?</h2><p>From GHS 5,000. Most jobs run GHS 8,000 to GHS 25,000 depending on size.</p>
<h2>What areas do you serve?</h2><p>We serve Accra, Tema and Kasoa.</p>
<h2>Do you offer a warranty?</h2><p>Yes, a 10 year workmanship warranty on every install.</p>
<h2>How long does installation take?</h2><p>Typically 2 to 4 days for a standard home.</p>
<p>We have completed 1,200 roofs across 3 regions with a 98% satisfaction rate over 17 years, on jobs from 50 to 500 square metres.</p>
<a href="/about">About us</a> <a href="mailto:hi@acme.test">Email</a> <a href="tel:+233200000000">Call</a>
<p>123 Independence Avenue, Accra. Last updated 2026.</p>
<img src="a.jpg" alt="A finished roof"><img src="b.jpg" alt="Our team">
</body></html>`;

const d1 = analyze(strong, 'https://acme.test', "User-agent: *\nAllow: /\nSitemap: https://acme.test/sitemap.xml", '<urlset></urlset>', '# Acme', 420);
check('strong: FAQ detected', d1.answers.faq === 'yes', `got ${d1.answers.faq}`);
check('strong: schema yes', d1.answers.schema === 'yes', `got ${d1.answers.schema}`);
check('strong: facts yes', d1.answers.facts === 'yes', `got ${d1.answers.facts}`);
check('strong: identity yes', d1.answers.identity === 'yes', `got ${d1.answers.identity}`);
check('strong: all AI bots allowed', d1.aiAccess.majorBlocked === 0, `blocked ${d1.aiAccess.majorBlocked}`);
check('strong: llms.txt present', d1.aiAccess.llmsTxt === true);
check('strong: perf finding present', d1.findings.some(f => /responded in/.test(f.t)));
check('strong: every finding has evidence+confidence', d1.findings.every(f => !!f.ev && !!f.conf && !!f.status));
const r1 = assembleReport({ name: 'Acme Roofing', website: 'https://acme.test' }, d1, 'analyzed', true);
check('strong: score is strong (>=55)', r1.score >= 55, `score ${r1.score}`);
check('strong: kit has llms.txt + robots', !!r1.kit && r1.kit.llmsTxt.includes('Acme Roofing') && /User-agent: GPTBot/.test(r1.kit.robotsSnippet));

// ---- Fixture 2: a weak page that BLOCKS AI crawlers ----
const weak = `<!doctype html><html><head><title>x</title></head><body><h1>Welcome</h1><p>We do stuff.</p></body></html>`;
const blockingRobots = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /";
const d2 = analyze(weak, 'http://weak.test', blockingRobots, null, null, 1200);
check('weak: FAQ not detected', d2.answers.faq === 'no', `got ${d2.answers.faq}`);
check('weak: schema no', d2.answers.schema === 'no', `got ${d2.answers.schema}`);
check('weak: 2 major AI bots blocked', d2.aiAccess.majorBlocked === 2, `blocked ${d2.aiAccess.majorBlocked}`);
check('weak: GPTBot shown blocked', d2.aiAccess.bots.some(b => /GPTBot/.test(b.name) && !b.allowed));
check('weak: no llms.txt', d2.aiAccess.llmsTxt === false);
const r2 = assembleReport({ name: 'Weak Co', website: 'http://weak.test' }, d2, 'analyzed', true);
check('weak: score is low (<45)', r2.score < 45, `score ${r2.score}`);
check('weak: score lower than strong', r2.score < r1.score);

// ---- Fixture 3: robots parser edge cases ----
const d3 = analyze(weak, 'https://x.test', "User-agent: *\nDisallow: /", null, null, 100);
check('robots: blanket disallow blocks all majors', d3.aiAccess.majorBlocked === 4, `blocked ${d3.aiAccess.majorBlocked}`);
const d4 = analyze(weak, 'https://y.test', null, null, null, 100);
check('robots: no robots.txt => all allowed', d4.aiAccess.majorBlocked === 0);

// ---- Fixture 4: scores always in range, signals sum to <=100 ----
for (const d of [d1, d2, d3, d4]) {
  const r = assembleReport({ name: 'T', website: 'https://t.test' }, d, 'analyzed', true);
  check(`score in 0..100 (${r.score})`, r.score >= 0 && r.score <= 100);
  const maxSum = r.signals.reduce((a, s) => a + (s.max || 0), 0);
  check('signal max sum == 100', maxSum === 100, `sum ${maxSum}`);
}

// ---- Fixture 5: self-assess mode (no detection) still builds a kit + schema ----
const rs = assembleReport({ name: 'Solo Biz', website: 'https://solo.test' }, null, 'self', false);
check('self: produces faq schema', /FAQPage/.test(rs.faqSchema));
check('self: produces kit', !!rs.kit && rs.kit.llmsTxt.includes('Solo Biz'));

// ---- Fixture 6: page-type classification (Sprint 1) ----
check('strong page typed as content (home)', d1.pageType === 'home', d1.pageType);
const ds = analyze('<html><head><title>Search</title><meta name="viewport" content="x"></head><body><form role="search"><input name="q"></form><a href="/about">About</a></body></html>', 'https://s.test', null, null, null, 100);
check('search-box page typed search-tool', ds.pageType === 'search-tool', ds.pageType);
const dt = analyze('<html><head><title>x</title></head><body><h1>Hi</h1><p>Short.</p></body></html>', 'https://t.test', null, null, null, 100);
check('thin page typed thin', dt.pageType === 'thin', dt.pageType);

// ---- Fixture 7: page discovery for multi-page crawl (Sprint 2 / F4) ----
const navHtml = '<html><body><a href="/about">About</a><a href="/services">Services</a><a href="https://other.test/x">ext</a><a href="/logo.png">img</a><a href="#top">anchor</a><a href="mailto:a@b.com">mail</a></body></html>';
const sm = '<urlset><url><loc>https://acme.test/</loc></url><url><loc>https://acme.test/faq</loc></url><url><loc>https://acme.test/blog/post-1</loc></url></urlset>';
const found = discoverPages(navHtml, sm, 'https://acme.test/');
check('discover: finds same-site pages', found.length >= 3, 'got ' + found.length);
check('discover: excludes the homepage itself', !found.includes('https://acme.test') && !found.includes('https://acme.test/'), found.join(','));
check('discover: excludes external host', !found.some(u => /other\.test/.test(u)));
check('discover: excludes image/asset files', !found.some(u => /logo\.png/.test(u)));
check('discover: excludes mailto/anchors', !found.some(u => /^mailto:|#/.test(u)));
check('discover: prioritizes key pages first', /faq|about|service|blog/i.test(found[0] || ''), found[0]);

// ---- Fixture 8: off-page authority fold (Sprint 3) ----
const dEnt = analyze(strong, 'https://acme.test', 'User-agent: *\nAllow: /', '<urlset></urlset>', null, 300);
const entBefore = assembleReport({ name: 'Acme', website: 'https://acme.test' }, dEnt, 'analyzed', true).score;
applyAuthority(dEnt.answers, { entity: { found: true, title: 'Acme' }, domainAgeYears: 10, indexablePages: 120, tier: 'high', findings: [] });
const entAfter = assembleReport({ name: 'Acme', website: 'https://acme.test' }, dEnt, 'analyzed', true).score;
check('authority: recognized entity raises score', entAfter > entBefore, `before ${entBefore} after ${entAfter}`);
check('authority: entity counts toward mentions', dEnt.answers.mentions === 'yes');
const dNo = analyze(strong, 'https://acme.test', null, null, null, 300);
const noBefore = assembleReport({ name: 'Acme', website: 'https://acme.test' }, dNo, 'analyzed', true).score;
applyAuthority(dNo.answers, { entity: { found: false }, domainAgeYears: null, indexablePages: null, tier: 'unknown', findings: [] });
const noAfter = assembleReport({ name: 'Acme', website: 'https://acme.test' }, dNo, 'analyzed', true).score;
check('authority: no entity leaves score unchanged', noBefore === noAfter, `${noBefore} vs ${noAfter}`);
check('siteScale: counts sitemap locs', siteScale('<urlset><loc>a</loc><loc>b</loc></urlset>') === 2);
check('siteScale: null without sitemap', siteScale(null) === null);

// ---- Fixture 9: benchmark + calibration bands (Sprint 4) ----
check('benchmark: present on report', !!r1.benchmark && r1.benchmark.low > 0);
check('benchmark: verdict computed', ['below', 'within', 'above'].includes(r1.benchmark!.verdict));
check('benchmark: strong home page reads above typical', r1.benchmark!.pageType === 'home' && r1.benchmark!.verdict === 'above', JSON.stringify(r1.benchmark));
const rThin = assembleReport({ name: 'X', website: 'https://thin.test' }, analyze('<html><head><title>x</title></head><body><h1>Hi</h1><p>We do stuff here.</p></body></html>', 'https://thin.test', null, null, null, 100), 'analyzed', true);
check('calibration: thin page scores low (<=30)', rThin.score <= 30, `${rThin.score}`);
check('calibration: thin benchmark band', rThin.benchmark!.pageType === 'thin' && rThin.benchmark!.low === 10, JSON.stringify(rThin.benchmark));

// ---- Fixture 10: prompt intelligence (suggestPrompts) ----
const prompts = suggestPrompts('Acme Roofing', 'roof repair and installation', 'Accra');
check('prompts: returns a set to test', prompts.length === 5, `${prompts.length}`);
check('prompts: include the business name', prompts.some(p => p.includes('Acme Roofing')));
check('prompts: use the location when known', prompts.some(p => p.includes('Accra')));
const promptsBare = suggestPrompts('Solo Biz', '', '');
check('prompts: degrade gracefully with no profile', promptsBare.length === 5 && promptsBare.every(p => p.length > 0));

// ---- Fixture 11: shareable report (V3) ----
const shareRep = assembleReport({ name: 'Acme Co', website: 'https://acme.test' }, d1, 'analyzed', true);
const card = buildShareCard(shareRep);
check('share card: svg with the score', card.startsWith('<svg') && card.includes('</svg>') && card.includes('>' + shareRep.score + '</text>'), `score ${shareRep.score}`);
const page = buildSharePage('abc123', shareRep, 'https://x.test');
check('share page: has OG image, title and business name', page.includes('property="og:image"') && page.includes('property="og:title"') && page.includes('Acme Co'));
const sid = saveSharedReport(shareRep);
check('share store: round-trips by id', !!getSharedReport(sid) && getSharedReport(sid).score === shareRep.score);
check('share store: rejects path-like ids', getSharedReport('../secret') === null);

// ---- Fixture 12: monitoring + alerts ----
check('alert: a real drop fires', shouldAlert(60, 50).fire === true && shouldAlert(60, 50).kind === 'drop');
check('alert: noise below threshold stays quiet', shouldAlert(60, 58).fire === false);
check('alert: gains suppressed by default', shouldAlert(50, 60).fire === false);
check('alert: gains fire when opted in', shouldAlert(50, 60, { notifyGains: true }).kind === 'gain');
check('alert: first run (no prev) does not fire', shouldAlert(null, 50).fire === false);
check('alert: text carries name + score', /Acme/.test(buildAlertText({ website: 'x.com', name: 'Acme', score: 50, prevScore: 60, delta: -10, kind: 'drop', at: '' })));
check('webhook guard: blocks localhost', isSafeWebhook('http://localhost/x') === false);
check('webhook guard: blocks metadata IP', isSafeWebhook('http://169.254.169.254/') === false);
check('webhook guard: blocks private 10.x', isSafeWebhook('https://10.0.0.5/hook') === false);
check('webhook guard: allows public https', isSafeWebhook('https://hooks.slack.com/services/x') === true);
const mon = upsertMonitor({ website: 'https://watch.test', name: 'Watch Co', cadence: 'daily', webhook: 'https://hooks.slack.com/x' });
check('monitor: upsert + get by site', getMonitor('https://watch.test')?.cadence === 'daily' && mon.enabled === true);
check('monitor: stop disables it', stopMonitor('https://watch.test') === true && getMonitor('https://watch.test')?.enabled === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
