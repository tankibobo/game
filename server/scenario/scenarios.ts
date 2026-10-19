/**
 * Starting scenarios. Each one starts from the same company in January 2027
 * and changes the situation you inherit: cash, debt, supply, labour, market
 * and the board's expectations. Changes are applied while the world is being
 * built — before the opening balance sheet is drawn up — so every scenario is
 * internally consistent (ledger, contracts, issues, commitments).
 */
import type { Contract } from '../../shared/domain';
import { eur, mEur } from '../../shared/money';
import { byId, clamp, inbox, type World } from '../engine/world';

export interface ScenarioBuildContext {
  /** Cash on the opening balance sheet. */
  openingCashCents: number;
}

export interface Scenario {
  key: string;
  name: string;
  /** How hard the starting position is, independent of the difficulty setting. */
  challenge: 'Gentler' | 'Standard' | 'Tougher';
  tagline: string;
  brief: string;
  /** Opening messages from the standard intro to leave out (replaced by the scenario's own). */
  skipIntro: string[];
  /** Structural changes before demand calibration and the opening balance sheet. */
  apply?: (w: World, ctx: ScenarioBuildContext) => void;
  /** Market changes after demand is calibrated to FY2026 volumes. */
  afterCalibration?: (w: World) => void;
  /** Extra opening messages. */
  intro?: (w: World) => void;
}

const BASE_BRIEF_HEAD = 'You are the new CEO of Asterion Automotive (Lyon), appointed with effect from 1 January 2027.\nFY2026: revenue ≈ €7.5bn, operating margin ≈ 3.2%, 310,000 vehicles built, 18,000 employees.';

/** Battery supply already secured with Voltaris in December 2026 (used by several scenarios). */
function voltarisAlreadySigned(w: World, capacity = 290, price = 9_400): void {
  const supply = byId(w.supplies, 'SPL-VOL-PACK');
  if (supply) {
    supply.unitPriceCents = eur(price);
    supply.pendingCapacity.push({ date: '2027-04-20', dailyCapacity: capacity, reason: 'Voltaris capacity amendment No. 1 (signed Dec 2026)' });
    supply.contractId = 'CON-VOLTARIS-A1';
  }
  const amendment: Contract = {
    id: 'CON-VOLTARIS-A1', kind: 'supply', title: 'Voltaris capacity amendment No. 1', counterpartyId: 'CHR-SUND', counterpartyName: 'Voltaris Cells', status: 'active',
    terms: { dailyVolume: capacity, priceEur: price, prepaymentM: 60, takeOrPayPct: 70 }, startDate: '2026-12-20', endDate: '2031-12-31', signedDate: '2026-12-20', valueCents: mEur(60) + eur(price) * capacity * 230 * 3,
    templateKey: 'voltaris_supply', summary: `${capacity} packs/day from 20 April 2027 at €${price.toLocaleString('en-GB')}/pack; €60m prepayment (paid in 2026); 70% take-or-pay.`, amendmentOf: 'CON-VOLTARIS', negotiationId: null,
    obligations: [{ text: `Take-or-pay: pay for at least 70% of ${capacity} packs/day once capacity is live`, dueDate: null, status: 'open' }],
  };
  w.contracts.push(amendment);
  w.negotiations = w.negotiations.filter((n) => n.id !== 'NEG-VOLTARIS');
  const iss = byId(w.issues, 'ISS-VOLTARIS');
  if (iss) {
    iss.status = 'resolved';
    iss.resolvedDate = '2026-12-20';
    iss.resolutionNote = `Capacity amendment signed: ${capacity} packs/day from 20 April 2027.`;
  }
  const com = byId(w.commitments, 'COM-002');
  if (com) {
    com.status = 'fulfilled';
    com.resolvedDate = '2026-12-20';
  }
  const sup = byId(w.suppliers, 'SUP-VOLTARIS');
  if (sup) {
    sup.financialHealth = clamp(sup.financialHealth + 15, 0, 100);
    sup.relationship = clamp(sup.relationship + 10, 0, 100);
  }
}

function boardTrust(w: World, delta: number): void {
  for (const c of w.characters) if (c.isBoardMember) c.trustInCeo = clamp(c.trustInCeo + delta, 0, 100);
}

