import type { Monitor, Snapshot } from './store.js';

// Alerting for monitored sites. Webhook is the no-key default (Slack/Discord/Pabbly/
// Zapier compatible). Email is optional and only fires when SMTP is configured via env,
// using nodemailer if installed; otherwise it is skipped, never blocking the webhook.

export interface AlertDecision { fire: boolean; kind: 'drop' | 'gain' | 'none'; delta: number; }

/** Pure: decide whether a change is worth alerting. Default alerts on drops only. */
export function shouldAlert(prevScore: number | null, curScore: number, opts?: { threshold?: number; notifyGains?: boolean }): AlertDecision {
  const threshold = opts?.threshold ?? 3;
  if (prevScore == null) return { fire: false, kind: 'none', delta: 0 };
  const delta = curScore - prevScore;
  if (delta <= -threshold) return { fire: true, kind: 'drop', delta };
  if (opts?.notifyGains && delta >= threshold) return { fire: true, kind: 'gain', delta };
  return { fire: false, kind: 'none', delta };
}

export interface AlertPayload { website: string; name: string; score: number; prevScore: number | null; delta: number; kind: string; band?: string; at: string; }

export function buildAlertText(p: AlertPayload): string {
  const dir = p.kind === 'drop' ? 'dropped' : p.kind === 'gain' ? 'improved' : 'changed';
  const sign = p.delta > 0 ? '+' : '';
  const from = p.prevScore == null ? '' : ` from ${p.prevScore}`;
  return `AuditRank: ${p.name} ${dir} ${sign}${p.delta} pts${from} to ${p.score}/100${p.band ? ` (${p.band})` : ''} - ${p.website}`;
}

/** Reject webhook URLs that point at localhost / private / metadata hosts (SSRF guard). */
export function isSafeWebhook(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^(0\.|127\.|10\.|169\.254\.|192\.168\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === '::1' || h === '0.0.0.0' || h.startsWith('[')) return false;
  return true;
}

export async function sendWebhook(url: string, p: AlertPayload): Promise<boolean> {
  if (!isSafeWebhook(url)) return false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: buildAlertText(p), ...p }) });
    return res.ok;
  } catch { return false; }
}

export async function sendEmail(to: string, p: AlertPayload): Promise<boolean> {
  const host = process.env.SMTP_HOST;
  const from = process.env.ALERT_FROM || process.env.SMTP_USER;
  if (!host || !from || !to) return false; // email not configured: webhook is the default path
  try {
    const nodemailer: any = await import('nodemailer');
    const tx = nodemailer.createTransport({
      host, port: parseInt(process.env.SMTP_PORT || '587', 10), secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await tx.sendMail({ from, to, subject: buildAlertText(p), text: `${buildAlertText(p)}\n\nRun a fresh audit any time at AuditRank.` });
    return true;
  } catch { return false; }
}

/** Decide + deliver for one monitor against its newest snapshot. */
export async function notify(m: Monitor, prevScore: number | null, cur: Snapshot): Promise<{ alerted: boolean; channels: string[] }> {
  const decision = shouldAlert(prevScore, cur.score, { threshold: 3, notifyGains: false });
  if (!decision.fire) return { alerted: false, channels: [] };
  const payload: AlertPayload = { website: m.website, name: m.name, score: cur.score, prevScore, delta: decision.delta, kind: decision.kind, band: cur.band, at: cur.at };
  const channels: string[] = [];
  const hook = m.webhook || process.env.ALERT_WEBHOOK;
  if (hook && (await sendWebhook(hook, payload))) channels.push('webhook');
  if (m.email && (await sendEmail(m.email, payload))) channels.push('email');
  return { alerted: channels.length > 0, channels };
}
