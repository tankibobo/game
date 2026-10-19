import { z } from 'zod';
import { fmtEur } from '../../../shared/money';
import { NEGOTIATION_TEMPLATES, evaluateOffer, lastCounter, newNegotiation, processOffer } from '../../engine/negotiation';
import { RULES } from '../../engine/params';
import { adjustTrust, byId, emit, inbox, remember } from '../../engine/world';
import { ok, type ActionDef } from '../types';
import type { World } from '../../engine/world';

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

/** What signing binds the company to, as the General Counsel would flag it. */
export function legalReview(w: World, key: string, t: Record<string, number>): string[] {
  const days = 230;
  if (key === 'voltaris_supply') {
    const exposure = Math.round((t.takeOrPayPct / 100) * t.dailyVolume * days * t.priceEur * 100);
    return [`binding take-or-pay: Asterion pays for at least ${t.takeOrPayPct}% of ${t.dailyVolume} packs a day whether it uses them or not — about ${fmtEur(exposure)} a year once capacity is live.`, `the €${t.prepaymentM}m prepayment is only recovered against future pack invoices; if the Eon stops, it is at risk.`];
  }
  if (key === 'labor_agreement') {
    const payroll = w.departments.reduce((a, d) => a + d.headcount * d.annualCostPerHeadCents, 0) * w.meta.wageIndex;
    return [`wages rise ${t.wageIncreasePct}% for everyone (≈${fmtEur(Math.round(payroll * t.wageIncreasePct / 100))} a year), permanently.`, t.jobGuaranteeMonths > 0 ? `no compulsory redundancies at the plants for ${t.jobGuaranteeMonths} months — breaking it frees the union from the peace obligation.` : 'no job guarantee: compulsory cuts remain possible (but costly in trust).', 'in return: a peace obligation — no strikes while the agreement runs.'];
  }
  if (key === 'hanseatic_second_source') return [`the €${t.developmentFeeM}m development fee is payable within 30 days and is not refundable.`];
  if (key === 'contract_assembly') return [`Lyon must reserve ${t.carsPerDay} cars a day of capacity and the crews for them for ${t.years} year${t.years > 1 ? 's' : ''}; the Vela line loses that capacity.`, 'it is a partnership with a direct competitor: confidential processes must be ring-fenced.'];
  if (key === 'hanseatic_price') return [`volume commitment: ${t.volumeCommitPct}% of current Kora hybrid-module volumes is take-or-pay for the contract term; the sole-source agreement runs ${t.extensionYears} year(s) longer.`];
  if (key.startsWith('fleet_')) return [`a firm delivery commitment of ${t.units.toLocaleString('en-GB')} cars over ${t.months} months from factory stock — if the cars are not built in time, the buyer cancels the remainder.`, 'fleet discounts are visible to retail customers and dealers.'];
  if (key === 'dealer_agreement') return ['the stock support is paid on cars already in dealer stock — it is a price reduction recognised immediately.'];
  return [];
}

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
      consequences: [{ label: t.describe(terms), kind: 'info' }, ...(upfront ? [{ label: 'Up-front cash', amountCents: -upfront, kind: 'cash' as const }] : []), { label: `Total contract value ≈${fmtEur(c.valueCents)}`, kind: 'info' }, ...legalReview(w, c.templateKey!, terms).map((label) => ({ label: `Legal review (General Counsel): ${label}`, kind: 'risk' as const }))],
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

