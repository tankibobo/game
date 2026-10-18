/**
 * External financing decisions. Every source of money has an eligibility
 * rule, a cost, a timeline and a possible rejection. A request is only a
 * proposal; money moves only when an offer is accepted, approved where
 * required, and executed.
 */
import type { DebtInstrument, FinancingOffer, FinancingRequest } from '../../shared/domain';
import { addDays, addMonths, type SimDate } from '../../shared/dates';
import { bps, fmtEur, mEur, mulDiv, type Cents } from '../../shared/money';
import { bal, cash, post } from './ledger';
import { payOrDefer } from './treasury';
import { grossDebt, liquidity, ltm, netDebt, netLeverage } from './metrics';
import { adjustTrust, byId, clamp, emit, inbox, nextId, type World } from './world';

export const REVIEW_DAYS: Record<string, number> = {
  rcf_draw: 0,
  rcf_repay: 0,
  bank_term_loan: 21,
  bond: 30,
  rights_issue: 45,
  shareholder_loan: 14,
  ceo_contribution: 30,
  sale_leaseback: 45,
  covenant_waiver: 14,
};

export const COUNTERPARTY: Record<string, { name: string; id: string | null }> = {
  rcf_draw: { name: 'RCF lenders (Banque Continentale, agent)', id: 'CHR-FONTAINE' },
  rcf_repay: { name: 'RCF lenders (Banque Continentale, agent)', id: 'CHR-FONTAINE' },
  bank_term_loan: { name: 'Banque Continentale (lead arranger)', id: 'CHR-FONTAINE' },
  bond: { name: 'Debt capital markets (bookrunners)', id: null },
  rights_issue: { name: 'Shareholders (rights issue, underwritten)', id: 'CHR-HALVORSEN' },
  shareholder_loan: { name: 'Halvorsen Family Holdings', id: 'CHR-HALVORSEN' },
  ceo_contribution: { name: 'CEO personal subscription (related party)', id: null },
  sale_leaseback: { name: 'Real-estate investors (HQ campus)', id: null },
  covenant_waiver: { name: 'Bank syndicate (TLA & RCF lenders)', id: 'CHR-FONTAINE' },
};

const RATING_SPREAD: Record<string, number> = { 'BBB-': 180, 'BB+': 240, BB: 310, 'BB-': 380, 'B+': 480, B: 600, 'B-': 750, 'CCC+': 1000 };

export function ratingSpreadBps(w: World): number {
  return (RATING_SPREAD[w.meta.creditRating] ?? 500) + (w.macro.creditSpreadBps - 310);
}

export const HQ_BOOK_VALUE_CENTS = mEur(95);

