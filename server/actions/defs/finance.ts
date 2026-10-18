import { z } from 'zod';
import type { FinancingKind } from '../../../shared/domain';
import { addDays } from '../../../shared/dates';
import { fmtEur, mEur } from '../../../shared/money';
import { COUNTERPARTY, REVIEW_DAYS, executeFinancing, financingAnalysis } from '../../engine/financing';
import { cash } from '../../engine/ledger';
import { liquidity, rcf, rcfAvailable, rcfBlocked } from '../../engine/metrics';
import { liquidityTightness } from '../../engine/board';
import { RULES } from '../../engine/params';
import { drawRcf, repayRcf } from '../../engine/treasury';
import { byId, emit, nextId, type World } from '../../engine/world';
import { ok, type ActionDef, type ApprovalRequirement } from '../types';

const KINDS = ['rcf_draw', 'rcf_repay', 'bank_term_loan', 'bond', 'rights_issue', 'shareholder_loan', 'ceo_contribution', 'sale_leaseback', 'covenant_waiver'] as const;

const KIND_LABEL: Record<FinancingKind, string> = {
  rcf_draw: 'Draw on the revolving credit facility',
  rcf_repay: 'Repay the revolving credit facility',
  bank_term_loan: 'New bank term loan',
  bond: 'Senior bond issue',
  rights_issue: 'Rights issue (new equity)',
  shareholder_loan: 'Shareholder loan (Halvorsen family)',
  ceo_contribution: 'CEO personal share subscription',
  sale_leaseback: 'Sale-and-leaseback of the HQ campus',
  covenant_waiver: 'Covenant waiver from the banks',
};

type Req = { kind: FinancingKind; amountCents: number; tenorYears?: number; rationale: string };

function approvalsFor(w: World, p: Req): ApprovalRequirement[] {
  const a: ApprovalRequirement[] = [];
  if (['bond', 'rights_issue', 'sale_leaseback'].includes(p.kind)) a.push({ approver: 'board', reason: `${KIND_LABEL[p.kind]} requires a board resolution.` });
  if (p.kind === 'bank_term_loan' && p.amountCents > RULES.ceoFinancingLimitCents) a.push({ approver: 'board', reason: `New debt above ${fmtEur(RULES.ceoFinancingLimitCents)} requires board approval.` });
  if (p.kind === 'shareholder_loan' || p.kind === 'ceo_contribution') a.push({ approver: 'board', reason: 'Related-party transaction: requires approval by the independent directors.' });
  if (p.kind === 'rights_issue') a.push({ approver: 'shareholders', reason: 'Requires an extraordinary general meeting (included in the timeline).', informational: true });
  if (!['rcf_draw', 'rcf_repay'].includes(p.kind)) a.push({ approver: 'counterparty', approverId: COUNTERPARTY[p.kind]?.id ?? undefined, reason: `${COUNTERPARTY[p.kind].name} decide after ~${REVIEW_DAYS[p.kind]} days of review; an offer can be accepted or declined.`, informational: true });
  return a;
}