export const withdrawNegotiation: ActionDef<{ negotiationId: string; reason: string }> = {
  type: 'withdraw_negotiation',
  label: 'Walk away from a negotiation',
  description: 'End an open negotiation deliberately. The counterparty is disappointed (trust falls) and the talks cannot be reopened for 30 days.',
  llmProposable: true,
  schema: z.object({ negotiationId: z.string(), reason: z.string().min(3).max(400) }),
  validate: (w, p) => {
    const n = byId(w.negotiations, p.negotiationId);
    if (!n) return { errors: ['Unknown negotiation.'], warnings: [] };
    if (n.status !== 'open') return { errors: [`The negotiation is ${n.status}.`], warnings: [] };
    const v = ok();
    if (n.templateKey === 'labor_agreement') v.warnings.push('Without a wage agreement there is no peace obligation: strikes become likely.');
    if (n.templateKey === 'voltaris_supply') v.warnings.push('Without more Voltaris packs the Eon cannot ramp up unless a second source is qualified and contracted.');
    return v;
  },
  preview: (w, p) => {
    const n = byId(w.negotiations, p.negotiationId)!;
    const cp = byId(w.characters, n.counterpartyId);
    return { summary: `Walk away: ${n.title}`, consequences: [{ label: `${cp?.name ?? 'The counterparty'} (${cp?.orgName ?? ''}) loses trust in you; talks can reopen only after 30 days.`, kind: 'people' }], approvals: [] };
  },
  commit: (w, p, ctx) => {
    const n = byId(w.negotiations, p.negotiationId)!;
    n.status = 'withdrawn';
    n.rounds.push({ n: n.rounds.length, date: w.meta.currentDate, by: 'ceo', terms: n.rounds[n.rounds.length - 1]?.terms ?? {}, message: `Asterion ends the talks: ${p.reason}`, evaluation: null });
    adjustTrust(w, n.counterpartyId, -5);
    const cp = byId(w.characters, n.counterpartyId);
    remember(w, { characterId: n.counterpartyId, kind: 'grievance', summary: `The CEO walked away from “${n.title}”: ${p.reason.slice(0, 200)}`, importance: 4, sentiment: -2, sourceType: 'negotiation', sourceId: n.id, entityRefs: [{ type: 'negotiation', id: n.id }] });
    inbox(w, { kind: 'letter', fromId: n.counterpartyId, subject: `${n.title}: noted`, body: `We note that Asterion has ended the talks. We are disappointed — we had come a long way. Our door is not closed, but the next conversation will start from our position, not yours.`, priority: 'normal', linked: [{ type: 'negotiation', id: n.id }] });
    emit(w, { type: 'negotiation_withdrawn', category: 'negotiation', severity: 'warning', title: `Talks ended by Asterion: ${n.title}`, description: `${p.reason}. ${cp?.name ?? 'The counterparty'} was told.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'negotiation', id: n.id }, { type: 'character', id: n.counterpartyId }] });
    return { summary: 'Negotiation ended', details: [] };
  },
};

export const declineAgreement: ActionDef<{ contractId: string; reason: string }> = {
  type: 'decline_agreement',
  label: 'Decline to sign an agreed deal',
  description: 'Back out of an agreement reached at the table before signing it. Nothing binding is lost, but the counterparty’s trust suffers badly.',
  llmProposable: true,
  schema: z.object({ contractId: z.string(), reason: z.string().min(3).max(400) }),
  validate: (w, p) => {
    const c = byId(w.contracts, p.contractId);
    if (!c) return { errors: ['Unknown contract.'], warnings: [] };
    if (c.status !== 'agreed') return { errors: [`The contract is ${c.status}; only an agreed, unsigned contract can be declined.`], warnings: [] };
    return ok();
  },
  preview: (w, p) => {
    const c = byId(w.contracts, p.contractId)!;
    return { summary: `Decline to sign: ${c.title}`, consequences: [{ label: `${c.counterpartyName} will see this as going back on your word: a large loss of trust.`, kind: 'people' }], approvals: [] };
  },
  commit: (w, p, ctx) => {
    const c = byId(w.contracts, p.contractId)!;
    c.status = 'terminated';
    c.summary = `${c.summary} Declined by Asterion on ${w.meta.currentDate}: ${p.reason}`;
    const n = w.negotiations.find((x) => x.contractId === c.id);
    if (n) n.status = 'withdrawn';
    if (c.counterpartyId) {
      adjustTrust(w, c.counterpartyId, -10);
      remember(w, { characterId: c.counterpartyId, kind: 'grievance', summary: `The CEO refused to sign “${c.title}” after we had agreed terms.`, importance: 5, sentiment: -2, sourceType: 'contract', sourceId: c.id, entityRefs: [{ type: 'contract', id: c.id }] });
      inbox(w, { kind: 'letter', fromId: c.counterpartyId, subject: `${c.title}`, body: 'We shook hands on those terms. Refusing to sign now is not how serious partners behave. We will remember it.', priority: 'high', linked: [{ type: 'contract', id: c.id }] });
    }
    emit(w, { type: 'agreement_declined', category: 'negotiation', severity: 'warning', title: `Asterion declines to sign: ${c.title}`, description: p.reason, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'contract', id: c.id }] });
    return { summary: 'Agreement declined', details: [] };
  },
};

export { evaluateOffer };
