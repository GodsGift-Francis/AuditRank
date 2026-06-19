# AuditRank — web app (zero-key)

A self-hostable **web application** for AI search-visibility audits. No API keys,
no browser CORS hacks: the **server** fetches the target site directly, analyzes
it, scores it, and returns a concrete fix plan. The front end is a branded SPA
that calls the API.

## Why this beats the standalone HTML

| | Standalone HTML tool | This web app |
|---|---|---|
| Reads the site | Browser via public CORS proxies (flaky) | **Server-side direct fetch** (reliable) |
| Images / schema / meta | Missed when proxies fail | **Always seen** (real HTML) |
| API keys | None | None |
| Deploy | A file | A real service (Cloud Run, VPS, Docker) |

## Run it

```bash
npm install
npm start
# → http://localhost:3000
```

Open the URL, enter a business name + website, and you get a live audit. No keys.

Dev with auto-reload: `npm run dev`.

## API

- `POST /api/audit` `{ name, website }` → full report (server reads + analyzes the site)
- `POST /api/audit-html` `{ name, website, html }` → analyze pasted HTML (recovery path)
- `POST /api/score` `{ name, website, answers }` → recompute score + fixes (used by the
  one-tap refine of off-site signals, and by self-assessment)
- `GET /api/health`

The report includes: `score`, `band`, `headline`, per-signal `signals`, detected
`findings`, a prioritized `fixes` plan, and ready-to-paste `faq` + `faqSchema` +
`bizSchema`. The **fix plan is the point** — every gap maps to a concrete action.

## Deploy to Cloud Run

```bash
gcloud run deploy auditrank --source . --allow-unauthenticated --region us-central1
```

The included `Dockerfile` listens on `$PORT` (8080 in the container). Works on any
Node 18+ host or container platform.

## How it fits your funnel

- This app is the **product** users run (free, zero-key) — the lead magnet that
  shows real value instantly.
- The separate `auditrank-engine` is the **paid, monitored backend** (ground-truth
  multi-engine tracking) that needs keys; this app can call it for premium audits.
- Next: a **WordPress one-click-fix plugin** that consumes `faqSchema` / `bizSchema`
  and pushes the fixes straight into a client's site.

## Files

```
src/
  server.ts      Express API + static host
  fetchSite.ts   server-side fetch (+ robots.txt / sitemap.xml)
  analyze.ts     cheerio signal detection (FAQ, schema, facts, freshness,
                 identity, conversational, technical, images, crawlability)
  score.ts       scoring + fix engine + FAQ/schema generation
  types.ts
public/
  index.html  styles.css  app.js     branded SPA
Dockerfile
```

## Notes

- Off-site signals (reviews/mentions, Google Business Profile) can't be read from a
  page without paid data, so they start uncounted and the user confirms them with a
  one-tap toggle that recomputes the score live — honest by design.
- If a site blocks automated reads, the app offers a **paste-HTML** recovery path so
  the user always gets a real analysis.

---

## Monitoring (saved audits + weekly re-scan + winning/losing)

No accounts. Every analyzed audit is saved per website (by host) and the app
re-checks tracked sites weekly so a user can see if they are winning or losing.

- Each audit stores a small snapshot (score, band, per-signal scores, timestamp)
  in `data/audits.json`. Repeat audits within 12h collapse into one point.
- The results page shows a **Visibility over time** card: a Winning / Slipping /
  Holding verdict, the point change since the last audit, a sparkline of past
  scores, and the biggest moving signals.
- `GET /dashboard` lists every tracked site with its latest score and last change.

### Endpoints (Sprint B)
- `GET  /api/history?website=...` snapshots + delta for one site
- `GET  /api/sites` all tracked sites (powers /dashboard)
- `POST /api/cron/rescan` re-scan every site due (older than 7 days)

### Re-scan: two ways
- **Always-on host (VPS / container that stays up):** the internal scheduler runs
  every 6h and re-scans due sites automatically. Nothing to configure.
- **Cloud Run (scales to zero, so timers do not fire):** hit the cron endpoint with
  Cloud Scheduler weekly:
  ```
  gcloud scheduler jobs create http auditrank-weekly \
    --schedule="0 6 * * 1" \
    --uri="https://YOUR-APP.run.app/api/cron/rescan" \
    --http-method=POST \
    --headers="x-rescan-token=YOUR_TOKEN"
  ```
  Set `RESCAN_TOKEN` in the service env to require that header.

For real scale, swap the JSON file in `src/store.ts` for Postgres (your stack) —
the function signatures stay the same.

---

## Sprint: AI-crawler readiness + evidence layer + live theater + security

**F1 - AI-crawler readiness (the gate to AI visibility).** The audit now reads your
robots.txt and reports, per bot, whether GPTBot, ChatGPT-User, OpenAI Search,
ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended and CCBot are allowed
or blocked, and whether you serve an `llms.txt`. If a crawler is blocked, that engine
literally cannot read or recommend you, so this is the most direct factual signal we
can measure without keys. It also factors into the technical score.

**F2 - Evidence + confidence layer.** Every finding now carries the exact evidence it
was based on (the schema types found, image counts, the numbers detected) plus a
status chip (detected / inferred / unverified) and a confidence level. The report
also reports an overall read confidence. Nothing is a black box; users can verify.

**V1 - Live audit theater.** `GET /api/audit/stream` runs the audit over Server-Sent
Events, streaming each step and each finding as it happens. The UI shows a live
checklist with animated ticks, then renders the full dashboard. Falls back to the
plain `POST /api/audit` automatically if a proxy buffers the stream.

**G2 - Security + rate limiting.** The server now refuses SSRF targets (private and
link-local IPs, cloud metadata endpoints, non-http schemes) by resolving the host
before fetching, caps response size, and applies a per-IP rate limit. Essential once
this is public.

