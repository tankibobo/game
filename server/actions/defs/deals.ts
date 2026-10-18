import { z } from 'zod';
import { fmtEur } from '../../../shared/money';
import { NEGOTIATION_TEMPLATES, evaluateOffer, lastCounter, newNegotiation, processOffer } from '../../engine/negotiation';
import { RULES } from '../../engine/params';
import { adjustTrust, byId, emit, remember } from '../../engine/world';
import { ok, type ActionDef } from '../types';

export const openNegotiation: ActionDef<{ templateKey: string }> = {
  type: 'open_negotiation',
  label: 'Open a negotiation',
  description: `Start negotiating with a counterparty: ${Object.values(NEGOTIATION_TEMPLATES).map((t) => `${t.key} (${t.title})`).join('; ')}.`,
  llmProposable: true,
  schema: z.object({ templateKey: z.string() }),
  validate: (w, p) => {
    const t = NEGOTIATION_TEMPLATES[p.templateKey];
    if (!t) return { errors: [`Unknown negotiation type "${p.templateKey}".`], warnings: [] };
    if (w.negotiations.some((n) => n.templateKey === p.templateKey && n.status === 'open')) return { errors: ['A negotiation of this kind is already open.'], warnings: [] };
    if (w.negotiations.some((n) => n.templateKey === p.templateKey && n.status === 'agreed' && n.contractId && byId(w.contracts, n.contractId)?.status === 'agreed')) return { errors: ['An agreement of this kind is awaiting signature.'], warnings: [] };
    const why = t.available?.(w);
    if (why) return { errors: [why], warnings: [] };
    const failed = w.negotiations.filter((n) => n.templateKey === p.templateKey && n.status === 'failed').pop();
    if (failed && failed.rounds.length && w.meta.currentDate < addDaysLocal(failed.rounds[failed.rounds.length - 1].date, 30)) return { errors: ['The counterparty broke off talks recently; they will not reopen within 30 days.'], warnings: [] };
    return ok();
  },
  preview: (w, p) => {
    const t = NEGOTIATION_TEMPLATES[p.templateKey];
    return { summary: `Open: ${t.title}`, consequences: [{ label: `${byId(w.characters, t.counterpartyId)?.name} will table an opening position: ${t.describe(t.defaultIdeal)}`, kind: 'info' }], approvals: [] };
  },
  commit: (w, p, ctx) => {
    const n = newNegotiation(w, p.templateKey);
    w.negotiations.push(n);
    emit(w, { type: 'negotiation_opened', category: 'negotiation', severity: 'info', title: `Negotiation opened: ${n.title}`, description: n.rounds[0].message, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'negotiation', id: n.id }, { type: 'character', id: n.counterpartyId }] });
    return { summary: 'Negotiation opened', details: [n.id], result: { negotiationId: n.id } };
  },
};