/** Decide a request that has finished review. Pure function of state + seeded draw. */
export function decide(w: World, f: FinancingRequest): { offer: FinancingOffer | null; reason: string } {
  const d = w.meta.currentDate;
  const ebitda = ltm(w, 'ebitdaCents');
  const lev = netLeverage(w);
  const validUntil = addDays(d, 21);
  const eon = byId(w.projects, 'PRJ-EON');
  const eonCredible = !!eon && (eon.status === 'completed' || (!!eon.forecastDate && eon.forecastDate <= addMonths(w.meta.boardPlan.eonSopDate, 6)));
  const ecb = Math.round(w.macro.ecbRatePct * 100);
  switch (f.kind) {
    case 'bank_term_loan': {
      if (lev > 3.25) return { offer: null, reason: `Credit committee declined: net leverage ${lev.toFixed(2)}x exceeds the bank's 3.25x limit for new senior debt.` };
      const capacity = Math.max(0, Math.round(ebitda * 1.1));
      if (capacity < mEur(100)) return { offer: null, reason: 'Credit committee declined: insufficient EBITDA to support new debt.' };
      let amount = Math.min(f.requestedCents, capacity, mEur(900));
      const conditions = ['Net leverage ≤ 3.50x and interest cover ≥ 3.0x (same as TLA)', 'Proceeds to be applied first to repurchase or repay the 2028 notes'];
      if (!eonCredible) {
        amount = Math.min(amount, mEur(400));
        conditions.push('Condition precedent: signed Eon battery-supply solution (≥250 packs/day)');
      }
      const margin = 225 + Math.max(0, Math.round((lev - 2) * 90)) + (w.meta.creditRating === 'BB' ? 0 : 50);
      return { offer: { amountCents: amount, rateBps: ecb + margin, tenorYears: Math.min(5, f.tenorYears || 5), feesCents: bps(amount, 150), conditions, validUntil }, reason: amount < f.requestedCents ? `Approved for a reduced amount (${fmtEur(amount)}) given current EBITDA and risk.` : 'Credit committee approved.' };
    }
    case 'bond': {
      const downturn = w.macro.shocks.some((s) => s.key === 'downturn' && s.until >= d);
      if (lev > 4 || (downturn && ['B+', 'B', 'B-', 'CCC+'].includes(w.meta.creditRating))) return { offer: null, reason: 'Bookbuilding failed: insufficient investor demand at an acceptable yield.' };
      const coupon = ecb + ratingSpreadBps(w) + 25 + (downturn ? 100 : 0);
      return { offer: { amountCents: f.requestedCents, rateBps: coupon, tenorYears: f.tenorYears || 5, feesCents: bps(f.requestedCents, 120), conditions: ['Senior unsecured notes, bullet maturity', 'Change-of-control put at 101%'], validUntil: addDays(d, 5) }, reason: `Order book covered; indicative coupon ${(coupon / 100).toFixed(2)}%.` };
    }
    case 'rights_issue': {
      const hal = byId(w.characters, 'CHR-HALVORSEN');
      const price = Math.round((w.meta.sharePriceCents * 0.75) / 10) * 10;
      const newShares = Math.ceil(f.requestedCents / price);
      const familyIn = (hal?.trustInCeo ?? 50) >= 45;
      const fee = bps(f.requestedCents, familyIn ? 150 : 300);
      return { offer: { amountCents: f.requestedCents, rateBps: 0, tenorYears: 0, feesCents: fee, pricePerShareCents: price, newShares, conditions: [`Subscription price €${(price / 100).toFixed(2)} (25% discount)`, familyIn ? 'Halvorsen family commits to take up its 28% rights' : 'Halvorsen family declines to commit — higher underwriting fee', 'Requires shareholders’ meeting approval (already obtained via board resolution and EGM)'], validUntil }, reason: familyIn ? 'Underwriters ready; anchor shareholder committed.' : 'Underwriters ready but anchor shareholder not committed.' };
    }
    case 'shareholder_loan': {
      const hal = byId(w.characters, 'CHR-HALVORSEN');
      if (!hal || hal.trustInCeo < 50) return { offer: null, reason: 'Halvorsen Family Holdings declined: insufficient confidence in the turnaround plan.' };
      if (f.requestedCents > mEur(150)) return { offer: { amountCents: mEur(150), rateBps: 700, tenorYears: 4, feesCents: 0, conditions: ['Subordinated to senior debt', 'Related-party transaction approved by independent directors', 'Maximum the family can commit is €150m'], validUntil }, reason: 'The family offers its maximum of €150m.' };
      return { offer: { amountCents: f.requestedCents, rateBps: 700, tenorYears: 4, feesCents: 0, conditions: ['Subordinated to senior debt', 'Related-party transaction approved by independent directors'], validUntil }, reason: 'The family will lend on commercial terms.' };
    }
    case 'ceo_contribution': {
      if (f.requestedCents > w.meta.ceoPersonalLiquidCents) return { offer: null, reason: `Source-of-funds verification failed: verified personal liquid assets are ${fmtEur(w.meta.ceoPersonalLiquidCents)}.` };
      const shares = Math.floor(f.requestedCents / w.meta.sharePriceCents);
      return { offer: { amountCents: shares * w.meta.sharePriceCents, rateBps: 0, tenorYears: 0, feesCents: 0, pricePerShareCents: w.meta.sharePriceCents, newShares: shares, conditions: ['Subscription at market price (no discount for a related party)', 'Approved by the independent directors'], validUntil }, reason: 'Source of funds verified; subscription documents ready.' };
    }
    case 'sale_leaseback': {
      if (w.meta.assetsSold.includes('HQ_CAMPUS')) return { offer: null, reason: 'The HQ campus has already been sold.' };
      const price = mEur(150) + Math.round(mEur(50) * (w.mode === 'live' ? hashU(w.meta.seed, f.id) : 0.5));
      return { offer: { amountCents: price, rateBps: 0, tenorYears: 15, feesCents: bps(price, 200), leaseAnnualCents: bps(price, 720), conditions: ['15-year lease at 7.2% of the sale price per year, indexed', 'Asterion keeps operating the campus'], validUntil }, reason: `Best bid ${fmtEur(price)} after due diligence.` };
    }
    case 'covenant_waiver': {
      if (lev > 4.5) return { offer: null, reason: `Lenders refused a waiver at ${lev.toFixed(2)}x leverage without new equity.` };
      if (w.meta.boardConfidence < 25) return { offer: null, reason: 'Lenders refused: they doubt management’s plan.' };
      const base = (byId(w.debts, 'DEBT-TLA')?.principalCents ?? 0) + (byId(w.debts, 'DEBT-RCF')?.limitCents ?? 0);
      return { offer: { amountCents: 0, rateBps: 75, tenorYears: 0, feesCents: bps(base, 50), conditions: ['Covenant tests waived for the next two quarters', 'Margin on TLA and RCF +75 bps', 'Monthly liquidity reporting to lenders'], validUntil }, reason: 'Lenders will grant a six-month waiver against a fee and margin step-up.' };
    }
    default:
      return { offer: null, reason: 'Not a reviewable financing type.' };
  }
}