All of the above is no-key and runs server-side.

---

## Sprint: fix kit, real performance, regression tests, alerts, scale notes

**A2 - Generated fix kit.** Every analyzed report now ships a downloadable kit:
FAQ schema, LocalBusiness schema, a generated `llms.txt`, a `robots.txt` AI-allow
snippet, and the FAQ answers, plus "Download all" as one markdown file. The engine
does not just report problems, it hands you the files to fix them.

**F5 - Real performance.** The server times the actual HTML fetch and reports the
measured response time as a finding (with evidence), instead of guessing.

**A3 - Accuracy regression suite.** `npm test` runs golden HTML fixtures through the
analyzer and asserts expected detections, AI-crawler parsing, score ranges, and that
the 9 signal weights always sum to 100. Run it on every change so detection never
silently regresses. Current status: 29 checks, all passing.

**A1 - Alerts.** During a weekly re-scan, if a site's verdict becomes Winning or
Slipping, the app POSTs to `ALERT_WEBHOOK` (Slack-compatible JSON) if that env var is
set. Best-effort, never blocks the scan.

**G5 - Version endpoint.** `GET /api/version` reports the build and enabled features.

### G1 - Scaling the store to Postgres

The file store in `src/store.ts` is fine for modest volume. For scale, keep the same
function signatures and back them with Postgres. Schema:

```sql
CREATE TABLE site_snapshots (
  id        bigserial PRIMARY KEY,
  site_key  text NOT NULL,
  name      text NOT NULL,
  website   text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  score     int  NOT NULL,
  band      text NOT NULL,
  signals   jsonb NOT NULL
);
CREATE INDEX ON site_snapshots (site_key, at DESC);
```

Drop-in adapter (`npm i pg`, then import from here instead of `./store.js`):

```ts
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function saveSnapshot(name, website, score, band, signals) {
  const key = siteKey(website);
  // 12h dedupe: replace the latest row if it is recent, else insert
  const { rows } = await pool.query(
    'SELECT id, at FROM site_snapshots WHERE site_key=$1 ORDER BY at DESC LIMIT 1', [key]);
  const recent = rows[0] && (Date.now() - new Date(rows[0].at).getTime() < 12*3600*1000);
  if (recent) await pool.query('UPDATE site_snapshots SET score=$1,band=$2,signals=$3,at=now() WHERE id=$4',
    [score, band, signals, rows[0].id]);
  else await pool.query('INSERT INTO site_snapshots(site_key,name,website,score,band,signals) VALUES($1,$2,$3,$4,$5,$6)',
    [key, name, website, score, band, signals]);
}
export async function getHistory(website) {
  const { rows } = await pool.query(
    'SELECT at, score, band, signals FROM site_snapshots WHERE site_key=$1 ORDER BY at ASC', [siteKey(website)]);
  return rows;
}
```

`computeDelta` and the verdict logic stay unchanged. For caching and queued audits,
put Redis in front of `fetchSite` (cache by URL with a short TTL) and run audits via a
worker queue; the audit code path (`runAudit`) already takes a callback so it can run
inside a job.

### Still ahead (need infra or are larger UI work)
G3 multi-region + CDN, G4 internationalization, V3 shareable OG report image,
V4 advanced data-viz, F3 entity presence via Wikidata (needs outbound network),
F4 site-wide multi-page crawl.

---

## Sprint: multi-page crawl + honest score framing

**Sprint 2 / F4 - multi-page crawl.** An audit no longer judges a site by one URL.
It reads the homepage, discovers key pages from the sitemap and on-page navigation
(About, services, products, articles, etc.), scans up to five pages total, scores
each, and headlines the strongest representative page. The results show every page
scanned with its score so the verdict is transparent. This fixes the case where a
thin homepage (for example a search box) made a real business look invisible.

**Sprint 1 - page-type awareness + framing.** Each page is classified (home,
article, product, search-tool, thin). The score is now labelled "AI-citability
readiness" with a one-line explanation that it measures how ready a page is to be
cited by AI, not a site's size or fame. When the strongest page is still thin or a
search tool, the result says so plainly and points the user at a content page. This
removes the false impression that a low score means a bad or unimportant site.

Why a giant like google.com can still score low: its pages are tools, not citable
content, so a low AI-citability score is correct. The fixes above make that result
representative (multi-page) and clearly explained (framing), rather than misleading.

---

## Sprint: off-page authority + calibration & benchmarks

**Sprint 3 - off-page authority (free, no-key).** Beyond on-page structure, the audit
now gathers real-world recognition signals: entity presence in Wikidata, domain age
via RDAP, and indexable scale from the sitemap, shown in an "Off-page authority" card
with evidence and confidence. A recognized knowledge-graph entity counts toward the
"earned mentions" signal, so genuinely authoritative brands are credited for it. All
calls are best-effort with a short timeout and fail safe: if a source is unreachable,
the audit still completes and the score is unaffected. (In a network-restricted
environment the entity/domain lookups return empty, which is expected; the sitemap
scale signal still works since it needs no extra network.)

**Sprint 4 - calibration & benchmarks.** Each result now shows a typical range for its
page type (for example, an article page typically scores 40-65) and whether the page
is below, within, or above that range, so a number is read in context instead of in
isolation. The regression suite gained calibration-band checks that assert
representative pages land in their expected ranges, so scoring cannot silently drift.
Suite is now 48 checks, all passing.

Net effect on the original concern: a real business is judged across multiple pages
(F4), credited for genuine authority (entity recognition), framed honestly about what
the score means, and shown against a peer benchmark. A site like google.com may still
score low because its pages are tools rather than citable content, which is correct,
but the result is now representative and clearly explained rather than misleading.
