/**
 * Negotiation engine.
 *
 * Each counterparty has a private reservation value and an opening (ideal)
 * position per term. An offer's utility to the counterparty is the weighted
 * mean of per-term scores u = (x − R) / (I − R) (1 at their ideal, 0 at their
 * walk-away point, negative beyond it). Terms worse than the reservation are
 * *hard* violations — no amount of persuasion overrides them.
 *
 * The acceptance threshold starts at `baseThreshold` and falls with each round
 * (concession), with trust in the CEO, with the assessed quality of the CEO's
 * argument (bounded: −0.05…+0.10, and only when backed by verifiable facts),
 * with time pressure and with the CEO's alternatives (leverage). Persuasion can
 * move the counterparty within its feasible zone, never outside it.
 */
import type { Contract, Negotiation, NegotiationRound, NegotiationTerm, Payable } from '../../shared/domain';
import { addDays, diffDays, type SimDate } from '../../shared/dates';
import { eur, mEur, times } from '../../shared/money';
import { adjustTrust, byId, clamp, emit, nextId, remember, type World } from './world';
import { post } from './ledger';
import { payOrDefer } from './treasury';

export interface NegotiationTemplate {
  key: string;
  title: string;
  counterpartyId: string;
  terms: NegotiationTerm[];
  defaultIdeal: Record<string, number>;
  defaultReservation: Record<string, number>;
  weights: Record<string, number>;
  baseThreshold: number;
  concessionPerRound: number;
  maxRounds: number;
  /** Days the counterparty needs for internal approval once it says yes (0 = immediate). */
  approvalDays: number;
  approvalBody: string;
  /** Hard constraints beyond the reservation values (e.g. physical capacity). */
  check?: (terms: Record<string, number>) => string[];
  /** Situational adjustment to the threshold (positive = harder to satisfy). */
  situation?: (w: World, n: Negotiation) => { adj: number; notes: string[] };
  /** Whether the template can currently be opened. */
  available?: (w: World) => string | null;
  contractTitle: string;
  contractKind: Contract['kind'];
  /** Total contract value for approval-threshold purposes. */
  value: (w: World, terms: Record<string, number>) => number;
  /** Up-front cash commitment for approval/limit checks. */
  upfrontCents: (w: World, terms: Record<string, number>) => number;
  describe: (terms: Record<string, number>) => string;
  /** Apply the effects of a signed contract to the world. */
  apply: (w: World, terms: Record<string, number>, contract: Contract) => string[];
  /** What the deal is for, in plain words (shown when choosing a deal to open). */
  description?: string;
  /** Grouping in the deal builder. */
  category?: 'supply' | 'sales' | 'people' | 'partners' | 'dealers';
}

const pct = (x: number) => `${x.toFixed(1)}%`;