export const requestFinancing: ActionDef<Req> = {
  type: 'request_financing',
  label: 'Request financing',
  description: `Seek money or relief: ${KINDS.map((k) => `${k} (${KIND_LABEL[k]})`).join('; ')}. Except RCF movements, this only starts a review; nothing is received until an offer is accepted and executed.`,
  llmProposable: true,
  financing: true,
  amountCents: (_w, p) => p.amountCents,
  schema: z.object({ kind: z.enum(KINDS), amountCents: z.number().int().min(0), tenorYears: z.number().min(1).max(10).optional(), rationale: z.string().min(3).max(800) }),
  validate: (w, p) => {
    const v = ok();
    const pending = w.financing.find((f) => f.kind === p.kind && ['under_review', 'offered', 'pending_approval'].includes(f.status));
    if (pending && !['rcf_draw', 'rcf_repay'].includes(p.kind)) v.errors.push(`A ${KIND_LABEL[p.kind].toLowerCase()} request is already in progress (${pending.id}, ${pending.status}).`);
    switch (p.kind) {
      case 'rcf_draw':
        if (rcfBlocked(w)) v.errors.push('The RCF cannot be drawn while a covenant is in breach.');
        else if (p.amountCents > rcfAvailable(w)) v.errors.push(`Only ${fmtEur(rcfAvailable(w))} of the RCF is undrawn.`);
        if (p.amountCents <= 0) v.errors.push('Amount must be positive.');
        break;
      case 'rcf_repay': {
        const r = rcf(w);
        if (!r || r.principalCents <= 0) v.errors.push('Nothing is drawn on the RCF.');
        else if (p.amountCents > r.principalCents) v.errors.push(`Only ${fmtEur(r.principalCents)} is drawn.`);
        if (p.amountCents > cash(w)) v.errors.push(`Cash on hand is only ${fmtEur(cash(w))}.`);
        break;
      }
      case 'bank_term_loan':
        if (p.amountCents < mEur(100) || p.amountCents > mEur(1_200)) v.errors.push('Bank term loans range from €100m to €1.2bn.');
        break;
      case 'bond':
        if (p.amountCents < mEur(300) || p.amountCents > mEur(1_000)) v.errors.push('A benchmark bond is €300m–€1bn.');
        break;
      case 'rights_issue':
        if (p.amountCents < mEur(100) || p.amountCents > mEur(1_200)) v.errors.push('A rights issue of €100m–€1.2bn is feasible (market capitalisation ≈ ' + fmtEur(w.meta.sharePriceCents * w.meta.sharesOutstanding) + ').');
        break;
      case 'shareholder_loan':
        if (p.amountCents < mEur(20)) v.errors.push('Minimum €20m.');
        break;
      case 'ceo_contribution':
        if (p.amountCents > w.meta.ceoPersonalLiquidCents) v.errors.push(`No verifiable source of funds: your verified personal liquid assets are ${fmtEur(w.meta.ceoPersonalLiquidCents)} (net worth ${fmtEur(w.meta.ceoPersonalNetWorthCents)}, mostly illiquid). A subscription above that cannot be documented for the related-party review, the auditors or the regulator.`);
        if (p.amountCents < 100_000_00) v.errors.push('Minimum subscription €100k.');
        break;
      case 'sale_leaseback':
        if (w.meta.assetsSold.includes('HQ_CAMPUS')) v.errors.push('The HQ campus has already been sold.');
        break;
      case 'covenant_waiver':
        if (!w.covenants.some((c) => c.status === 'breached') && !w.covenants.some((c) => c.lastValue !== null && (c.comparator === 'max' ? c.lastValue > c.threshold * 0.9 : c.lastValue < c.threshold * 1.1))) v.errors.push('No covenant is breached or close to its limit; lenders will not discuss a waiver.');
        break;
    }
    return v;
  },
  preview: (w, p) => {
    const a = financingAnalysis(w, p.kind, p.amountCents);
    const cons = [];
    if (p.kind === 'rcf_draw') cons.push({ label: 'Cash in now; RCF interest ~6.75% on drawn amounts', amountCents: p.amountCents, kind: 'cash' as const });
    else if (p.kind === 'rcf_repay') cons.push({ label: 'Cash out now; reduces interest', amountCents: -p.amountCents, kind: 'cash' as const });
    else {
      cons.push({ label: `Proposal only: ${COUNTERPARTY[p.kind].name} review takes ~${REVIEW_DAYS[p.kind]} days (decision around ${addDays(w.meta.currentDate, REVIEW_DAYS[p.kind])}). Approval is not guaranteed.`, kind: 'approval' as const });
      if (p.amountCents > 0) cons.push({ label: 'Potential proceeds if an offer is accepted', amountCents: p.amountCents, timing: 'only after acceptance', kind: 'cash' as const });
      if (a.annualInterestCents) cons.push({ label: 'Indicative annual interest cost (estimate)', amountCents: -a.annualInterestCents, timing: 'per year', kind: 'pnl' as const });
      if (a.dilutionPct) cons.push({ label: `Dilution of existing shareholders ≈${a.dilutionPct.toFixed(1)}%`, kind: 'risk' as const });
      cons.push({ label: `Pro-forma net leverage ${a.leverageAfter.toFixed(2)}x`, kind: 'info' as const });
    }
    return { summary: `${KIND_LABEL[p.kind]}${p.amountCents ? `: ${fmtEur(p.amountCents)}` : ''}`, consequences: cons, approvals: approvalsFor(w, p) };
  },
  boardAnalysis: (w, p) => {
    const a = financingAnalysis(w, p.kind, p.amountCents);
    const maturing = w.debts.some((d) => d.status === 'active' && d.maturityDate <= addDays(w.meta.currentDate, 730) && d.principalCents >= mEur(300));
    const raises = ['bank_term_loan', 'bond', 'rights_issue', 'sale_leaseback', 'shareholder_loan', 'ceo_contribution'].includes(p.kind);
    return { cashImpactCents: a.cashImpactCents, minLiquidityAfterCents: (w.meta.lastForecastSummary?.minLiquidityCents ?? liquidity(w)) + a.cashImpactCents, leverageAfter: a.leverageAfter, annualProfitImpactCents: -a.annualInterestCents, jobsImpact: 0, ev: 0.2, growth: 0, dilutionPct: a.dilutionPct, risk: p.kind === 'bond' ? 0.3 : 0.2, cfoSupport: 0.8, necessity: raises && maturing ? 0.3 + 0.4 * liquidityTightness(w) : 0 };
  },
  commit: (w, p, ctx) => {
    if (p.kind === 'rcf_draw') {
      drawRcf(w, p.amountCents, 'CEO decision');
      return { summary: 'RCF drawn', details: [fmtEur(p.amountCents)] };
    }
    if (p.kind === 'rcf_repay') {
      const paid = repayRcf(w, p.amountCents, 'CEO decision');
      return { summary: 'RCF repaid', details: [fmtEur(paid)] };
    }
    const id = nextId(w, 'FIN');
    const cp = COUNTERPARTY[p.kind];
    w.financing.push({ id, kind: p.kind, counterparty: cp.name, counterpartyId: cp.id, requestedCents: p.amountCents, tenorYears: p.tenorYears ?? 5, status: 'under_review', submittedDate: w.meta.currentDate, decisionDate: addDays(w.meta.currentDate, REVIEW_DAYS[p.kind]), offer: null, decisionReason: null, rationale: p.rationale, executedDate: null, instrumentId: null, actionId: ctx.actionId, analysis: financingAnalysis(w, p.kind, p.amountCents) });
    emit(w, { type: 'financing_requested', category: 'finance', severity: 'notice', title: `${KIND_LABEL[p.kind]} requested${p.amountCents ? ` (${fmtEur(p.amountCents)})` : ''}`, description: `Submitted to ${cp.name}; decision expected ${addDays(w.meta.currentDate, REVIEW_DAYS[p.kind])}. This is a request, not a commitment by the counterparty.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'financing', id }] });
    return { summary: 'Financing request submitted', details: [id], result: { financingId: id } };
  },
};

export const acceptFinancing: ActionDef<{ financingId: string }> = {
  type: 'accept_financing',
  label: 'Accept a financing offer',
  description: 'Accept and execute a financing offer received from a lender or investor.',
  llmProposable: true,
  affectsForecast: true,
  financing: true,
  amountCents: (w, p) => byId(w.financing, p.financingId)?.offer?.amountCents ?? 0,
  schema: z.object({ financingId: z.string() }),
  validate: (w, p) => {
    const f = byId(w.financing, p.financingId);
    if (!f) return { errors: ['Unknown financing request.'], warnings: [] };
    if (f.status !== 'offered' || !f.offer) return { errors: [`No offer to accept (status: ${f.status}).`], warnings: [] };
    if (w.meta.currentDate > f.offer.validUntil) return { errors: ['The offer has expired.'], warnings: [] };
    return ok();
  },
  preview: (w, p) => {
    const f = byId(w.financing, p.financingId)!;
    const o = f.offer!;
    return {
      summary: `Accept: ${f.counterparty}`,
      consequences: [
        ...(o.amountCents ? [{ label: 'Proceeds', amountCents: o.amountCents, kind: 'cash' as const }] : []),
        { label: 'Fees', amountCents: -o.feesCents, kind: 'cash' as const },
        ...(o.rateBps && f.kind !== 'covenant_waiver' ? [{ label: `Interest ${(o.rateBps / 100).toFixed(2)}% for ${o.tenorYears} years`, amountCents: -Math.round((o.amountCents * o.rateBps) / 10_000), timing: 'per year', kind: 'pnl' as const }] : []),
        ...o.conditions.map((c) => ({ label: c, kind: 'info' as const })),
      ],
      approvals: [],
    };
  },
  commit: (w, p) => {
    const f = byId(w.financing, p.financingId)!;
    f.status = 'accepted';
    const details = executeFinancing(w, f);
    return { summary: 'Financing executed', details };
  },
};

export const declineFinancing: ActionDef<{ financingId: string; reason?: string }> = {
  type: 'decline_financing',
  label: 'Decline a financing offer',
  description: 'Decline or withdraw a financing request/offer.',
  llmProposable: false,
  schema: z.object({ financingId: z.string(), reason: z.string().max(300).optional() }),
  validate: (w, p) => {
    const f = byId(w.financing, p.financingId);
    if (!f) return { errors: ['Unknown financing request.'], warnings: [] };
    if (!['offered', 'under_review'].includes(f.status)) return { errors: [`Cannot decline in status ${f.status}.`], warnings: [] };
    return ok();
  },
  preview: (w, p) => ({ summary: `Decline/withdraw ${byId(w.financing, p.financingId)!.counterparty}`, consequences: [], approvals: [] }),
  commit: (w, p, ctx) => {
    const f = byId(w.financing, p.financingId)!;
    f.status = 'withdrawn';
    emit(w, { type: 'financing_withdrawn', category: 'finance', severity: 'info', title: `Financing withdrawn: ${f.counterparty}`, description: p.reason ?? '', causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'financing', id: f.id }] });
    return { summary: 'Withdrawn', details: [] };
  },
};
