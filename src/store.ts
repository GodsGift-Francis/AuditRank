import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lightweight, zero-dependency persistence keyed by website host. Stores a small
// snapshot per audit so we can compare week over week. For scale, swap the read/
// write here for Postgres (the API surface stays the same).

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data');
const FILE = resolve(DATA_DIR, 'audits.json');

export interface Snapshot { at: string; score: number; band: string; signals: Record<string, number>; }
export interface SiteRecord { key: string; name: string; website: string; snapshots: Snapshot[]; }
type DB = Record<string, SiteRecord>;

const DEDUPE_MS = 12 * 60 * 60 * 1000; // collapse repeat audits within 12h into one point

export function siteKey(website: string): string {
  try { return new URL(website.startsWith('http') ? website : 'https://' + website).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase(); }
}

function load(): DB {
  try { if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8')) as DB; } catch { /* ignore */ }
  return {};
}
function persist(db: DB) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(db, null, 2));
}

export function saveSnapshot(name: string, website: string, score: number, band: string, signals: Record<string, number>): SiteRecord {
  const db = load();
  const key = siteKey(website);
  const rec = db[key] || { key, name, website, snapshots: [] };
  rec.name = name || rec.name;
  rec.website = website || rec.website;
  const snap: Snapshot = { at: new Date().toISOString(), score, band, signals };
  const last = rec.snapshots[rec.snapshots.length - 1];
  if (last && Date.now() - new Date(last.at).getTime() < DEDUPE_MS) rec.snapshots[rec.snapshots.length - 1] = snap; // replace recent
  else rec.snapshots.push(snap);
  if (rec.snapshots.length > 60) rec.snapshots = rec.snapshots.slice(-60);
  db[key] = rec;
  persist(db);
  return rec;
}

export function getHistory(website: string): Snapshot[] {
  const db = load();
  return db[siteKey(website)]?.snapshots || [];
}

export function listSites(): { key: string; name: string; website: string; latest: number; prev: number | null; at: string }[] {
  const db = load();
  return Object.values(db).map(r => {
    const s = r.snapshots;
    return { key: r.key, name: r.name, website: r.website, latest: s[s.length - 1]?.score ?? 0, prev: s.length > 1 ? s[s.length - 2].score : null, at: s[s.length - 1]?.at || '' };
  }).sort((a, b) => (b.at > a.at ? 1 : -1));
}

export function allSiteRecords(): SiteRecord[] { return Object.values(load()); }

/** Compare the two most recent snapshots into a plain winning/losing verdict. */
export function computeDelta(snaps: Snapshot[]): { score: number; verdict: 'Winning' | 'Slipping' | 'Holding' | 'First audit'; since: string; movers: { id: string; change: number }[] } | null {
  if (!snaps.length) return null;
  if (snaps.length === 1) return { score: 0, verdict: 'First audit', since: snaps[0].at, movers: [] };
  const cur = snaps[snaps.length - 1], prev = snaps[snaps.length - 2];
  const d = cur.score - prev.score;
  const verdict = d >= 3 ? 'Winning' : d <= -3 ? 'Slipping' : 'Holding';
  const movers: { id: string; change: number }[] = [];
  for (const id of Object.keys(cur.signals)) {
    const ch = (cur.signals[id] || 0) - (prev.signals[id] || 0);
    if (ch !== 0) movers.push({ id, change: ch });
  }
  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return { score: d, verdict, since: prev.at, movers: movers.slice(0, 4) };
}