export const NEGOTIATION_TEMPLATES: Record<string, NegotiationTemplate> = {
  voltaris_supply: {
    key: 'voltaris_supply',
    title: 'Voltaris volume & capacity amendment',
    description: 'More battery packs a day for the Eon from Voltaris, in exchange for price, a prepayment and a take-or-pay commitment.',
    category: 'supply',
    counterpartyId: 'CHR-SUND',
    terms: [
      { key: 'dailyVolume', label: 'Guaranteed capacity', unit: 'units_per_day', min: 140, max: 350, step: 10, ceoPrefers: 'high', description: 'Battery packs per working day available from ~120 days after signature.' },
      { key: 'priceEur', label: 'Price per pack', unit: 'eur', min: 8_800, max: 10_200, step: 50, ceoPrefers: 'low', description: 'Applies to all packs, including the existing 140/day.' },
      { key: 'prepaymentM', label: 'Prepayment', unit: 'eur_m', min: 0, max: 120, step: 5, ceoPrefers: 'low', description: 'Cash advance to fund the second module line, recovered against future invoices.' },
      { key: 'takeOrPayPct', label: 'Take-or-pay', unit: 'pct', min: 0, max: 100, step: 5, ceoPrefers: 'low', description: 'Share of guaranteed capacity Asterion pays for even if not called off.' },
    ],
    defaultIdeal: { dailyVolume: 300, priceEur: 9_650, prepaymentM: 80, takeOrPayPct: 85 },
    defaultReservation: { dailyVolume: 300, priceEur: 9_050, prepaymentM: 40, takeOrPayPct: 60 },
    weights: { priceEur: 0.4, prepaymentM: 0.35, takeOrPayPct: 0.25 },
    baseThreshold: 0.72,
    concessionPerRound: 0.08,
    maxRounds: 7,
    approvalDays: 0,
    approvalBody: 'Voltaris board',
    check: (t) => (t.dailyVolume > 320 ? ['Voltaris cannot build more than 320 packs/day with one additional module line.'] : t.dailyVolume < 200 ? ['Below 200 packs/day the expansion does not pay for itself — Voltaris will not invest for less.'] : []),
    situation: (w) => {
      const notes: string[] = [];
      let adj = 0;
      const days = diffDays('2027-06-30', w.meta.currentDate);
      if (days < 75) {
        adj -= 0.08;
        notes.push('Voltaris is under pressure from its lenders (mid-2027 deadline).');
      }
      const alt = w.supplies.find((s) => s.component === 'Battery pack' && s.isAlternative && s.modelIds.includes('MDL-EON'));
      const altProject = w.projects.find((p) => p.templateKey === 'second_battery_source' && ['active', 'delayed'].includes(p.status));
      if (alt || altProject) {
        adj -= 0.1;
        notes.push('Asterion has a credible second battery source in progress.');
      }
      return { adj, notes };
    },
    contractTitle: 'Voltaris capacity amendment No. 1',
    contractKind: 'supply',
    value: (_w, t) => mEur(t.prepaymentM) + times(eur(t.priceEur), t.dailyVolume * 230 * 3),
    upfrontCents: (_w, t) => mEur(t.prepaymentM),
    describe: (t) => `${t.dailyVolume} packs/day from ~120 days after signature at €${t.priceEur.toLocaleString('en-GB')}/pack, €${t.prepaymentM}m prepayment, ${t.takeOrPayPct}% take-or-pay.`,
    apply: (w, t, contract) => {
      const out: string[] = [];
      const supply = byId(w.supplies, 'SPL-VOL-PACK');
      if (supply) {
        supply.unitPriceCents = eur(t.priceEur);
        const date = addDays(w.meta.currentDate, 120);
        supply.pendingCapacity.push({ date, dailyCapacity: t.dailyVolume, reason: contract.title });
        supply.contractId = contract.id;
        out.push(`Battery-pack price set to €${t.priceEur}; capacity rises to ${t.dailyVolume}/day on ${date}.`);
      }
      if (t.prepaymentM > 0) {
        const amt = mEur(t.prepaymentM);
        const p: Payable = { id: nextId(w, 'AP'), counterpartyId: 'SUP-VOLTARIS', category: 'prepayment', amountCents: amt, issueDate: w.meta.currentDate, dueDate: addDays(w.meta.currentDate, 10), status: 'open', paidDate: null, sourceId: contract.id, liabilityAccount: '2000' };
        w.payables.push(p);
        post(w, { description: `Voltaris prepayment invoice (${contract.title})`, sourceType: 'contract', sourceId: contract.id, lines: [{ account: '1150', amountCents: amt }, { account: '2000', amountCents: -amt }] });
        out.push(`€${t.prepaymentM}m prepayment payable within 10 days (recorded as a supplier prepayment asset, recovered against invoices).`);
      }
      const sup = byId(w.suppliers, 'SUP-VOLTARIS');
      if (sup) {
        sup.financialHealth = clamp(sup.financialHealth + 15, 0, 100);
        sup.relationship = clamp(sup.relationship + 10, 0, 100);
      }
      contract.obligations.push({ text: `Take-or-pay: pay for at least ${t.takeOrPayPct}% of ${t.dailyVolume} packs/day once capacity is live`, dueDate: null, status: 'open' });
      return out;
    },
  },

  labor_agreement: {
    key: 'labor_agreement',
    title: 'Collective wage agreement 2027–2029',
    description: 'Wages, a one-off payment and a job guarantee for the plants. A signed agreement brings a peace obligation: no strikes while it runs.',
    category: 'people',
    counterpartyId: 'CHR-NOVAK',
    terms: [
      { key: 'wageIncreasePct', label: 'Wage increase (year 1)', unit: 'pct', min: 0, max: 8, step: 0.1, ceoPrefers: 'low', description: 'Increase to base pay for all ~18,000 employees from signature.' },
      { key: 'oneOffBonusEur', label: 'One-off payment per employee', unit: 'eur', min: 0, max: 2_000, step: 50, ceoPrefers: 'low', description: 'Paid once with the next payroll.' },
      { key: 'jobGuaranteeMonths', label: 'Job guarantee (plants)', unit: 'months', min: 0, max: 60, step: 6, ceoPrefers: 'low', description: 'No compulsory redundancies at the three plants for this period.' },
    ],
    defaultIdeal: { wageIncreasePct: 6.0, oneOffBonusEur: 1_200, jobGuaranteeMonths: 48 },
    defaultReservation: { wageIncreasePct: 3.4, oneOffBonusEur: 300, jobGuaranteeMonths: 12 },
    weights: { wageIncreasePct: 0.55, oneOffBonusEur: 0.15, jobGuaranteeMonths: 0.3 },
    baseThreshold: 0.7,
    concessionPerRound: 0.07,
    maxRounds: 8,
    approvalDays: 10,
    approvalBody: 'union members’ ballot',
    available: (w) => {
      const current = w.contracts.find((c) => c.kind === 'labor' && c.status === 'active' && c.signedDate && c.signedDate >= '2027-01-01' && c.endDate && c.endDate > addDays(w.meta.currentDate, 180));
      return current ? `The current agreement runs until ${current.endDate}; talks on the next one open six months before it expires.` : null;
    },
    situation: (w) => {
      const notes: string[] = [];
      let adj = 0;
      if (w.meta.currentDate > '2027-03-31' && !w.contracts.some((c) => c.kind === 'labor' && c.status === 'active' && c.endDate && c.endDate >= w.meta.currentDate)) {
        adj -= 0.04;
        notes.push('The old agreement has expired; both sides feel the cost of conflict.');
      }
      const restructuring = w.departments.some((d) => d.kind === 'plant' && d.leaving.length > 0);
      if (restructuring) {
        adj += 0.12;
        notes.push('Announced job cuts harden the union position.');
      }
      if (w.meta.currentDate < '2027-06-15' && w.meta.currentDate > '2027-04-15') {
        adj += 0.03;
        notes.push('Union leadership election in June — Novak needs a visible win.');
      }
      return { adj, notes };
    },
    contractTitle: 'Collective wage agreement 2027–2029',
    contractKind: 'labor',
    value: (w, t) => {
      const payroll = w.departments.reduce((a, d) => a + d.headcount * d.annualCostPerHeadCents, 0);
      return Math.round(payroll * (t.wageIncreasePct / 100) * 2) + times(eur(t.oneOffBonusEur), w.departments.reduce((a, d) => a + d.headcount, 0));
    },
    upfrontCents: (w, t) => times(eur(t.oneOffBonusEur), w.departments.reduce((a, d) => a + d.headcount, 0)),
    describe: (t) => `${pct(t.wageIncreasePct)} wage increase, €${t.oneOffBonusEur} one-off payment, ${t.jobGuaranteeMonths}-month job guarantee at the plants.`,
    apply: (w, t, contract) => {
      const out: string[] = [];
      w.meta.wageIndex = Math.round(w.meta.wageIndex * (1 + t.wageIncreasePct / 100) * 10_000) / 10_000;
      out.push(`Personnel cost index rises by ${pct(t.wageIncreasePct)} (now ${w.meta.wageIndex.toFixed(4)}).`);
      if (t.oneOffBonusEur > 0) {
        const lines = w.departments.map((d) => ({ account: d.expenseAccount, amountCents: times(eur(t.oneOffBonusEur), d.headcount) }));
        const total = lines.reduce((a, l) => a + l.amountCents, 0);
        payOrDefer(w, { description: `One-off payment under ${contract.title}`, sourceType: 'contract', sourceId: contract.id, cf: { category: 'operating', line: 'payroll' }, debits: lines, counterpartyId: 'EMPLOYEES', category: 'payroll' });
        out.push(`One-off payment of €${t.oneOffBonusEur} per employee paid (€${(total / 1e8).toFixed(1)}m).`);
      }
      if (t.jobGuaranteeMonths > 0) {
        const due = addDays(w.meta.currentDate, Math.round(t.jobGuaranteeMonths * 30.44));
        w.commitments.push({
          id: nextId(w, 'COM'), promisorId: 'ceo', promiseeId: 'CHR-NOVAK', description: `No compulsory redundancies at Lyon, Sevilla and Brno until ${due} (collective agreement).`, dueDate: due,
          conditions: 'Contractual job guarantee; breaking it frees the union from the peace obligation.', status: 'open', createdDate: w.meta.currentDate, source: 'contract', sourceId: contract.id,
          check: { type: 'no_headcount_reduction', departmentIds: w.departments.filter((d) => d.kind === 'plant').map((d) => d.id) }, resolvedDate: null, notifiedUpcoming: 0, importance: 5,
        });
        out.push(`Job guarantee for plant workforces until ${due} recorded as a commitment.`);
      }
      for (const d of w.departments) d.morale = clamp(d.morale + 6, 0, 100);
      const old = byId(w.contracts, 'CON-LABOR-2025');
      if (old && old.status === 'active') old.status = 'superseded';
      contract.startDate = w.meta.currentDate;
      // Runs at least two years, and at least to the end of the period in its title.
      const titleEnd = `${contract.title.match(/(\d{4})\D*$/)?.[1] ?? '0000'}-12-31`;
      contract.endDate = [addDays(w.meta.currentDate, 730), titleEnd].sort().pop()!;
      return out;
    },
  },

  hanseatic_second_source: {
    key: 'hanseatic_second_source',
    title: 'Hanseatic Eon battery-pack second source',
    description: 'A second supplier of Eon battery packs: resilience and leverage over Voltaris. Packs flow after ~7 months of qualification.',
    category: 'supply',
    counterpartyId: 'CHR-HARTMANN',
    terms: [
      { key: 'packPriceEur', label: 'Price per pack', unit: 'eur', min: 8_800, max: 10_800, step: 50, ceoPrefers: 'low', description: 'Hanseatic Eon-compatible 77 kWh pack.' },
      { key: 'dailyCapacity', label: 'Capacity', unit: 'units_per_day', min: 50, max: 250, step: 10, ceoPrefers: 'high', description: 'Packs per day after qualification (~7 months).' },
      { key: 'developmentFeeM', label: 'Development & qualification fee', unit: 'eur_m', min: 0, max: 60, step: 1, ceoPrefers: 'low', description: 'One-off engineering fee paid on signature.' },
    ],
    defaultIdeal: { packPriceEur: 9_950, dailyCapacity: 150, developmentFeeM: 32 },
    defaultReservation: { packPriceEur: 9_350, dailyCapacity: 150, developmentFeeM: 16 },
    weights: { packPriceEur: 0.6, developmentFeeM: 0.4 },
    baseThreshold: 0.68,
    concessionPerRound: 0.08,
    maxRounds: 6,
    approvalDays: 7,
    approvalBody: 'Hanseatic management board',
    check: (t) => (t.dailyCapacity > 180 ? ['Hanseatic can commit at most 180 packs/day from its Hamburg line.'] : []),
    available: (w) => (w.contracts.some((c) => c.templateKey === 'hanseatic_second_source' && c.status === 'active') ? 'A second-source contract with Hanseatic is already active.' : null),
    contractTitle: 'Hanseatic Eon pack second-source agreement',
    contractKind: 'supply',
    value: (_w, t) => mEur(t.developmentFeeM) + times(eur(t.packPriceEur), t.dailyCapacity * 230 * 3),
    upfrontCents: (_w, t) => mEur(t.developmentFeeM),
    describe: (t) => `${t.dailyCapacity} packs/day after ~7 months of qualification at €${t.packPriceEur.toLocaleString('en-GB')}/pack; €${t.developmentFeeM}m development fee.`,
    apply: (w, t, contract) => {
      const date = addDays(w.meta.currentDate, 210);
      w.supplies.push({
        id: 'SPL-HAN-PACK', supplierId: 'SUP-HANSEATIC', component: 'Battery pack', modelIds: ['MDL-EON'], unitPriceCents: eur(t.packPriceEur), dailyCapacity: 0, stockUnits: 0, targetStockDays: 4,
        disruptionFactor: 0, disruptionUntil: null, pendingCapacity: [{ date, dailyCapacity: t.dailyCapacity, reason: contract.title }], contractId: contract.id, isAlternative: 1,
      });
      const fee = mEur(t.developmentFeeM);
      if (fee > 0) {
        w.payables.push({ id: nextId(w, 'AP'), counterpartyId: 'SUP-HANSEATIC', category: 'capex', amountCents: fee, issueDate: w.meta.currentDate, dueDate: addDays(w.meta.currentDate, 30), status: 'open', paidDate: null, sourceId: contract.id, liabilityAccount: '2000' });
        post(w, { description: `Hanseatic development fee (${contract.title})`, sourceType: 'contract', sourceId: contract.id, lines: [{ account: '1600', amountCents: fee }, { account: '2000', amountCents: -fee }] });
      }
      return [`Second battery source: ${t.dailyCapacity} packs/day available from ${date} (after qualification).`, `€${t.developmentFeeM}m development fee capitalised and payable in 30 days.`];
    },
  },

  hanseatic_cost_share: {
    key: 'hanseatic_cost_share',
    title: 'Hanseatic inverter warranty cost-sharing',
    description: 'Recover part of the Kora inverter field-action cost from the supplier whose part failed.',
    category: 'supply',
    counterpartyId: 'CHR-HARTMANN',
    terms: [{ key: 'costSharePct', label: 'Hanseatic share of field-action cost', unit: 'pct', min: 0, max: 100, step: 5, ceoPrefers: 'high', description: 'Contract allows up to 50% recovery for systematic defects.' }],
    defaultIdeal: { costSharePct: 15 },
    defaultReservation: { costSharePct: 45 },
    weights: { costSharePct: 1 },
    baseThreshold: 0.7,
    concessionPerRound: 0.1,
    maxRounds: 5,
    approvalDays: 5,
    approvalBody: 'Hanseatic management board',
    available: (w) => {
      const iss = byId(w.issues, 'ISS-KORA-INV');
      if (!iss || iss.data.rootCause !== 'confirmed') return 'Requires a completed root-cause investigation that attributes the inverter fault to Hanseatic.';
      if (!iss.chosenOptions.includes('service_campaign') && !iss.chosenOptions.includes('recall')) return 'There is no field-action cost to share yet.';
      return null;
    },
    situation: (w) => {
      const iss = byId(w.issues, 'ISS-KORA-INV');
      return iss?.data.rootCause === 'confirmed' ? { adj: -0.1, notes: ['Teardown evidence attributes the fault to a Hanseatic capacitor batch.'] } : { adj: 0, notes: [] };
    },
    contractTitle: 'Hanseatic inverter cost-sharing settlement',
    contractKind: 'service',
    value: (w, t) => Math.round(Number(byId(w.issues, 'ISS-KORA-INV')?.data.campaignCostCents ?? 0) * t.costSharePct / 100),
    upfrontCents: () => 0,
    describe: (t) => `Hanseatic reimburses ${t.costSharePct}% of the inverter field-action cost.`,
    apply: (w, t, contract) => {
      const cost = Number(byId(w.issues, 'ISS-KORA-INV')?.data.campaignCostCents ?? 0);
      const credit = Math.round((cost * t.costSharePct) / 100);
      if (credit <= 0) return ['No recoverable cost recorded.'];
      w.payables.push({ id: nextId(w, 'AP'), counterpartyId: 'SUP-HANSEATIC', category: 'warranty', amountCents: -credit, issueDate: w.meta.currentDate, dueDate: addDays(w.meta.currentDate, 15), status: 'open', paidDate: null, sourceId: contract.id, liabilityAccount: '2000' });
      post(w, { description: `Hanseatic credit note (${contract.title})`, sourceType: 'contract', sourceId: contract.id, lines: [{ account: '2000', amountCents: credit }, { account: '6800', amountCents: -credit }] });
      return [`Hanseatic credit note of €${(credit / 1e8).toFixed(1)}m, settled within 15 days.`];
    },
  },

  dealer_agreement: {
    key: 'dealer_agreement',
    title: 'Dealer council: Vela stock support & Eon margin',
    description: 'Pay dealers to clear Vela stock (a temporary sales push) and agree their margin on the Eon. Wins the dealers over.',
    category: 'dealers',
    counterpartyId: 'CHR-BELLINI',
    terms: [
      { key: 'velaSupportEur', label: 'Vela stock support per unit in dealer stock', unit: 'eur', min: 0, max: 1_500, step: 50, ceoPrefers: 'low', description: 'One-off support paid on current dealer Vela stock (credited against invoices).' },
      { key: 'eonMarginPct', label: 'Dealer margin on Eon', unit: 'pct', min: 7, max: 13, step: 0.25, ceoPrefers: 'low', description: 'Dealer margin as % of list price (baseline assumption 10%).' },
    ],
    defaultIdeal: { velaSupportEur: 900, eonMarginPct: 11.5 },
    defaultReservation: { velaSupportEur: 250, eonMarginPct: 9.5 },
    weights: { velaSupportEur: 0.6, eonMarginPct: 0.4 },
    baseThreshold: 0.65,
    concessionPerRound: 0.09,
    maxRounds: 6,
    approvalDays: 0,
    approvalBody: 'Dealer council',
    available: (w) => (w.contracts.some((c) => c.templateKey === 'dealer_agreement' && c.status === 'active') ? 'A dealer support agreement is already active.' : null),
    situation: (w) => {
      const vela = byId(w.models, 'MDL-VELA');
      const days = vela && vela.retailLastMonth > 0 ? (vela.dealerStock / vela.retailLastMonth) * 30 : 0;
      return days > 70 ? { adj: 0.06, notes: ['Dealers are carrying very high Vela stock and financing costs.'] } : { adj: 0, notes: [] };
    },
    contractTitle: 'Dealer support agreement 2027',
    contractKind: 'dealer',
    value: (w, t) => times(eur(t.velaSupportEur), byId(w.models, 'MDL-VELA')?.dealerStock ?? 0),
    upfrontCents: (w, t) => times(eur(t.velaSupportEur), byId(w.models, 'MDL-VELA')?.dealerStock ?? 0),
    describe: (t) => `€${t.velaSupportEur} per Vela in dealer stock; Eon dealer margin ${t.eonMarginPct}%.`,
    apply: (w, t, contract) => {
      const out: string[] = [];
      const vela = byId(w.models, 'MDL-VELA');
      if (vela && t.velaSupportEur > 0) {
        const amt = times(eur(t.velaSupportEur), vela.dealerStock);
        w.payables.push({ id: nextId(w, 'AP'), counterpartyId: 'DEALERS', category: 'other', amountCents: amt, issueDate: w.meta.currentDate, dueDate: addDays(w.meta.currentDate, 30), status: 'open', paidDate: null, sourceId: contract.id, liabilityAccount: '2000' });
        post(w, { description: `Vela dealer stock support (${contract.title})`, sourceType: 'contract', sourceId: contract.id, lines: [{ account: '4000', amountCents: amt }, { account: '2000', amountCents: -amt }] });
        vela.demandModifier = 1.08;
        vela.demandModifierUntil = addDays(w.meta.currentDate, 90);
        out.push(`Dealer support of €${(amt / 1e8).toFixed(1)}m recognised as a revenue deduction; dealers push Vela retail (+8% for 90 days).`);
      }
      const eon = byId(w.models, 'MDL-EON');
      if (eon) {
        const factor = 1 - (t.eonMarginPct - 10) / 100;
        eon.netPriceCents = Math.round((eon.netPriceCents * factor) / 100) * 100;
        out.push(`Eon net price per unit adjusted for a ${t.eonMarginPct}% dealer margin: €${(eon.netPriceCents / 100).toLocaleString('en-GB')}.`);
      }
      adjustTrust(w, 'CHR-BELLINI', 8);
      return out;
    },
  },
  ...fleetTemplates(),

  contract_assembly: {
    key: 'contract_assembly',
    title: 'Contract assembly at Lyon for Shenlong',
    description: 'Shenlong wants to build cars inside the EU to avoid tariffs. It pays a fee per car assembled at Lyon, using spare Lyon capacity and crews — income and work for Lyon, but it helps a competitor.',
    category: 'partners',
    counterpartyId: 'CHR-ZHANG',
    terms: [
      { key: 'carsPerDay', label: 'Partner cars per day', unit: 'units_per_day', min: 60, max: 200, step: 10, ceoPrefers: 'high', description: 'Lyon capacity and crews reserved for the partner from ~4 months after signature.' },
      { key: 'feePerCarEur', label: 'Assembly fee per car', unit: 'eur', min: 1_500, max: 4_200, step: 100, ceoPrefers: 'high', description: 'Paid by Shenlong for each car built (30-day terms).' },
      { key: 'years', label: 'Term', unit: 'years', min: 1, max: 5, step: 1, ceoPrefers: 'high', description: 'How long the arrangement runs.' },
    ],
    defaultIdeal: { carsPerDay: 160, feePerCarEur: 1_900, years: 2 },
    defaultReservation: { carsPerDay: 80, feePerCarEur: 3_300, years: 4 },
    weights: { feePerCarEur: 0.6, years: 0.25, carsPerDay: 0.15 },
    baseThreshold: 0.7,
    concessionPerRound: 0.08,
    maxRounds: 6,
    approvalDays: 14,
    approvalBody: 'Shenlong Europe board',
    available: (w) => (!byId(w.characters, 'CHR-ZHANG') ? 'Shenlong is not present in this saved game (start a new game to use this deal).' : w.contracts.some((c) => c.templateKey === 'contract_assembly' && ['active', 'agreed'].includes(c.status)) ? 'A contract-assembly arrangement is already in place.' : null),
    situation: (w) => {
      const lyon = byId(w.lines, 'LINE-LYON-VELA');
      const spare = lyon ? lyon.maxDailyRate - lyon.plannedDailyRate : 0;
      return spare < 120 ? { adj: 0.05, notes: ['Shenlong doubts Lyon has enough spare capacity.'] } : { adj: -0.03, notes: ['Lyon has plenty of idle capacity — Shenlong knows it can be served well.'] };
    },
    contractTitle: 'Shenlong contract-assembly agreement (Lyon)',
    contractKind: 'service',
    value: (_w, t) => Math.round(t.carsPerDay * 230 * t.years * t.feePerCarEur * 100),
    upfrontCents: () => 0,
    describe: (t) => `${t.carsPerDay} Shenlong cars a day assembled at Lyon for €${t.feePerCarEur.toLocaleString('en-GB')} each, for ${t.years} year${t.years > 1 ? 's' : ''}.`,
    apply: (w, t, contract) => {
      const out: string[] = [];
      const start = addDays(w.meta.currentDate, 120);
      contract.terms.productionStart = start;
      contract.startDate = start;
      contract.endDate = addDays(start, Math.round(t.years * 365));
      const f = byId(w.factories, 'FAC-LYON');
      const line = byId(w.lines, 'LINE-LYON-VELA');
      if (f) f.fixedCrew = Math.round(f.fixedCrew + t.carsPerDay * f.crewPerDailyUnit);
      if (line) {
        line.maxDailyRate = Math.max(0, line.maxDailyRate - t.carsPerDay);
        if (line.plannedDailyRate > line.maxDailyRate) {
          out.push(`${line.name} planned rate cut from ${line.plannedDailyRate} to ${line.maxDailyRate}/day to make room.`);
          line.plannedDailyRate = line.maxDailyRate;
        }
      }
      out.push(`Partner production of ${t.carsPerDay}/day starts ${start}: about €${Math.round((t.carsPerDay * 230 * t.feePerCarEur) / 1e6)}m of fees a year; Lyon needs ≈${Math.round(t.carsPerDay * (f?.crewPerDailyUnit ?? 8))} more people on the lines; Vela capacity reduced by ${t.carsPerDay}/day.`);
      adjustTrust(w, 'CHR-NOVAK', 5);
      return out;
    },
  },

  hanseatic_price: {
    key: 'hanseatic_price',
    title: 'Hanseatic hybrid-module price review',
    description: 'Lower the price of the Kora hybrid battery & inverter module (≈€3,100 per car) in exchange for a longer contract and a volume commitment.',
    category: 'supply',
    counterpartyId: 'CHR-HARTMANN',
    terms: [
      { key: 'priceCutPct', label: 'Price reduction', unit: 'pct', min: 0, max: 10, step: 0.5, ceoPrefers: 'high', description: 'Reduction on the Kora hybrid module price.' },
      { key: 'extensionYears', label: 'Contract extension', unit: 'years', min: 0, max: 5, step: 1, ceoPrefers: 'low', description: 'Years added to the supply agreement (sole source).' },
      { key: 'volumeCommitPct', label: 'Volume commitment', unit: 'pct', min: 50, max: 100, step: 5, ceoPrefers: 'low', description: 'Share of current Kora volume Asterion commits to buy (take-or-pay).' },
    ],
    defaultIdeal: { priceCutPct: 1, extensionYears: 5, volumeCommitPct: 95 },
    defaultReservation: { priceCutPct: 6, extensionYears: 2, volumeCommitPct: 75 },
    weights: { priceCutPct: 0.55, extensionYears: 0.25, volumeCommitPct: 0.2 },
    baseThreshold: 0.7,
    concessionPerRound: 0.08,
    maxRounds: 6,
    approvalDays: 7,
    approvalBody: 'Hanseatic management board',
    available: (w) => (w.contracts.some((c) => c.templateKey === 'hanseatic_price' && c.status === 'active') ? 'The price review has already been agreed.' : null),
    situation: (w) => {
      const iss = byId(w.issues, 'ISS-KORA-INV');
      return iss && iss.data.rootCause === 'confirmed' ? { adj: -0.05, notes: ['Hanseatic is on the back foot after the inverter fault.'] } : { adj: 0, notes: [] };
    },
    contractTitle: 'Hanseatic hybrid-module price amendment',
    contractKind: 'supply',
    value: (w, t) => Math.round((byId(w.supplies, 'SPL-HAN-HYB')?.unitPriceCents ?? 0) * (t.priceCutPct / 100) * 13_000 * 12),
    upfrontCents: () => 0,
    describe: (t) => `${t.priceCutPct}% off the hybrid module, contract extended by ${t.extensionYears} year${t.extensionYears === 1 ? '' : 's'}, ${t.volumeCommitPct}% volume commitment.`,
    apply: (w, t) => {
      const out: string[] = [];
      const sup = byId(w.supplies, 'SPL-HAN-HYB');
      if (sup) {
        const before = sup.unitPriceCents;
        sup.unitPriceCents = Math.round(before * (1 - t.priceCutPct / 100));
        out.push(`Kora hybrid module €${Math.round(before / 100).toLocaleString('en-GB')} → €${Math.round(sup.unitPriceCents / 100).toLocaleString('en-GB')} per car.`);
      }
      const base = byId(w.contracts, 'CON-HANSEATIC');
      if (base && base.endDate && t.extensionYears > 0) {
        base.endDate = addDays(base.endDate, Math.round(t.extensionYears * 365));
        out.push(`Hanseatic supply agreement extended to ${base.endDate}.`);
      }
      return out;
    },
  },
};