export const SCENARIOS: Scenario[] = [
  {
    key: 'turnaround',
    name: 'The Turnaround',
    challenge: 'Standard',
    tagline: 'The original situation: late EV, short battery supply, a Euro 7 deadline, a wage round and a bond to refinance.',
    brief: `${BASE_BRIEF_HEAD}
Cash €1.2bn, gross debt €2.4bn (incl. a €900m bond due Nov 2028), undrawn €500m RCF.
The ageing Vela is losing ground and must be made Euro 7 compliant or run out by 29 Nov 2027; the Kora hybrid carries the company; the Eon electric crossover is late, over budget, short of battery supply and stuck in thermal validation.
The wage agreement expires on 31 March. The board meets on 28 January and expects a credible turnaround.`,
    skipIntro: [],
  },
  {
    key: 'steady_start',
    name: 'A Steadier Start',
    challenge: 'Gentler',
    tagline: 'Your predecessor signed the battery deal and left more cash. Ideal for learning the game.',
    brief: `${BASE_BRIEF_HEAD}
Cash €1.5bn, gross debt €2.4bn (incl. a €900m bond due Nov 2028), undrawn €500m RCF.
Good news first: Voltaris signed a capacity amendment in December — 290 battery packs a day from April — and the Eon's thermal tests are well advanced. The Vela still needs Euro 7 by 29 Nov 2027, the wage agreement expires on 31 March and the bond must be refinanced.
The board has set a realistic budget (operating profit €80m) and is well disposed towards you. It meets on 28 January.`,
    skipIntro: ['voltaris', 'eon'],
    apply: (w, ctx) => {
      ctx.openingCashCents = mEur(1_500);
      voltarisAlreadySigned(w);
      const th = byId(w.issues, 'ISS-THERMAL');
      if (th) th.resolutionWorkDone = Math.round(th.resolutionWorkTotal * 0.6);
      w.meta.boardPlan = { ...w.meta.boardPlan, ebitTargetCents: mEur(80) };
      w.meta.boardConfidence = 62;
      boardTrust(w, 8);
    },
    intro: (w) => {
      inbox(w, { kind: 'report', fromId: 'CHR-WIERZBICKI', subject: 'Eon programme — status', body: 'Two pieces of good news: the Voltaris amendment is signed (290 packs a day from 20 April), and the thermal-propagation work is about 60% done. Battery-system validation is still the critical path, but we now have a credible route to the October SOP.\n\nTomasz', priority: 'normal', linked: [{ type: 'project', id: 'PRJ-EON' }, { type: 'issue', id: 'ISS-THERMAL' }] });
      inbox(w, { kind: 'letter', fromId: 'CHR-SUND', subject: 'Capacity amendment — thank you', body: 'The second module line is funded thanks to the amendment we signed with your predecessor. Deliveries ramp to 290 packs a day from 20 April.\n\nMikael Sund, Voltaris Cells', priority: 'low', linked: [{ type: 'contract', id: 'CON-VOLTARIS-A1' }] });
    },
  },
  {
    key: 'cash_crunch',
    name: 'Cash Crunch',
    challenge: 'Tougher',
    tagline: 'Less cash, a drawn credit line, a downgrade and the bond due six months earlier. Every euro counts.',
    brief: `${BASE_BRIEF_HEAD}
Cash only €650m and €200m of the €500m RCF already drawn; gross debt €2.6bn. The €900m bond matures in May 2028, and Meridian has cut the rating to BB- (negative). Suppliers have shortened payment terms.
The Vela needs Euro 7 by 29 Nov 2027, the Eon is late and short of battery supply, and the wage agreement expires on 31 March. The board (budget: operating profit €150m) meets on 28 January and wants to see cash discipline first.`,
    skipIntro: ['finance'],
    apply: (w, ctx) => {
      ctx.openingCashCents = mEur(650);
      const rcf = byId(w.debts, 'DEBT-RCF');
      if (rcf) rcf.principalCents = mEur(200);
      const bond = byId(w.debts, 'DEBT-BOND28');
      if (bond) {
        bond.maturityDate = '2028-05-15';
        bond.name = '4.25% Senior Notes due May 2028';
      }
      const refi = byId(w.issues, 'ISS-REFI');
      if (refi) {
        refi.title = '2028 bond (€900m, due May 2028) refinancing not started';
        refi.description = refi.description.replace('15 November 2028', '15 May 2028');
      }
      w.meta.creditRating = 'BB-';
      w.macro.creditSpreadBps += 60;
      for (const s of w.suppliers.filter((x) => ['SUP-TIER2', 'SUP-VALMONT', 'SUP-KESSLER'].includes(x.id))) s.paymentTermsDays = Math.max(30, s.paymentTermsDays - 10);
      w.meta.boardPlan = { ...w.meta.boardPlan, ebitTargetCents: mEur(150), minLiquidityCents: mEur(600) };
      w.meta.boardConfidence = 52;
    },
    intro: (w) => {
      inbox(w, { kind: 'report', fromId: 'CHR-HOLM', subject: 'Finance: we are short of cash', body: 'Opening cash is €650m and €200m of the RCF is already drawn, so liquidity is about €950m against a €400m covenant floor. The bond now falls due in May 2028 and the downgrade made new debt dearer.\n\nWhat I need from you:\n1. Stop building cars dealers cannot sell — Lyon still runs at ~575 a day.\n2. Start the refinancing immediately: a bank loan within your authority now, bigger instruments through the board.\n3. No new spending that does not pay back within two years.\n\nMargarethe', priority: 'urgent', linked: [{ type: 'character', id: 'CHR-HOLM' }, { type: 'debt', id: 'DEBT-BOND28' }] });
    },
  },
  {
    key: 'electric_rush',
    name: 'Electric Rush',
    challenge: 'Tougher',
    tagline: 'Buyers switch to electric faster than planned and CO₂ rules tighten. The Eon is ready sooner — the Vela fades faster.',
    brief: `${BASE_BRIEF_HEAD}
Cash €1.2bn, gross debt €2.4bn (incl. a €900m bond due Nov 2028), undrawn €500m RCF.
Europe's buyers are moving to electric faster than anyone planned, and the EU has tightened the 2027 CO₂ target. The Eon is further along — battery validation is done and Voltaris supply is signed — but the board now expects production by 1 July 2027. Petrol-only Vela demand is falling fast and Lyon is oversized.
The wage agreement expires on 31 March. The board (budget: operating profit €120m) meets on 28 January.`,
    skipIntro: ['voltaris', 'eon'],
    apply: (w) => {
      voltarisAlreadySigned(w, 300, 9_300);
      const th = byId(w.issues, 'ISS-THERMAL');
      if (th) {
        th.status = 'resolved';
        th.resolvedDate = '2026-12-18';
        th.resolutionNote = 'Thermal-propagation tests passed after the module-barrier redesign.';
      }
      const ms3 = w.milestones.find((m) => m.projectId === 'PRJ-EON' && m.seq === 3);
      if (ms3) {
        ms3.workDone = ms3.workTotal;
        ms3.status = 'completed';
        ms3.completedDate = '2026-12-18';
        ms3.gates = [];
      }
      const next = w.milestones.find((m) => m.projectId === 'PRJ-EON' && m.seq === 4);
      if (next) next.status = 'in_progress';
      for (const seg of w.segments) {
        seg.prefDriftPerYear = { ...seg.prefDriftPerYear, ice: seg.prefDriftPerYear.ice - 0.05, bev: seg.prefDriftPerYear.bev + 0.05 };
      }
      const co2 = byId(w.regulations, 'REG-CO2');
      if (co2) co2.params = { ...co2.params, target2027: 101, target2028: 97, target2029: 93 };
      w.meta.boardPlan = { ...w.meta.boardPlan, eonSopDate: '2027-07-01', ebitTargetCents: mEur(120) };
    },
    afterCalibration: (w) => {
      const vela = byId(w.models, 'MDL-VELA');
      if (vela) vela.baseAppeal = Math.max(10, vela.baseAppeal - 6);
    },
    intro: (w) => {
      inbox(w, { kind: 'report', fromId: 'CHR-WIERZBICKI', subject: 'Eon programme — we can go faster', body: 'Battery-system validation passed in December and the Voltaris amendment is signed (300 packs a day from 20 April). The board wants SOP by 1 July. That is possible only if supplier readiness and the Brno conversion go well — and if Brno has the people.\n\nTomasz', priority: 'high', linked: [{ type: 'project', id: 'PRJ-EON' }] });
      inbox(w, { kind: 'report', fromId: 'CHR-GARNIER', subject: 'The market is moving under our feet', body: 'Electric share in compact segments is rising twice as fast as our plan assumed and the CO₂ target for 2027 is now 101 g/km. Vela orders are softening. We should think hard about how many Velas Lyon builds — and about pricing the Eon to win.\n\nJulien', priority: 'high', linked: [{ type: 'model', id: 'MDL-VELA' }] });
    },
  },
  {
    key: 'labour_crisis',
    name: 'Labour Crisis',
    challenge: 'Tougher',
    tagline: 'The wage agreement has already expired and the union is angry. Battery supply is secured — people are the problem.',
    brief: `${BASE_BRIEF_HEAD}
Cash €1.2bn, gross debt €2.4bn (incl. a €900m bond due Nov 2028), undrawn €500m RCF.
The collective wage agreement expired on 31 December without a successor: there is no peace obligation, morale at Lyon is low and the union does not trust management. Strikes can start at any time.
Battery supply for the Eon was secured in December. The Vela still needs Euro 7 by 29 Nov 2027. The board (budget: operating profit €150m) meets on 28 January.`,
    skipIntro: ['union', 'voltaris', 'eon'],
    apply: (w) => {
      voltarisAlreadySigned(w);
      const labour = byId(w.contracts, 'CON-LABOR-2025');
      if (labour) {
        labour.endDate = '2026-12-31';
        labour.status = 'expired';
        labour.summary = 'Expired 31 December 2026 without a successor agreement — no peace obligation.';
      }
      const iss = byId(w.issues, 'ISS-LABOR');
      if (iss) {
        iss.title = 'No collective wage agreement since 31 December';
        iss.description = 'The previous agreement expired without a successor. The union demands 6.5% plus job guarantees; strikes are possible at any time.';
        iss.deadline = '2027-02-15';
        iss.severity = 'critical';
      }
      const neg = byId(w.negotiations, 'NEG-UNION');
      if (neg) {
        neg.deadline = '2027-03-15';
        neg.reservation = { ...neg.reservation, wageIncreasePct: (neg.reservation.wageIncreasePct ?? 4) + 0.5 };
        neg.context = 'The old agreement expired on 31 December 2026; without a new one there is no peace obligation.';
      }
      const novak = byId(w.characters, 'CHR-NOVAK');
      if (novak) novak.trustInCeo = 28;
      const petit = byId(w.characters, 'CHR-PETIT');
      if (petit) petit.trustInCeo = 38;
      for (const d of w.departments) if (d.kind === 'plant') d.morale = d.id === 'DEP-LYON' ? 38 : 47;
      const lyon = byId(w.factories, 'FAC-LYON');
      if (lyon) lyon.absenteeismPct = 8.5;
      w.meta.boardPlan = { ...w.meta.boardPlan, ebitTargetCents: mEur(150) };
    },
    intro: (w) => {
      inbox(w, { kind: 'letter', fromId: 'CHR-NOVAK', subject: 'We are out of patience', body: 'Our agreement expired on 31 December and management let it lapse. Our members want 6.5%, a real job guarantee for Lyon and respect. Talk to us now — or we will talk with our feet.\n\nDragan Novak, United Metalworkers’ Confederation', priority: 'urgent', linked: [{ type: 'negotiation', id: 'NEG-UNION' }] });
      inbox(w, { kind: 'report', fromId: 'CHR-WIERZBICKI', subject: 'Eon programme — status', body: 'Voltaris signed a capacity amendment in December (290 packs a day from 20 April). Thermal validation is still open and is now the critical path.\n\nTomasz', priority: 'normal', linked: [{ type: 'project', id: 'PRJ-EON' }, { type: 'issue', id: 'ISS-THERMAL' }] });
    },
  },
];

export const SCENARIO_BY_KEY = new Map(SCENARIOS.map((s) => [s.key, s]));

export function scenarioOf(key: string | null | undefined): Scenario {
  return SCENARIO_BY_KEY.get(key ?? 'turnaround') ?? SCENARIOS[0];
}
