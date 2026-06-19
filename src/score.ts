import { SIGNALS, type Ans, type Business, type Detection, type Fix, type Report, type SignalScore } from './types.js';

const FIXMAP: Record<string, { title: string; why: string; action: string }> = {
  faq: { title: 'Publish a real FAQ page', why: 'FAQ pages get cited more than any other format in AI answers.', action: 'Answer your 8–10 most-asked buying questions, each as a clear question heading with a direct 2–3 sentence answer. Add the FAQ schema below.' },
  schema: { title: 'Add structured data (schema)', why: 'Schema lets AI read and trust your facts.', action: 'Paste the FAQ + business JSON-LD generated below into your site\'s <head>, then validate it with Google\'s Rich Results Test.' },
  facts: { title: 'Put real numbers on your pages', why: 'AI quotes concrete facts, not adjectives.', action: 'Replace vague claims with specifics — prices, timelines, warranty length, years in business, jobs completed.' },
  mentions: { title: 'Earn third-party mentions & reviews', why: 'AI leans on what others say about you — often more than your own pages.', action: 'Get listed in your top industry directories, start a steady review request, and seek a few independent mentions.' },
  fresh: { title: 'Add "last updated" dates & refresh', why: 'Recently updated pages are cited far more often.', action: 'Stamp key pages with a visible update date and refresh core content at least quarterly.' },
  identity: { title: 'Make your identity unmistakable', why: 'AI favours clear, trustworthy entities.', action: 'Add a strong About page, a named owner/author, and consistent business name + phone + email + address across the site.' },
  convo: { title: 'Write in plain question-and-answer language', why: 'AI matches how people actually ask out loud.', action: 'Lead key sections with the real customer question as a heading, then answer it directly in the first sentence.' },
  gbp: { title: 'Complete your Google Business Profile', why: 'It\'s a primary source for local "near me" AI answers.', action: 'Claim and fully complete your profile — categories, services, hours, photos — and respond to reviews.' },
  tech: { title: 'Fix the technical basics', why: 'If engines can\'t crawl you cleanly, nothing else can help.', action: 'Ensure HTTPS, a mobile layout, a page title + meta description, real HTML text, and no accidental noindex.' },
};
const QUICK = new Set(['faq', 'schema', 'facts', 'fresh', 'gbp']);

function bandFor(s: number): Report['band'] { return s >= 80 ? 'Cited' : s >= 60 ? 'Visible' : s >= 35 ? 'Emerging' : 'Invisible'; }
function headlineFor(s: number) { return s >= 80 ? "You're the answer." : s >= 60 ? "You're visible — but not winning." : s >= 35 ? "You're barely on AI's radar." : "AI can't see you yet."; }

export function score(business: Business, answers: Record<string, Ans>, mode: 'analyzed' | 'self', read: boolean): {
  score: number; band: Report['band']; headline: string; summary: string; signals: SignalScore[]; fixes: Fix[];
} {
  let total = 0, max = 0;
  const signals: SignalScore[] = SIGNALS.map(s => {
    const a = answers[s.id] || 'no';
    const f = a === 'yes' ? 1 : a === 'partial' ? 0.5 : 0;
    const got = Math.round(s.w * f);
    total += got; max += s.w;
    return { id: s.id, name: s.name, score: got, max: s.w, note: noteFor(s.id, a, mode) };
  });
  const sc = Math.round((total / max) * 100);
  const gaps = SIGNALS.filter(s => (answers[s.id] || 'no') !== 'yes');
  gaps.sort((x, y) => (QUICK.has(x.id) ? 0 : 1) - (QUICK.has(y.id) ? 0 : 1) || y.w - x.w);
  const fixes: Fix[] = gaps.slice(0, 6).map((s, i) => ({
    title: FIXMAP[s.id].title, why: FIXMAP[s.id].why, action: FIXMAP[s.id].action,
    effort: QUICK.has(s.id) ? 'Quick win' : 'Medium', priority: i + 1,
  }));
  const site = business.website ? business.website.replace(/^https?:\/\//, '') : 'your site';
  const summary = mode === 'analyzed'
    ? `We read ${site} and scored ${business.name} on the on-page signals AI uses to choose who to recommend. Two off-site signals (reviews/mentions, Google profile) start uncounted — add them below to refine. ${sc >= 60 ? 'You\u2019re in decent shape; the fixes below sharpen your edge.' : 'The fixes below, quickest wins first, move you up fast.'}`
    : `Self-assessment for ${business.name}. Add your website to auto-detect your on-page signals.`;
  return { score: sc, band: bandFor(sc), headline: headlineFor(sc), summary, signals, fixes };
}

function noteFor(id: string, a: Ans, mode: string): string {
  if (mode !== 'analyzed') return '';
  if (id === 'mentions' || id === 'gbp') return a === 'no' ? 'Off-site — confirm to add.' : '';
  return a === 'yes' ? 'Detected on your site.' : a === 'partial' ? 'Partly present.' : 'Not detected — opportunity.';
}

export function starterFAQ(business: Business): { q: string; a: string }[] {
  const n = business.name; const site = business.website ? business.website.replace(/^https?:\/\//, '') : 'your site';
  return [
    { q: `What does ${n} offer?`, a: `${n} provides [your main services] in [your city/area]. Replace this with one specific, factual sentence — what you do and where.` },
    { q: `How much does it cost / how do I get a quote from ${n}?`, a: `State a starting price or a clear "from $X" range, and how to get a quote. Concrete numbers are exactly what AI quotes.` },
    { q: `Why choose ${n}?`, a: `${n} stands out for [your differentiator] — add a concrete fact such as years in business, a guarantee, or results. Contact details and hours live at ${site}.` },
  ];
}

export function buildSchemas(business: Business, profile: { what: string; city: string; country: string }, faq: { q: string; a: string }[]) {
  const faqLd = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(o => ({ '@type': 'Question', name: o.q, acceptedAnswer: { '@type': 'Answer', text: o.a } })) };
  const biz: any = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: business.name };
  if (profile.what) biz.description = profile.what;
  if (business.website) biz.url = business.website.startsWith('http') ? business.website : 'https://' + business.website;
  biz.address = { '@type': 'PostalAddress' };
  if (profile.city) biz.address.addressLocality = profile.city;
  if (profile.country) biz.address.addressCountry = profile.country;
  const wrap = (o: any) => `<script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n</script>`;
  return { faqSchema: wrap(faqLd), bizSchema: wrap(biz) };
}