/** Fleet sales: one template per model, with a rental & leasing buyer. */
function fleetTemplates(): Record<string, NegotiationTemplate> {
  const specs: [string, string, number, number][] = [
    ['MDL-VELA', 'Vela', 24, 14],
    ['MDL-KORA', 'Kora', 18, 10],
    ['MDL-EON', 'Eon', 14, 7],
  ];
  const out: Record<string, NegotiationTemplate> = {};
  for (const [modelId, name, idealDisc, resDisc] of specs) {
    const key = `fleet_${name.toLowerCase()}`;
    out[key] = {
      key,
      title: `Fleet order: ${name} for EuroFleet Mobility`,
      description: `Sell a block of ${name}s to a rental & leasing company at a discount. Cars are delivered from factory stock over the agreed months — a way to use capacity or clear stock, at a lower price per car (dealers dislike it).`,
      category: 'sales',
      counterpartyId: 'CHR-KRAUS',
      terms: [
        { key: 'units', label: 'Cars', unit: 'count', min: 1_000, max: 12_000, step: 500, ceoPrefers: 'high', description: 'Total cars ordered.' },
        { key: 'discountPct', label: 'Discount on net price', unit: 'pct', min: 4, max: 30, step: 0.5, ceoPrefers: 'low', description: 'Off the dealer net price.' },
        { key: 'months', label: 'Delivery period', unit: 'months', min: 3, max: 12, step: 1, ceoPrefers: 'low', description: 'Deliveries spread evenly over this period, from factory stock.' },
      ],
      defaultIdeal: { units: 3_000, discountPct: idealDisc, months: 12 },
      defaultReservation: { units: 9_000, discountPct: resDisc, months: 4 },
      weights: { discountPct: 0.7, units: 0.15, months: 0.15 },
      baseThreshold: 0.68,
      concessionPerRound: 0.09,
      maxRounds: 6,
      approvalDays: 5,
      approvalBody: 'EuroFleet procurement committee',
      available: (w) => {
        if (!byId(w.characters, 'CHR-KRAUS')) return 'EuroFleet is not present in this saved game (start a new game to use this deal).';
        if (byId(w.models, modelId)?.status !== 'in_production') return `The ${name} is not on sale.`;
        if (w.contracts.some((c) => c.templateKey === key && ['active', 'agreed'].includes(c.status))) return `A ${name} fleet order is already running.`;
        return null;
      },
      situation: (w) => {
        const m = byId(w.models, modelId);
        const stockDays = m && m.retailLastMonth > 0 ? ((m.dealerStock + m.fgUnits) / m.retailLastMonth) * 30 : 0;
        return stockDays > 75 ? { adj: 0.04, notes: [`EuroFleet knows ${name} stock is piling up and pushes for a bigger discount.`] } : { adj: 0, notes: [] };
      },
      contractTitle: `EuroFleet ${name} fleet order`,
      contractKind: 'service',
      value: (w, t) => Math.round((byId(w.models, modelId)?.netPriceCents ?? 0) * (1 - t.discountPct / 100) * t.units),
      upfrontCents: () => 0,
      describe: (t) => `${t.units.toLocaleString('en-GB')} ${name}s at ${t.discountPct}% off the net price, delivered over ${t.months} months.`,
      apply: (w, t, contract) => {
        const m = byId(w.models, modelId);
        contract.terms.modelId = modelId;
        contract.terms.delivered = 0;
        contract.terms.workingDaysElapsed = 0;
        contract.endDate = addDays(w.meta.currentDate, Math.round(t.months * 30.4));
        adjustTrust(w, 'CHR-BELLINI', -2);
        return [`${t.units.toLocaleString('en-GB')} ${name}s to deliver from factory stock by ${contract.endDate} (≈${Math.ceil(t.units / (t.months * 21.5))} a working day) at €${Math.round(((m?.netPriceCents ?? 0) * (1 - t.discountPct / 100)) / 100).toLocaleString('en-GB')} each. Build them: the lines must produce for the order on top of dealer demand.`];
      },
    };
  }
  return out;
}

