import { analyze } from '../src/analyze.js';
import { assembleReport, buildKit } from '../src/score.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