export function buildKit(business: Business, profile: { what: string; city: string; country: string }, faq: { q: string; a: string }[]) {
  const site = business.website ? (business.website.startsWith('http') ? business.website : 'https://' + business.website) : '';
  const desc = profile.what || `${business.name} information.`;
  const llmsTxt = [
    `# ${business.name}`,
    '',
    `> ${desc}`,
    '',
    '## About',
    `- Name: ${business.name}`,
    site ? `- Website: ${site}` : '',
    profile.city ? `- Location: ${profile.city}${profile.country ? ', ' + profile.country : ''}` : '',
    '',
    '## Key questions',
    ...faq.map(f => `- [${f.q}](${site || ''})`),
    '',
    '## Notes',
    '- This file follows the llms.txt convention to help AI assistants understand the site.',
  ].filter(l => l !== null && l !== undefined).join('\n');
  const aiBots = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'anthropic-ai', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot'];
  const robotsSnippet = aiBots.map(b => `User-agent: ${b}\nAllow: /`).join('\n\n') + (site ? `\n\nSitemap: ${site.replace(/\/$/, '')}/sitemap.xml` : '');
  return { llmsTxt, robotsSnippet };
}

export function assembleReport(business: Business, detection: Detection | null, mode: 'analyzed' | 'self', read: boolean): Report {
  const answers: Record<string, Ans> = {};
  const unverified: string[] = [];
  if (detection) {
    for (const s of SIGNALS) { const v = detection.answers[s.id]; if (v == null) { unverified.push(s.id); answers[s.id] = 'no'; } else answers[s.id] = v; }
  } else { for (const s of SIGNALS) answers[s.id] = 'no'; }
  const sc = score(business, answers, mode, read);
  const faq = starterFAQ(business);
  const { faqSchema, bizSchema } = buildSchemas(business, detection?.profile || { what: '', city: '', country: '' }, faq);
  const kit = buildKit(business, detection?.profile || { what: '', city: '', country: '' }, faq);
  const BENCH: Record<string, [number, number]> = { 'search-tool': [5, 25], thin: [10, 30], home: [30, 55], product: [35, 60], article: [40, 65] };
  const pt = detection?.pageType || 'home';
  const band = BENCH[pt] || BENCH.home;
  const benchmark = { pageType: pt, low: band[0], high: band[1], verdict: (sc.score < band[0] ? 'below' : sc.score > band[1] ? 'above' : 'within') as 'below' | 'within' | 'above' };
  return {
    ok: true, mode, read, business,
    score: sc.score, band: sc.band, headline: sc.headline, summary: sc.summary,
    signals: sc.signals, answers, unverified,
    findings: detection?.findings || [], fixes: sc.fixes, faq, faqSchema, bizSchema, kit, benchmark,
    aiAccess: detection?.aiAccess, confidence: detection?.confidence,
  };
}