// ---------------------------------------------------------------- evaluation

export function termScore(n: Negotiation, key: string, x: number): number {
  const I = n.ideal[key];
  const R = n.reservation[key];
  if (I === undefined || R === undefined || I === R) return 1;
  return (x - R) / (I - R);
}

/** Hard violations: any term worse for the counterparty than its reservation value. */
export function violations(n: Negotiation, terms: Record<string, number>): string[] {
  const t = NEGOTIATION_TEMPLATES[n.templateKey];
  const out: string[] = [];
  for (const key of Object.keys(n.weights)) {
    const s = termScore(n, key, terms[key]);
    if (s < -1e-9) {
      const def = n.terms.find((d) => d.key === key);
      out.push(`${def?.label ?? key} is beyond what ${t?.approvalBody ?? 'the counterparty'} can accept.`);
    }
  }
  if (t?.check) out.push(...t.check(terms));
  return out;
}

export function utility(n: Negotiation, terms: Record<string, number>): number {
  let s = 0;
  let wsum = 0;
  for (const [key, wgt] of Object.entries(n.weights)) {
    s += wgt * clamp(termScore(n, key, terms[key]), -1, 1.2);
    wsum += wgt;
  }
  return wsum > 0 ? s / wsum : 1;
}

export function ceoRounds(n: Negotiation): number {
  return n.rounds.filter((r) => r.by === 'ceo').length;
}