function hashU(seed: number, s: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 2654435761) >>> 0;
  return (h % 10_000) / 10_000;
}

/** Daily: finish reviews and expire stale offers. */
export function processFinancing(w: World): void {
  const d = w.meta.currentDate;
  for (const f of w.financing) {
    if (f.status === 'under_review' && f.decisionDate && f.decisionDate <= d) {
      const { offer, reason } = decide(w, f);
      f.decisionReason = reason;
      if (offer) {
        f.status = 'offered';
        f.offer = offer;
        emit(w, { type: 'financing_offer', category: 'finance', severity: 'notice', title: `Financing offer: ${f.counterparty}`, description: `${reason} ${fmtEur(offer.amountCents)}${offer.rateBps ? ` at ${(offer.rateBps / 100).toFixed(2)}%` : ''}; fees ${fmtEur(offer.feesCents)}. Valid until ${offer.validUntil}. Accepting it is a separate decision.`, causeKind: 'causal', entities: [{ type: 'financing', id: f.id }] });
        inbox(w, { kind: 'request', fromId: f.counterpartyId, subject: `Offer: ${f.counterparty}`, body: `${reason}\nAmount: ${fmtEur(offer.amountCents)}\n${offer.rateBps ? `Rate: ${(offer.rateBps / 100).toFixed(2)}%\n` : ''}Fees: ${fmtEur(offer.feesCents)}\nConditions:\n- ${offer.conditions.join('\n- ')}\nValid until ${offer.validUntil}.`, priority: 'high', linked: [{ type: 'financing', id: f.id }] });
      } else {
        f.status = 'rejected';
        emit(w, { type: 'financing_rejected', category: 'finance', severity: 'warning', title: `Financing declined: ${f.counterparty}`, description: reason, causeKind: 'causal', entities: [{ type: 'financing', id: f.id }] });
        inbox(w, { kind: 'letter', fromId: f.counterpartyId, subject: `Declined: ${f.counterparty}`, body: reason, priority: 'high', linked: [{ type: 'financing', id: f.id }] });
      }
    }
    if (f.status === 'offered' && f.offer && d > f.offer.validUntil) {
      f.status = 'expired';
      emit(w, { type: 'financing_expired', category: 'finance', severity: 'notice', title: `Offer expired: ${f.counterparty}`, description: 'The offer lapsed without acceptance.', causeKind: 'causal', entities: [{ type: 'financing', id: f.id }] });
    }
  }
}

