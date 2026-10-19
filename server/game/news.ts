/**
 * The trade press: the month's newsworthy events, written up as a newspaper.
 * Every article is an event the simulation actually recorded; the paper only
 * selects, groups and explains them ("What it means for Asterion").
 */
import type { GameEvent } from '../../shared/domain';
import type { DB } from '../db/connection';
import { loadWorld, rowToEvent } from '../db/repo';
import { segmentShares } from '../engine/demand';

export type NewsSection = 'asterion' | 'industry' | 'markets';

export interface NewsItem {
  id: string;
  date: string;
  section: NewsSection;
  headline: string;
  lede: string;
  impact: string[];
  severity: GameEvent['severity'];
  type: string;
}

/** Internal bookkeeping the press would never print. */
const NOT_NEWS = new Set([
  'advance_time', 'game_started', 'document_shared', 'approved_action_waiting', 'approved_action_executed', 'board_proposal_submitted', 'board_proposal_tabled',
  'commitment_upcoming', 'commitment_made', 'milestone_completed', 'milestone_blocked', 'milestone_overdue', 'negotiation_opened', 'negotiation_approval_denied',
  'issue_action', 'issue_resolved', 'issue_board_proposal', 'issue_deadline_missed', 'freeform', 'make_promise', 'resolve_commitment', 'address_issue', 'project_replanned',
  'competitor_promotion_end', 'competitor_recall_end', 'payment_deferred', 'deliver_plan', 'hires_arrived', 'downtime_scheduled', 'rcf_draw', 'production_change',
  'adjust_production', 'set_marketing_budget', 'change_project_scope', 'call_board_meeting', 'board_meeting_called', 'propose_budget', 'request_financing', 'financing_requested',
]);

const INDUSTRY = /^(competitor_|supplier_|chip_|energy_|thermal_|inverter_|supply)/;
const MARKETS = /^(macro_|tariff_|regulation_|euro7_|co2_|share_price|rating_|refinancing|financing_|eib_|covenant|liquidity|insolvency|missed_payments|debt_)/;

function sectionOf(e: GameEvent): NewsSection {
  if (INDUSTRY.test(e.type)) return 'industry';
  if (MARKETS.test(e.type) || e.category === 'regulatory') return 'markets';
  if (e.type === 'competitor_price_response') return 'industry';
  return 'asterion';
}

/** Whether a reporter would write the event up. */
function newsworthy(e: GameEvent): boolean {
  if (NOT_NEWS.has(e.type) || e.category === 'system') return false;
  if (e.severity !== 'info') return true;
  return /^(competitor_|project_completed|contract_signed|campaign_launched|fleet_deal|assembly_deal|price_change|change_price|negotiation_agreed|favorable_reviews|regulation_in_force|budget_approved|board_meeting$|hiring_started|start_project|start_custom_project|launch_campaign|sign_contract|mandate_)/.test(e.type);
}

/** A reporter's lede for our own decisions, which the engine records in the first person. */
function press(e: GameEvent): { headline: string; lede: string } {
  const strip = (s: string) => s.replace(/^CEO (decision|action):\s*/i, '');
  const h = strip(e.title);
  if (e.source === 'action' && sectionOf(e) === 'asterion') return { headline: `Asterion: ${h.charAt(0).toLowerCase() === h.charAt(0) ? h : h.charAt(0).toLowerCase() + h.slice(1)}`, lede: e.description };
  return { headline: h, lede: e.description };
}

function impactLines(e: GameEvent): string[] {
  const out: string[] = [];
  const m = e.description.match(/Effect on us:\s*([^]*?)(\.|$)/);
  if (m) out.push(`Effect on us: ${m[1]}.`);
  for (const c of e.consequences ?? []) if (c.text && !out.includes(c.text)) out.push(c.text + (c.amountCents ? ` (€${(Math.abs(c.amountCents) / 1e8).toFixed(1)}m)` : ''));
  return out.slice(0, 4);
}

export function newsView(db: DB, months = 4) {
  const w = loadWorld(db);
  const today = w.meta.currentDate;
  const fromMonth = (() => {
    const [y, mo] = today.split('-').map(Number);
    const d = new Date(Date.UTC(y, mo - 1 - (months - 1), 1));
    return d.toISOString().slice(0, 10);
  })();
  const rows = db.prepare('SELECT * FROM events WHERE date >= ? ORDER BY seq DESC LIMIT 1500').all(fromMonth) as Record<string, unknown>[];
  const items: NewsItem[] = [];
  for (const e of rows.map(rowToEvent)) {
    if (!newsworthy(e)) continue;
    const { headline, lede } = press(e);
    items.push({ id: e.id, date: e.date, section: sectionOf(e), headline, lede, impact: impactLines(e), severity: e.severity, type: e.type });
  }
  const rank = { critical: 3, warning: 2, notice: 1, info: 0 } as const;
  const editions = [...new Set(items.map((i) => i.date.slice(0, 7)))].sort().reverse().map((month) => {
    const xs = items.filter((i) => i.date.startsWith(month));
    const lead = [...xs].sort((a, b) => rank[b.severity] - rank[a.severity] || (a.section === 'asterion' ? -1 : 1))[0];
    return {
      month,
      lead: lead?.id ?? null,
      sections: (['asterion', 'industry', 'markets'] as NewsSection[]).map((s) => ({ section: s, items: xs.filter((i) => i.section === s) })),
    };
  });
  // The competitive landscape as the press sees it today.
  const ourSegments = [...new Set(w.models.filter((m) => m.status === 'in_production').map((m) => m.segmentId))];
  const competitors = w.competitors.map((c) => {
    const promo = w.eventStates.find((s) => s.key === `promo:${c.id}` && s.activeUntil && s.activeUntil >= today && !s.data.ended);
    const recall = w.eventStates.find((s) => s.key === `recall:${c.id}` && s.activeUntil && s.activeUntil >= today && !s.data.ended);
    const products = w.competitorProducts.filter((p) => p.competitorId === c.id && ourSegments.includes(p.segmentId));
    return {
      id: c.id,
      name: c.name,
      strategy: c.strategy,
      financialHealth: c.financialHealth,
      status: products.length && products.every((p) => p.status === 'withdrawn') ? 'out of the market' : promo ? 'running a price promotion' : recall ? 'handling a recall' : c.financialHealth < 30 ? 'in financial distress' : 'normal',
      products: products.map((p) => ({ name: p.name, segment: w.segments.find((s) => s.id === p.segmentId)?.name ?? p.segmentId, priceCents: p.priceCents, status: p.status })),
    };
  });
  const shares = ourSegments.map((sg) => ({
    segment: w.segments.find((s) => s.id === sg)?.name ?? sg,
    ours: segmentShares(w, sg, today).filter((r) => r.kind === 'asterion').reduce((a, r) => a + r.share, 0),
  }));
  const priceHistory = w.snapshots
    .filter((s) => s.kind === 'month' && s.data.sharePriceCents)
    .map((s) => ({ period: s.period, sharePriceCents: s.data.sharePriceCents!, boardConfidence: s.data.boardConfidence ?? null }));
  return { today, sharePriceCents: w.meta.sharePriceCents, priceHistory, editions, items, competitors, shares };
}