export interface Evaluation {
  utility: number;
  threshold: number;
  accepted: boolean;
  violations: string[];
  argumentQuality: number;
  notes: string[];
}

export function threshold(w: World, n: Negotiation, argumentQuality: number): { value: number; notes: string[] } {
  const t = NEGOTIATION_TEMPLATES[n.templateKey];
  const notes: string[] = [];
  const cp = byId(w.characters, n.counterpartyId);
  let th = n.baseThreshold - n.concessionPerRound * ceoRounds(n);
  const trustAdj = cp ? (cp.trustInCeo - 50) / 500 : 0;
  th -= trustAdj;
  if (Math.abs(trustAdj) > 0.02) notes.push(trustAdj > 0 ? 'Counterparty trusts you, which helps.' : 'Low trust makes the counterparty cautious.');
  th -= clamp(argumentQuality, -0.05, 0.1);
  if (argumentQuality > 0.03) notes.push('Your argument was persuasive and backed by facts.');
  if (argumentQuality < -0.02) notes.push('Your argument came across as weak or unsupported.');
  const sit = t?.situation?.(w, n);
  if (sit) {
    th += sit.adj;
    notes.push(...sit.notes);
  }
  if (n.deadline && diffDays(n.deadline, w.meta.currentDate) <= 14) {
    th -= 0.03;
    notes.push('The deadline is close; both sides want closure.');
  }
  return { value: clamp(th, 0, 0.95), notes };
}