/** Execute an accepted (and, where needed, board-approved) offer. */
export function executeFinancing(w: World, f: FinancingRequest): string[] {
  const o = f.offer;
  if (!o) throw new Error('no offer to execute');
  const d = w.meta.currentDate;
  const out: string[] = [];
  const src = f.id;
  switch (f.kind) {
    case 'bank_term_loan':
    case 'bond':
    case 'shareholder_loan': {
      const inst: DebtInstrument = {
        id: nextId(w, 'DEBT'),
        name: f.kind === 'bond' ? `${(o.rateBps / 100).toFixed(2)}% Senior Notes due ${addMonths(d, o.tenorYears * 12).slice(0, 4)}` : f.kind === 'shareholder_loan' ? 'Halvorsen shareholder loan' : `Term Loan B (${f.counterparty})`,
        kind: f.kind === 'bond' ? 'bond' : f.kind === 'shareholder_loan' ? 'shareholder_loan' : 'term_loan',
        lender: f.counterparty,
        lenderCharacterId: f.counterpartyId,
        principalCents: o.amountCents,
        limitCents: o.amountCents,
        rateBps: o.rateBps,
        commitmentFeeBps: 0,
        startDate: d,
        maturityDate: addMonths(d, o.tenorYears * 12),
        interestMonths: f.kind === 'bond' ? [((Number(d.slice(5, 7)) + 5) % 12) + 1, Number(d.slice(5, 7))] : [3, 6, 9, 12],
        paymentDay: 15,
        amortization: [],
        principalDays: 0,
        undrawnDays: 0,
        interestPayableCents: 0,
        status: 'active',
        secured: 0,
        conditions: o.conditions,
      };
      w.debts.push(inst);
      f.instrumentId = inst.id;
      post(w, { description: `${inst.name}: funds received`, sourceType: 'financing', sourceId: src, cf: { category: 'financing', line: 'debt_drawdown' }, lines: [{ account: '1000', amountCents: o.amountCents }, { account: '2700', amountCents: -o.amountCents }] });
      if (o.feesCents > 0) post(w, { description: `${inst.name}: arrangement fees`, sourceType: 'financing', sourceId: src, cf: { category: 'financing', line: 'financing_fees' }, lines: [{ account: '7100', amountCents: o.feesCents }, { account: '1000', amountCents: -o.feesCents }] });
      out.push(`${fmtEur(o.amountCents)} received; new instrument ${inst.name} (${(o.rateBps / 100).toFixed(2)}%, matures ${inst.maturityDate}).`);
      const refi = byId(w.issues, 'ISS-REFI');
      if (refi && f.kind !== 'shareholder_loan') refi.data.securedCents = Number(refi.data.securedCents ?? 0) + o.amountCents;
      break;
    }
    case 'rights_issue':
    case 'ceo_contribution': {
      const net = o.amountCents - o.feesCents;
      post(w, { description: f.kind === 'rights_issue' ? 'Rights issue proceeds' : 'CEO share subscription', sourceType: 'financing', sourceId: src, cf: { category: 'financing', line: 'equity_issued' }, lines: [{ account: '1000', amountCents: net }, { account: '3000', amountCents: -net }] });
      const before = w.meta.sharesOutstanding;
      w.meta.sharesOutstanding += o.newShares ?? 0;
      if (f.kind === 'ceo_contribution') w.meta.ceoPersonalLiquidCents -= o.amountCents;
      if (f.kind === 'rights_issue') {
        const hal = byId(w.characters, 'CHR-HALVORSEN');
        if (hal && hal.trustInCeo < 45) adjustTrust(w, hal.id, -10);
        const refi = byId(w.issues, 'ISS-REFI');
        if (refi) refi.data.securedCents = Number(refi.data.securedCents ?? 0) + net;
      }
      out.push(`${fmtEur(net)} of new equity (net of fees); shares outstanding ${before.toLocaleString('en-GB')} → ${w.meta.sharesOutstanding.toLocaleString('en-GB')} (${(((w.meta.sharesOutstanding - before) / before) * 100).toFixed(1)}% dilution).`);
      break;
    }
    case 'sale_leaseback': {
      const gross = mEur(160);
      const accDep = gross - HQ_BOOK_VALUE_CENTS;
      const gain = o.amountCents - HQ_BOOK_VALUE_CENTS;
      post(w, { description: 'Sale of HQ campus (sale-and-leaseback)', sourceType: 'financing', sourceId: src, cf: { category: 'investing', line: 'asset_disposals' }, lines: [{ account: '1000', amountCents: o.amountCents }, { account: '1510', amountCents: accDep }, { account: '1500', amountCents: -gross }, { account: '4900', amountCents: -gain }] });
      if (o.feesCents > 0) post(w, { description: 'Sale-and-leaseback transaction costs', sourceType: 'financing', sourceId: src, cf: { category: 'investing', line: 'asset_disposals' }, lines: [{ account: '6300', amountCents: o.feesCents }, { account: '1000', amountCents: -o.feesCents }] });
      w.meta.legacyDepMonthlyCents = Math.max(0, w.meta.legacyDepMonthlyCents - mulDiv(HQ_BOOK_VALUE_CENTS, 1, 240));
      w.meta.leaseMonthlyCents += mulDiv(o.leaseAnnualCents ?? 0, 1, 12);
      w.meta.assetsSold.push('HQ_CAMPUS');
      out.push(`HQ campus sold for ${fmtEur(o.amountCents)} (book value ${fmtEur(HQ_BOOK_VALUE_CENTS)}); lease of ${fmtEur(o.leaseAnnualCents ?? 0)}/year starts now.`);
      break;
    }
    case 'covenant_waiver': {
      const until = addMonths(d, 6);
      for (const c of w.covenants.filter((x) => x.instrumentIds.some((id) => ['DEBT-TLA', 'DEBT-RCF'].includes(id)))) {
        c.waiverUntil = until;
        if (c.status === 'breached') c.status = 'waived';
      }
      for (const id of ['DEBT-TLA', 'DEBT-RCF']) {
        const inst = byId(w.debts, id);
        if (inst) inst.rateBps += o.rateBps;
      }
      payOrDefer(w, { description: 'Covenant waiver fee', sourceType: 'financing', sourceId: src, cf: { category: 'financing', line: 'financing_fees' }, debits: [{ account: '7100', amountCents: o.feesCents }], counterpartyId: 'BANKS', category: 'fees' });
      out.push(`Covenants waived until ${until}; fee ${fmtEur(o.feesCents)}; margin +${o.rateBps} bps on TLA and RCF.`);
      break;
    }
  }
  f.status = 'executed';
  f.executedDate = d;
  if (f.counterpartyId) adjustTrust(w, f.counterpartyId, 2);
  emit(w, { type: 'financing_executed', category: 'finance', severity: 'notice', title: `Financing executed: ${f.counterparty}`, description: out.join(' '), causeKind: 'player_action', entities: [{ type: 'financing', id: f.id }], actionId: f.actionId });
  return out;
}