function addDaysLocal(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface OfferPayload {
  negotiationId: string;
  terms: Record<string, number>;
  message: string;
  /** Set by the server (LLM assessment or heuristic) — never by the client. */
  argumentQuality?: number;
}

export const negotiateContract: ActionDef<OfferPayload> = {
  type: 'negotiate_contract',
  label: 'Make a negotiation offer',
  description: 'Table an offer (all terms) in an open negotiation. The counterparty accepts, counters, asks for internal approval, or breaks off — based on its private limits, trust, alternatives and the quality of your argument.',
  llmProposable: true,
  schema: z.object({ negotiationId: z.string(), terms: z.record(z.string(), z.number()), message: z.string().max(2000), argumentQuality: z.number().min(-0.05).max(0.1).optional() }),
  validate: (w, p) => {
    const n = byId(w.negotiations, p.negotiationId);
    if (!n) return { errors: ['Unknown negotiation.'], warnings: [] };
    if (n.status !== 'open') return { errors: [`Negotiation is ${n.status}.`], warnings: [] };
    if (n.pendingDecision) return { errors: [`Waiting for the ${n.pendingDecision.approver} (decision by ${n.pendingDecision.date}).`], warnings: [] };
    const v = ok();
    for (const t of n.terms) {
      const x = p.terms[t.key];
      if (x === undefined || !Number.isFinite(x)) v.errors.push(`Missing value for “${t.label}”.`);
      else if (x < t.min || x > t.max) v.errors.push(`${t.label} must be between ${t.min} and ${t.max}.`);
    }
    for (const k of Object.keys(p.terms)) if (!n.terms.some((t) => t.key === k)) v.errors.push(`Unknown term "${k}".`);
    return v;
  },
  preview: (w, p) => {
    const n = byId(w.negotiations, p.negotiationId)!;
    const t = NEGOTIATION_TEMPLATES[n.templateKey];
    const counter = lastCounter(n);
    return {
      summary: `Offer to ${byId(w.characters, n.counterpartyId)?.name}: ${t.describe(p.terms)}`,
      consequences: [
        { label: 'An offer is not a contract. If accepted, the agreement must still be signed (with any required approvals) before it takes effect.', kind: 'info' },
        ...(counter ? [{ label: `Their last position: ${t.describe(counter)}`, kind: 'info' as const }] : []),
        { label: `Value of the package ≈${fmtEur(t.value(w, p.terms))}; up-front cash ${fmtEur(t.upfrontCents(w, p.terms))}`, kind: 'cash' },
      ],
      approvals: [{ approver: 'counterparty', approverId: n.counterpartyId, reason: 'The counterparty decides.', informational: true }],
    };
  },
  commit: (w, p, ctx) => {
    const n = byId(w.negotiations, p.negotiationId)!;
    const res = processOffer(w, n, p.terms, p.message, p.argumentQuality ?? 0);
    remember(w, { characterId: n.counterpartyId, kind: 'negotiation', summary: `CEO offered: ${NEGOTIATION_TEMPLATES[n.templateKey].describe(p.terms)}. Outcome: ${res.outcome}.`, importance: 3, sentiment: res.outcome === 'accepted' ? 1 : 0, sourceType: 'negotiation', sourceId: n.id, entityRefs: [{ type: 'negotiation', id: n.id }] });
    return { summary: res.response, details: [res.outcome], result: { outcome: res.outcome, counter: res.counter, evaluation: { accepted: res.evaluation.accepted, violations: res.evaluation.violations, notes: res.evaluation.notes } } };
  },
};

export const signContract: ActionDef<{ contractId: string }> = {
  type: 'sign_contract',
  label: 'Sign an agreed contract',
  description: 'Sign a contract that has been agreed in negotiation. Its terms take effect on signature.',
  llmProposable: true,
  affectsForecast: true,
  amountCents: (w, p) => {
    const c = byId(w.contracts, p.contractId);
    const t = c?.templateKey ? NEGOTIATION_TEMPLATES[c.templateKey] : undefined;
    return c && t ? t.upfrontCents(w, c.terms as Record<string, number>) : 0;
  },
  schema: z.object({ contractId: z.string() }),
  validate: (w, p) => {
    const c = byId(w.contracts, p.contractId);
    if (!c) return { errors: ['Unknown contract.'], warnings: [] };
    if (c.status !== 'agreed') return { errors: [`Contract is ${c.status}; only agreed contracts can be signed.`], warnings: [] };
    if (!c.templateKey || !NEGOTIATION_TEMPLATES[c.templateKey]) return { errors: ['Contract has no executable terms.'], warnings: [] };
    return ok();
  },
  preview: (w, p) => {
    const c = byId(w.contracts, p.contractId)!;
    const t = NEGOTIATION_TEMPLATES[c.templateKey!];
    const terms = c.terms as Record<string, number>;
    const upfront = t.upfrontCents(w, terms);
    return {
      summary: `Sign: ${c.title}`,
      consequences: [{ label: t.describe(terms), kind: 'info' }, ...(upfront ? [{ label: 'Up-front cash', amountCents: -upfront, kind: 'cash' as const }] : []), { label: `Total contract value ≈${fmtEur(c.valueCents)}`, kind: 'info' }],
      approvals: upfront > RULES.ceoSpendLimitCents ? [{ approver: 'board', reason: `Up-front commitment ${fmtEur(upfront)} exceeds the CEO limit.` }] : [],
    };
  },
  boardAnalysis: (w, p) => {
    const c = byId(w.contracts, p.contractId)!;
    const t = NEGOTIATION_TEMPLATES[c.templateKey!];
    const up = t.upfrontCents(w, c.terms as Record<string, number>);
    const battery = c.templateKey === 'voltaris_supply' || c.templateKey === 'hanseatic_second_source';
    const eonBlocked = w.issues.some((i) => i.id === 'ISS-VOLTARIS' && !['resolved', 'closed'].includes(i.status));
    return { cashImpactCents: -up, minLiquidityAfterCents: (w.meta.lastForecastSummary?.minLiquidityCents ?? 0) - up, leverageAfter: 0, annualProfitImpactCents: 0, jobsImpact: 0, ev: battery ? 1 : 0, growth: 0.3, dilutionPct: 0, risk: 0.3, cfoSupport: 0.2, necessity: battery && eonBlocked ? 0.9 : c.kind === 'labor' ? 0.7 : 0.3 };
  },
  commit: (w, p, ctx) => {
    const c = byId(w.contracts, p.contractId)!;
    const t = NEGOTIATION_TEMPLATES[c.templateKey!];
    c.status = 'active';
    c.signedDate = w.meta.currentDate;
    if (!c.startDate) c.startDate = w.meta.currentDate;
    const effects = t.apply(w, c.terms as Record<string, number>, c);
    c.summary = `Signed ${w.meta.currentDate}: ${t.describe(c.terms as Record<string, number>)}`;
    if (c.amendmentOf) {
      const base = byId(w.contracts, c.amendmentOf);
      if (base) base.summary += ` Amended by ${c.id} (${w.meta.currentDate}).`;
    }
    if (c.counterpartyId) {
      adjustTrust(w, c.counterpartyId, 3);
      remember(w, { characterId: c.counterpartyId, kind: 'decision', summary: `Contract signed with the CEO: ${c.title}.`, importance: 4, sentiment: 2, sourceType: 'contract', sourceId: c.id, entityRefs: [{ type: 'contract', id: c.id }] });
    }
    emit(w, { type: 'contract_signed', category: 'negotiation', severity: 'notice', title: `Signed: ${c.title}`, description: effects.join(' '), causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'contract', id: c.id }, ...(c.negotiationId ? [{ type: 'negotiation' as const, id: c.negotiationId }] : [])], consequences: effects.map((text) => ({ text })) });
    return { summary: 'Contract signed', details: effects };
  },
};

export { evaluateOffer };