export function evaluateOffer(w: World, n: Negotiation, terms: Record<string, number>, argumentQuality: number): Evaluation {
  const v = violations(n, terms);
  const u = utility(n, terms);
  const th = threshold(w, n, argumentQuality);
  return { utility: Math.round(u * 1000) / 1000, threshold: Math.round(th.value * 1000) / 1000, accepted: v.length === 0 && u >= th.value - 1e-9, violations: v, argumentQuality, notes: th.notes };
}

function roundToStep(def: NegotiationTerm, x: number): number {
  const v = Math.round(x / def.step) * def.step;
  return Math.round(clamp(v, def.min, def.max) * 1000) / 1000;
}

/** The counterparty's counter-proposal after rejecting an offer. */
export function counterOffer(n: Negotiation, offer: Record<string, number>, th: number): Record<string, number> {
  const progress = clamp(1 - th / Math.max(0.01, n.baseThreshold), 0, 0.92);
  const out: Record<string, number> = {};
  for (const def of n.terms) {
    const I = n.ideal[def.key];
    const R = n.reservation[def.key];
    if (n.weights[def.key] === undefined) {
      // Unscored term (e.g. volume): keep the CEO's value if feasible, else their ideal.
      out[def.key] = offer[def.key] ?? I;
      continue;
    }
    const curve = I + (R - I) * progress;
    const cand = roundToStep(def, curve);
    // If the CEO already offered something better for the counterparty, keep it.
    const offerScore = termScore(n, def.key, offer[def.key]);
    const candScore = termScore(n, def.key, cand);
    out[def.key] = offerScore >= candScore ? offer[def.key] : cand;
  }
  const t = NEGOTIATION_TEMPLATES[n.templateKey];
  if (t?.check) {
    for (const def of n.terms) {
      if (t.check(out).length === 0) break;
      out[def.key] = n.ideal[def.key];
    }
  }
  return out;
}