/** Pro-forma analysis attached to financing requests and board proposals. */
export function financingAnalysis(w: World, kind: string, amount: Cents): Record<string, number> {
  const cashIn = ['rcf_repay', 'covenant_waiver'].includes(kind) ? 0 : amount;
  const debtIn = ['bank_term_loan', 'bond', 'shareholder_loan', 'rcf_draw'].includes(kind) ? amount : 0;
  const ebitda = ltm(w, 'ebitdaCents');
  const nd = netDebt(w) + debtIn - cashIn;
  return {
    cashImpactCents: cashIn,
    minLiquidityAfterCents: liquidity(w) + cashIn - (kind === 'rcf_draw' ? amount : 0),
    leverageAfter: ebitda > 0 ? Math.round((nd / ebitda) * 100) / 100 : 99,
    grossDebtAfterCents: grossDebt(w) + debtIn,
    annualInterestCents: kind === 'bond' || kind === 'bank_term_loan' ? Math.round(amount * 0.065) : kind === 'shareholder_loan' ? Math.round(amount * 0.07) : 0,
    dilutionPct: kind === 'rights_issue' ? clamp((amount / (w.meta.sharePriceCents * 0.75) / w.meta.sharesOutstanding) * 100, 0, 200) : kind === 'ceo_contribution' ? (amount / w.meta.sharePriceCents / w.meta.sharesOutstanding) * 100 : 0,
    cash: cash(w),
    debtAccount: -bal(w, '2700'),
  };
}

export type { SimDate };
