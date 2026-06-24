import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Lightweight, zero-dependency persistence keyed by website host. Stores a small
// snapshot per audit so we can compare week over week. For scale, swap the read/
// write here for Postgres (the API surface stays the same).
//
// Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt the
// data file. Note: file I/O here is synchronous, so reads and writes are already
// serialized within a single process; multi-process deployments should use Postgres.

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data');
const FILE = resolve(DATA_DIR, 'audits.json');

/** Write JSON atomically: a crash during the write leaves the old file intact. */
function writeAtomic(file: string, contents: string) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

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
function persist(db: DB) { writeAtomic(FILE, JSON.stringify(db, null, 2)); }

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

// --- shareable reports (V3): persist a full report under a short id ---
const SHARE_FILE = resolve(DATA_DIR, 'shared.json');
type ShareDB = Record<string, { at: string; report: any }>;
function loadShares(): ShareDB { try { if (existsSync(SHARE_FILE)) return JSON.parse(readFileSync(SHARE_FILE, 'utf8')) as ShareDB; } catch { /* ignore */ } return {}; }
function persistShares(db: ShareDB) { writeAtomic(SHARE_FILE, JSON.stringify(db)); }

export function saveSharedReport(report: any): string {
  const db = loadShares();
  const gen = () => (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(0, 8);
  let id = gen();
  while (id.length < 6 || db[id]) id = gen();
  db[id] = { at: new Date().toISOString(), report };
  const ids = Object.keys(db);
  if (ids.length > 500) { ids.sort((a, b) => (db[a].at < db[b].at ? -1 : 1)); for (const k of ids.slice(0, ids.length - 500)) delete db[k]; }
  persistShares(db);
  return id;
}
export function getSharedReport(id: string): any | null {
  if (!/^[a-z0-9]{4,16}$/i.test(id)) return null;
  return loadShares()[id]?.report || null;
}

// --- monitoring: per-site re-scan schedule + alert destinations ---
const MON_FILE = resolve(DATA_DIR, 'monitors.json');
export interface Monitor {
  key: string; website: string; name: string;
  cadence: 'daily' | 'weekly' | 'monthly';
  webhook?: string; email?: string;
  enabled: boolean; createdAt: string;
  lastRunAt?: string; lastAlertAt?: string; lastAlertScore?: number;
}
type MonDB = Record<string, Monitor>;
function loadMonitors(): MonDB { try { if (existsSync(MON_FILE)) return JSON.parse(readFileSync(MON_FILE, 'utf8')) as MonDB; } catch { /* ignore */ } return {}; }
function persistMonitors(db: MonDB) { writeAtomic(MON_FILE, JSON.stringify(db, null, 2)); }

export function upsertMonitor(input: { website: string; name?: string; cadence?: Monitor['cadence']; webhook?: string; email?: string }): Monitor {
  const db = loadMonitors();
  const key = siteKey(input.website);
  const prev = db[key];
  const m: Monitor = {
    key, website: input.website, name: input.name || prev?.name || key,
    cadence: input.cadence || prev?.cadence || 'weekly',
    webhook: input.webhook !== undefined ? input.webhook : prev?.webhook,
    email: input.email !== undefined ? input.email : prev?.email,
    enabled: true, createdAt: prev?.createdAt || new Date().toISOString(),
    lastRunAt: prev?.lastRunAt, lastAlertAt: prev?.lastAlertAt, lastAlertScore: prev?.lastAlertScore,
  };
  db[key] = m; persistMonitors(db); return m;
}
export function getMonitor(website: string): Monitor | null { return loadMonitors()[siteKey(website)] || null; }
export function listMonitors(): Monitor[] { return Object.values(loadMonitors()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); }
export function stopMonitor(website: string): boolean {
  const db = loadMonitors(); const key = siteKey(website);
  if (!db[key]) return false; db[key].enabled = false; persistMonitors(db); return true;
}
export function markMonitorRun(website: string, alerted: boolean, score?: number) {
  const db = loadMonitors(); const key = siteKey(website); const m = db[key];
  if (!m) return; m.lastRunAt = new Date().toISOString();
  if (alerted) { m.lastAlertAt = m.lastRunAt; if (typeof score === 'number') m.lastAlertScore = score; }
  persistMonitors(db);
}

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