export interface OfferResult {
  evaluation: Evaluation;
  outcome: 'accepted' | 'pending_approval' | 'countered' | 'rejected_final';
  counter: Record<string, number> | null;
  response: string;
}

/**
 * Process a CEO offer: evaluate, then accept / defer for internal approval /
 * counter / break off. Mutates the negotiation (rounds, status).
 */
export function processOffer(w: World, n: Negotiation, terms: Record<string, number>, message: string, argumentQuality: number): OfferResult {
  const tpl = NEGOTIATION_TEMPLATES[n.templateKey];
  const ev = evaluateOffer(w, n, terms, argumentQuality);
  const round: NegotiationRound = { n: n.rounds.length, date: w.meta.currentDate, by: 'ceo', terms: { ...terms }, message, evaluation: ev };
  n.rounds.push(round);
  const cp = byId(w.characters, n.counterpartyId);
  const who = cp?.name ?? 'The counterparty';
  if (ev.accepted) {
    if (tpl.approvalDays > 0) {
      n.pendingDecision = { date: addDays(w.meta.currentDate, tpl.approvalDays), terms: { ...terms }, approver: tpl.approvalBody };
      return { evaluation: ev, outcome: 'pending_approval', counter: null, response: `${who} can recommend these terms but needs approval from the ${tpl.approvalBody}; answer expected by ${n.pendingDecision.date}.` };
    }
    markAgreed(w, n, terms);
    return { evaluation: ev, outcome: 'accepted', counter: null, response: `${who} accepts: ${tpl.describe(terms)}` };
  }
  if (ceoRounds(n) >= n.maxRounds) {
    n.status = 'failed';
    adjustTrust(w, n.counterpartyId, -4);
    emit(w, { type: 'negotiation_failed', category: 'negotiation', severity: 'warning', title: `${n.title}: talks broken off`, description: `${who} broke off talks after ${ceoRounds(n)} rounds without agreement.`, causeKind: 'player_action', cause: { text: 'Maximum number of rounds reached without an acceptable offer.', refs: [{ type: 'negotiation', id: n.id }] }, entities: [{ type: 'negotiation', id: n.id }, { type: 'character', id: n.counterpartyId }] });
    return { evaluation: ev, outcome: 'rejected_final', counter: null, response: `${who} breaks off the talks: "We have gone round in circles. Come back when you have something new."` };
  }
  const counter = counterOffer(n, terms, ev.threshold);
  n.rounds.push({ n: n.rounds.length, date: w.meta.currentDate, by: 'counterparty', terms: counter, message: `Counter-proposal: ${tpl.describe(counter)}`, evaluation: null });
  const reasons = ev.violations.length ? ev.violations.join(' ') : 'The package is not yet good enough for them.';
  return { evaluation: ev, outcome: 'countered', counter, response: `${who} declines and counters. ${reasons} Their counter: ${tpl.describe(counter)}` };
}

