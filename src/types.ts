export type Ans = 'yes' | 'partial' | 'no' | null;

export interface Signal { id: string; name: string; w: number; }

// 9 weighted signals (sum = 100)
export const SIGNALS: Signal[] = [
  { id: 'faq', name: 'FAQ / answer-shaped content', w: 14 },
  { id: 'schema', name: 'Structured data (schema)', w: 13 },
  { id: 'facts', name: 'Citable facts & statistics', w: 12 },
  { id: 'mentions', name: 'Earned mentions & reviews', w: 12 },
  { id: 'fresh', name: 'Content freshness', w: 11 },
  { id: 'identity', name: 'Identity & trust (E-E-A-T)', w: 11 },
  { id: 'convo', name: 'Conversational content', w: 10 },
  { id: 'gbp', name: 'Google Business Profile', w: 9 },
  { id: 'tech', name: 'Technical health', w: 8 },
];

export interface Finding { c: 'ok' | 'no' | 'neutral'; t: string; ev?: string; conf?: 'high' | 'med' | 'low'; status?: 'detected' | 'inferred' | 'unverified'; }

export interface AiBot { name: string; allowed: boolean; matched: string; }
export interface AiAccess { bots: AiBot[]; llmsTxt: boolean; majorBlocked: number; checked: boolean; }

export interface Detection {
  answers: Record<string, Ans>;
  findings: Finding[];
  profile: { what: string; city: string; country: string };
  aiAccess: AiAccess;
  confidence: number;
}

export interface Business { name: string; website?: string; }

export interface Fix {
  title: string; why: string; action: string;
  effort: 'Quick win' | 'Medium' | 'Ongoing'; priority: number;
}

export interface SignalScore { id: string; name: string; score: number; max: number; note: string; }

export interface Report {
  ok: boolean;
  mode: 'analyzed' | 'self';
  read: boolean;
  business: Business;
  score: number;
  band: 'Invisible' | 'Emerging' | 'Visible' | 'Cited';
  headline: string;
  summary: string;
  signals: SignalScore[];
  answers: Record<string, Ans>;
  unverified: string[];
  findings: Finding[];
  fixes: Fix[];
  faq: { q: string; a: string }[];
  faqSchema: string;
  bizSchema: string;
  aiAccess?: AiAccess;
  confidence?: number;
  kit?: { llmsTxt: string; robotsSnippet: string };
}