export function markAgreed(w: World, n: Negotiation, terms: Record<string, number>): Contract {
  const tpl = NEGOTIATION_TEMPLATES[n.templateKey];
  n.status = 'agreed';
  n.agreedTerms = { ...terms };
  n.pendingDecision = null;
  const cp = byId(w.characters, n.counterpartyId);
  const contract: Contract = {
    id: nextId(w, 'CON'),
    kind: tpl.contractKind,
    title: n.templateKey === 'labor_agreement' ? n.title : tpl.contractTitle,
    counterpartyId: n.counterpartyId,
    counterpartyName: cp?.orgName ?? n.counterpartyId,
    status: 'agreed',
    terms: { ...terms },
    startDate: null,
    endDate: null,
    signedDate: null,
    valueCents: tpl.value(w, terms),
    amendmentOf: n.templateKey === 'voltaris_supply' ? 'CON-VOLTARIS' : null,
    negotiationId: n.id,
    templateKey: n.templateKey,
    obligations: [],
    summary: `Agreed in principle (not yet signed): ${tpl.describe(terms)}`,
    agreedDate: w.meta.currentDate,
  };
  w.contracts.push(contract);
  n.contractId = contract.id;
  adjustTrust(w, n.counterpartyId, 3);
  remember(w, { characterId: n.counterpartyId, kind: 'negotiation', summary: `Reached agreement in principle with the CEO: ${tpl.describe(terms)}`, importance: 4, sentiment: 1, sourceType: 'negotiation', sourceId: n.id, entityRefs: [{ type: 'contract', id: contract.id }] });
  emit(w, { type: 'negotiation_agreed', category: 'negotiation', severity: 'notice', title: `${n.title}: agreement in principle`, description: `${tpl.describe(terms)} The contract still has to be signed (with any required approvals) before it takes effect.`, causeKind: 'player_action', cause: { text: 'Counterparty accepted the CEO’s offer.', refs: [{ type: 'negotiation', id: n.id }] }, entities: [{ type: 'negotiation', id: n.id }, { type: 'contract', id: contract.id }], followUps: ['Sign the contract (Inbox → Contracts / Negotiations).'] });
  return contract;
}

/** Engine hook: resolve pending counterparty decisions (ballots, board approvals). */
export function resolvePendingDecisions(w: World): void {
  for (const n of w.negotiations) {
    if (n.status !== 'open' || !n.pendingDecision || n.pendingDecision.date > w.meta.currentDate) continue;
    const terms = n.pendingDecision.terms;
    const ok = violations(n, terms).length === 0;
    if (ok) {
      markAgreed(w, n, terms);
    } else {
      n.pendingDecision = null;
      emit(w, { type: 'negotiation_approval_denied', category: 'negotiation', severity: 'warning', title: `${n.title}: approval refused`, description: 'The counterparty’s internal approval was refused because circumstances changed.', causeKind: 'causal', entities: [{ type: 'negotiation', id: n.id }] });
    }
  }
  for (const n of w.negotiations) {
    if (n.status === 'open' && n.deadline && w.meta.currentDate > n.deadline && !n.pendingDecision) {
      n.status = 'expired';
      emit(w, { type: 'negotiation_expired', category: 'negotiation', severity: 'warning', title: `${n.title}: deadline passed`, description: `The negotiation deadline (${n.deadline}) passed without agreement.`, causeKind: 'causal', cause: { text: 'Negotiation deadline reached.', refs: [{ type: 'negotiation', id: n.id }] }, entities: [{ type: 'negotiation', id: n.id }] });
    }
  }
}

/** Fallback argument assessment used when no LLM is available (keyword heuristic, bounded). */
export function heuristicArgumentQuality(message: string, w: World, n: Negotiation): number {
  const m = message.toLowerCase();
  let q = 0;
  if (/\d/.test(m)) q += 0.02; // concrete numbers
  if (/(alternative|second source|hanseatic|other supplier|competitor|option)/.test(m)) q += 0.025;
  if (/(long[- ]term|partnership|volume|growth|future|together)/.test(m)) q += 0.015;
  if (/(because|therefore|given|data|evidence|forecast)/.test(m)) q += 0.015;
  if (/(threat|or else|ultimatum|final offer|take it or leave it)/.test(m)) q -= 0.04;
  if (m.length < 20) q -= 0.02;
  if (n.templateKey === 'voltaris_supply' && w.projects.some((p) => p.templateKey === 'second_battery_source' && p.status !== 'cancelled') && /second|alternative|hanseatic/.test(m)) q += 0.03;
  return clamp(Math.round(q * 1000) / 1000, -0.05, 0.1);
}

export function newNegotiation(w: World, templateKey: string, deadlineDays = 90): Negotiation {
  const t = NEGOTIATION_TEMPLATES[templateKey];
  if (!t) throw new Error(`unknown negotiation template ${templateKey}`);
  return {
    id: nextId(w, 'NEG'),
    templateKey,
    title: templateKey === 'labor_agreement' ? `Collective wage agreement ${w.meta.currentDate.slice(0, 4)}–${Number(w.meta.currentDate.slice(0, 4)) + 2}` : t.title,
    counterpartyId: t.counterpartyId,
    status: 'open',
    terms: t.terms,
    reservation: { ...t.defaultReservation },
    ideal: { ...t.defaultIdeal },
    weights: { ...t.weights },
    baseThreshold: t.baseThreshold,
    concessionPerRound: t.concessionPerRound,
    maxRounds: t.maxRounds,
    rounds: [{ n: 0, date: w.meta.currentDate, by: 'counterparty', terms: { ...t.defaultIdeal }, message: `Opening position: ${t.describe(t.defaultIdeal)}`, evaluation: null }],
    deadline: addDays(w.meta.currentDate, deadlineDays),
    createdDate: w.meta.currentDate,
    agreedTerms: null,
    contractId: null,
    linkedIssueId: null,
    context: t.title,
    pendingDecision: null,
  };
}

export function lastCounter(n: Negotiation): Record<string, number> | null {
  for (let i = n.rounds.length - 1; i >= 0; i--) if (n.rounds[i].by === 'counterparty') return n.rounds[i].terms;
  return null;
}

export type { SimDate };
