/**
 * Hybrid event system. Every event has an explicit eligibility check on
 * authoritative state (preconditions), a classification (causal / random
 * shock / scheduled), a cooldown for deduplication, and consequences computed
 * here — never by the LLM. Random shocks use bounded probabilities and
 * bounded magnitudes (documented in `EVENT_CATALOGUE`).
 */
import type { EntityRef, EventState, Issue } from '../../shared/domain';
import { addDays, diffDays, isWorkingDay, type SimDate } from '../../shared/dates';
import { mEur, fmtEur } from '../../shared/money';
import { canRegister, segmentShares } from './demand';
import { post } from './ledger';
import { liquidity, netLeverage } from './metrics';
import { ensureCash } from './treasury';
import { adjustTrust, byId, clamp, emit, inbox, nextId, remember, rngFor, type World } from './world';
import type { Rng } from './rng';

export interface Eligibility {
  entityId?: string;
  probability: number;
  cause: string;
  refs: EntityRef[];
  data?: Record<string, number | string | null>;
}

export interface EventDef {
  key: string;
  label: string;
  kind: 'causal' | 'random_shock' | 'scheduled';
  frequency: 'daily' | 'monthly';
  cooldownDays: number;
  preconditions: string[];
  magnitude: string;
  /** The LLM may propose this event in a conversation; the engine still checks eligibility. */
  proposable: boolean;
  check: (w: World, rng: Rng) => Eligibility[];
  apply: (w: World, rng: Rng, e: Eligibility) => void;
}

function state(w: World, key: string): EventState {
  let s = w.eventStates.find((x) => x.key === key);
  if (!s) {
    s = { key, lastFired: null, count: 0, activeUntil: null, data: {} };
    w.eventStates.push(s);
  }
  return s;
}

function onCooldown(w: World, key: string, days: number): boolean {
  const s = w.eventStates.find((x) => x.key === key);
  return !!s?.lastFired && diffDays(w.meta.currentDate, s.lastFired) < days;
}

function ensureIssue(w: World, issue: Omit<Issue, 'chosenOptions' | 'resolvedDate' | 'resolutionNote'>): Issue {
  const existing = byId(w.issues, issue.id);
  if (existing) {
    if (['resolved', 'closed'].includes(existing.status)) {
      existing.status = 'open';
      existing.resolvedDate = null;
    }
    return existing;
  }
  const full: Issue = { ...issue, chosenOptions: [], resolvedDate: null, resolutionNote: null };
  w.issues.push(full);
  return full;
}

const SEVERITY_UP: Record<string, Issue['severity']> = { low: 'medium', medium: 'high', high: 'critical', critical: 'critical' };

export const EVENT_CATALOGUE: EventDef[] = [
  {
    key: 'thermal_test_failure',
    label: 'Eon battery thermal test failure',
    kind: 'causal',
    frequency: 'daily',
    cooldownDays: 60,
    preconditions: ['Thermal-propagation issue unresolved', 'Battery system validation still open', 'Working day'],
    magnitude: 'Adds 30% to the remaining issue work; severity becomes critical. Probability 0.6% per working day × residual risk factor (0.3 after a barrier redesign).',
    proposable: false,
    check: (w) => {
      const iss = byId(w.issues, 'ISS-THERMAL');
      const ms = byId(w.milestones, 'MS-EON-3');
      if (!iss || ['resolved', 'closed'].includes(iss.status) || !ms || ms.status === 'completed' || !isWorkingDay(w.meta.currentDate)) return [];
      return [{ probability: 0.006 * Number(iss.data.riskFactor ?? 1), cause: 'Thermal-propagation validation is still running on an unresolved design.', refs: [{ type: 'issue', id: iss.id }, { type: 'milestone', id: ms.id }] }];
    },
    apply: (w) => {
      const iss = byId(w.issues, 'ISS-THERMAL')!;
      const add = Math.round(iss.resolutionWorkTotal * 0.3);
      iss.resolutionWorkTotal += add;
      iss.severity = 'critical';
      emit(w, { type: 'thermal_test_failure', category: 'project', severity: 'critical', title: 'Eon pack failed another thermal-propagation test', description: `Cell venting propagated to an adjacent module in test #${(Number(iss.data.failures ?? 2) + 1)}. Engineering estimates ${add.toLocaleString('en-GB')} additional FTE-days of root-cause and re-test work.`, causeKind: 'causal', cause: { text: 'Unresolved thermal design weakness under abuse testing.', refs: [{ type: 'issue', id: iss.id }] }, entities: [{ type: 'issue', id: iss.id }, { type: 'project', id: 'PRJ-EON' }], consequences: [{ text: `Issue work +${add.toLocaleString('en-GB')} FTE-days` }], followUps: ['Consider the barrier redesign option on the thermal issue.', 'Re-check the Eon SOP forecast.'] });
      iss.data.failures = Number(iss.data.failures ?? 2) + 1;
      inbox(w, { kind: 'warning', fromId: 'CHR-WIERZBICKI', subject: 'Eon thermal test — another failure', body: `We had another propagation event in the abuse lab this morning. Nobody was hurt, but it confirms my concern: test capacity alone will not close this. I recommend we fund the barrier redesign. Current SOP forecast will move — I will not sign a date I cannot defend.`, priority: 'high', linked: [{ type: 'issue', id: iss.id }] });
    },
  },
  {
    key: 'voltaris_formal_notice',
    label: 'Voltaris formal capacity notice',
    kind: 'causal',
    frequency: 'daily',
    cooldownDays: 3650,
    preconditions: ['On or after 1 April 2027', 'No agreed/signed Voltaris amendment', 'Battery capacity < 250/day'],
    magnitude: 'Supplier relationship −5; negotiation deadline fixed at 30 June 2027.',
    proposable: false,
    check: (w) => {
      if (w.meta.currentDate < '2027-04-01') return [];
      const neg = byId(w.negotiations, 'NEG-VOLTARIS');
      if (!neg || neg.status !== 'open') return [];
      return [{ probability: 1, cause: 'Volume confirmation deadline (31 March) passed without an amendment.', refs: [{ type: 'negotiation', id: neg.id }, { type: 'supplier', id: 'SUP-VOLTARIS' }] }];
    },
    apply: (w) => {
      const sup = byId(w.suppliers, 'SUP-VOLTARIS');
      if (sup) sup.relationship = clamp(sup.relationship - 5, 0, 100);
      const neg = byId(w.negotiations, 'NEG-VOLTARIS');
      if (neg) neg.deadline = '2027-06-30';
      emit(w, { type: 'voltaris_notice', category: 'supply', severity: 'warning', title: 'Voltaris: capacity reserved only until 30 June', description: 'Voltaris formally notified that it will reallocate the planned second module line unless an amendment is signed by 30 June 2027. Contracted capacity stays at 140 packs/day.', causeKind: 'causal', cause: { text: 'No volume confirmation by the contractual deadline.', refs: [{ type: 'contract', id: 'CON-VOLTARIS' }] }, entities: [{ type: 'supplier', id: 'SUP-VOLTARIS' }, { type: 'negotiation', id: 'NEG-VOLTARIS' }] });
      inbox(w, { kind: 'letter', fromId: 'CHR-SUND', subject: 'Capacity reservation for Asterion', body: 'We have not received your 2028 volume confirmation. Our lenders require committed volumes for the second module line. Unless we sign an amendment by 30 June, we will offer the capacity elsewhere.', priority: 'high', linked: [{ type: 'negotiation', id: 'NEG-VOLTARIS' }] });
    },
  },
  {
    key: 'supplier_fire',
    label: 'Supplier plant fire / major outage',
    kind: 'random_shock',
    frequency: 'daily',
    cooldownDays: 365,
    preconditions: ['Supplier delivers a critical component'],
    magnitude: 'Probability 0.012% per day per critical supplier (≈4%/year). Capacity loss 40–80% for 10–35 days on that supplier’s components only.',
    proposable: false,
    check: (w) =>
      w.suppliers
        .filter((s) => w.supplies.some((x) => x.supplierId === s.id && x.dailyCapacity > 0))
        .map((s) => ({ entityId: s.id, probability: 0.00012 * (1.5 - s.reliability / 100), cause: 'Random industrial accident (shock).', refs: [{ type: 'supplier' as const, id: s.id }] })),
    apply: (w, rng, e) => {
      const sup = byId(w.suppliers, e.entityId!)!;
      const sev = Math.round(rng.range(0.4, 0.8, w.meta.currentDate, 'fire-sev', sup.id) * 100) / 100;
      const days = rng.int(10, 35, w.meta.currentDate, 'fire-days', sup.id);
      const until = addDays(w.meta.currentDate, days);
      const affected = w.supplies.filter((x) => x.supplierId === sup.id);
      for (const x of affected) {
        x.disruptionFactor = sev;
        x.disruptionUntil = until;
      }
      const models = [...new Set(affected.flatMap((x) => x.modelIds))].map((id) => byId(w.models, id)?.name).filter(Boolean);
      emit(w, { type: 'supplier_disruption', category: 'supply', severity: 'critical', title: `Fire at ${sup.name}`, description: `A fire has cut ${sup.name}'s output by ${Math.round(sev * 100)}% until ${until}. Affected: ${affected.map((x) => x.component).join(', ')} for ${models.join(', ')}. Other models are not affected. Consignment stock will buffer a few days.`, causeKind: 'random_shock', cause: { text: 'Random shock: industrial fire at a supplier.', refs: [{ type: 'supplier', id: sup.id }] }, entities: [{ type: 'supplier', id: sup.id }, ...affected.map((x) => ({ type: 'supply' as const, id: x.id }))], consequences: [{ text: `Capacity −${Math.round(sev * 100)}% for ${days} days` }] });
    },
  },
  {
    key: 'chip_allocation',
    label: 'Semiconductor allocation cut (Corvian)',
    kind: 'random_shock',
    frequency: 'monthly',
    cooldownDays: 240,
    preconditions: ['Corvian supplies ECUs'],
    magnitude: 'Probability 4% per month. Corvian capacity −15% to −30% for 30–60 days (all models use Corvian ECUs).',
    proposable: false,
    check: (w) => (w.supplies.some((s) => s.supplierId === 'SUP-CORVIAN') ? [{ probability: 0.04, cause: 'Random shock in the global semiconductor market.', refs: [{ type: 'supplier', id: 'SUP-CORVIAN' }] }] : []),
    apply: (w, rng) => {
      const sev = Math.round(rng.range(0.15, 0.3, w.meta.currentDate, 'chip-sev') * 100) / 100;
      const until = addDays(w.meta.currentDate, rng.int(30, 60, w.meta.currentDate, 'chip-days'));
      for (const s of w.supplies.filter((x) => x.supplierId === 'SUP-CORVIAN')) {
        s.disruptionFactor = sev;
        s.disruptionUntil = until;
      }
      emit(w, { type: 'chip_allocation', category: 'supply', severity: 'warning', title: 'Corvian announces ECU allocation', description: `Corvian will deliver ${Math.round((1 - sev) * 100)}% of contracted ECUs until ${until} due to a wafer shortage at its foundry.`, causeKind: 'random_shock', cause: { text: 'Random shock: semiconductor supply.', refs: [{ type: 'supplier', id: 'SUP-CORVIAN' }] }, entities: [{ type: 'supplier', id: 'SUP-CORVIAN' }] });
    },
  },
  {
    key: 'macro_downturn',
    label: 'European demand downturn',
    kind: 'random_shock',
    frequency: 'monthly',
    cooldownDays: 720,
    preconditions: ['No downturn currently active'],
    magnitude: 'Probability 1.5% per month. Market demand −4% to −8% for 6–9 months; consumer confidence −6.',
    proposable: false,
    check: (w) => (w.macro.shocks.some((s) => s.key === 'downturn' && s.until >= w.meta.currentDate) ? [] : [{ probability: 0.015, cause: 'Random macroeconomic shock.', refs: [] }]),
    apply: (w, rng) => {
      const eff = -Math.round(rng.range(0.04, 0.08, w.meta.currentDate, 'macro-eff') * 1000) / 1000;
      const until = addDays(w.meta.currentDate, rng.int(180, 270, w.meta.currentDate, 'macro-len'));
      w.macro.shocks.push({ key: 'downturn', label: 'Demand downturn', start: w.meta.currentDate, until, demandEffect: eff, energyEffect: 0, chipEffect: 0 });
      w.macro.consumerConfidence = Math.round((w.macro.consumerConfidence - 6) * 10) / 10;
      w.macro.gdpGrowthPct = Math.round((w.macro.gdpGrowthPct - 0.8) * 10) / 10;
      emit(w, { type: 'macro_downturn', category: 'market', severity: 'warning', title: 'European car demand weakens', description: `Rising unemployment and tighter credit cut new-car demand by about ${Math.abs(eff * 100).toFixed(1)}% until ${until}.`, causeKind: 'random_shock', cause: { text: 'Random shock: macroeconomic downturn.', refs: [] }, entities: [{ type: 'company', id: 'asterion' }] });
    },
  },
  {
    key: 'energy_spike',
    label: 'Energy price spike',
    kind: 'random_shock',
    frequency: 'monthly',
    cooldownDays: 365,
    preconditions: ['No energy shock active'],
    magnitude: 'Probability 2% per month. Factory overhead & energy +15% to +30% for 3 months.',
    proposable: false,
    check: (w) => (w.macro.shocks.some((s) => s.key === 'energy' && s.until >= w.meta.currentDate) ? [] : [{ probability: 0.02, cause: 'Random shock in energy markets.', refs: [] }]),
    apply: (w, rng) => {
      const eff = Math.round(rng.range(0.15, 0.3, w.meta.currentDate, 'energy') * 100) / 100;
      const until = addDays(w.meta.currentDate, 90);
      w.macro.shocks.push({ key: 'energy', label: 'Energy price spike', start: w.meta.currentDate, until, demandEffect: 0, energyEffect: eff, chipEffect: 0 });
      emit(w, { type: 'energy_spike', category: 'market', severity: 'notice', title: 'Industrial energy prices spike', description: `Plant energy costs up ~${Math.round(eff * 100)}% until ${until}.`, causeKind: 'random_shock', cause: { text: 'Random shock: energy markets.', refs: [] } });
    },
  },
  {
    key: 'union_strike_notice',
    label: 'Union strike notice',
    kind: 'causal',
    frequency: 'daily',
    cooldownDays: 45,
    preconditions: ['No collective agreement in force (old one expired, new one not signed) OR job guarantee broken', 'Union trust in CEO < 55, or job cuts announced at plants'],
    magnitude: 'Strike notice with a strike date 14 days later unless an agreement is reached.',
    proposable: true,
    check: (w) => {
      const inForce = w.contracts.some((c) => c.kind === 'labor' && c.status === 'active' && (!c.endDate || c.endDate >= w.meta.currentDate));
      const brokenGuarantee = w.commitments.some((c) => c.promiseeId === 'CHR-NOVAK' && c.status === 'broken' && c.resolvedDate && diffDays(w.meta.currentDate, c.resolvedDate) < 30);
      if (inForce && !brokenGuarantee) return [];
      const novak = byId(w.characters, 'CHR-NOVAK');
      const cuts = w.departments.some((d) => d.kind === 'plant' && d.leaving.length > 0);
      if (!brokenGuarantee && (novak?.trustInCeo ?? 50) >= 55 && !cuts) return [];
      const s = w.eventStates.find((x) => x.key === 'union_strike_notice');
      if (s?.activeUntil && s.activeUntil >= w.meta.currentDate) return [];
      return [{ probability: brokenGuarantee || cuts ? 0.2 : 0.05, cause: brokenGuarantee ? 'The job guarantee given to the union was broken.' : cuts ? 'Job cuts announced at the plants without a collective agreement.' : 'No collective agreement in force and low trust between union and management.', refs: [{ type: 'character', id: 'CHR-NOVAK' }, { type: 'negotiation', id: 'NEG-UNION' }] }];
    },
    apply: (w, _rng, e) => {
      const strikeDate = addDays(w.meta.currentDate, 14);
      const s = state(w, 'union_strike_notice');
      s.activeUntil = strikeDate;
      s.data.strikeDate = strikeDate;
      const iss = ensureIssue(w, { id: 'ISS-STRIKE', kind: 'strike', title: 'Strike notice at all plants', description: `The union has announced strikes at Lyon, Sevilla and Brno from ${strikeDate}.`, severity: 'critical', ownerId: 'CHR-OKAFOR', discoveredDate: w.meta.currentDate, status: 'open', nextAction: 'Reach an agreement with the union before the strike date.', deadline: strikeDate, linked: [{ type: 'character', id: 'CHR-NOVAK' }, { type: 'negotiation', id: 'NEG-UNION' }], projectId: null, drag: 0, resolutionWorkTotal: 0, resolutionWorkDone: 0, options: [], data: {} });
      iss.deadline = strikeDate;
      emit(w, { type: 'strike_notice', category: 'people', severity: 'critical', title: `Union announces strikes from ${strikeDate}`, description: `${e.cause} Dragan Novak has served notice of rolling strikes at all three plants.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'character', id: 'CHR-NOVAK' }, { type: 'issue', id: 'ISS-STRIKE' }], followUps: ['Meet Dragan Novak; table an improved offer in the wage negotiation.'] });
      inbox(w, { kind: 'letter', fromId: 'CHR-NOVAK', subject: 'Notice of industrial action', body: `Our members have mandated rolling strikes from ${strikeDate}. The door remains open — but not for long.`, priority: 'urgent', linked: [{ type: 'issue', id: 'ISS-STRIKE' }] });
    },
  },
  {
    key: 'strike',
    label: 'Strike wave',
    kind: 'causal',
    frequency: 'daily',
    cooldownDays: 30,
    preconditions: ['Strike notice served and strike date reached', 'Still no collective agreement in force'],
    magnitude: 'All plants stop for 2–4 working days; plant morale −4; union trust −3; next wave threatened 35 days later.',
    proposable: false,
    check: (w) => {
      const s = w.eventStates.find((x) => x.key === 'union_strike_notice');
      if (!s?.data.strikeDate || String(s.data.strikeDate) > w.meta.currentDate) return [];
      const inForce = w.contracts.some((c) => c.kind === 'labor' && c.status === 'active' && (!c.endDate || c.endDate >= w.meta.currentDate) && c.signedDate && c.signedDate >= '2027-01-01');
      if (inForce) {
        s.data.strikeDate = null;
        const iss = byId(w.issues, 'ISS-STRIKE');
        if (iss && iss.status !== 'resolved') {
          iss.status = 'resolved';
          iss.resolvedDate = w.meta.currentDate;
          iss.resolutionNote = 'Strike called off after a collective agreement was signed.';
        }
        return [];
      }
      return [{ probability: 1, cause: 'Strike date reached without an agreement.', refs: [{ type: 'character', id: 'CHR-NOVAK' }] }];
    },
    apply: (w, rng) => {
      const days = rng.int(2, 4, w.meta.currentDate, 'strike-days');
      let end = w.meta.currentDate;
      let wd = 0;
      while (wd < days) {
        if (isWorkingDay(end)) wd++;
        if (wd < days) end = addDays(end, 1);
      }
      for (const f of w.factories) f.downtime.push({ start: w.meta.currentDate, end, reason: 'Strike', kind: 'strike' });
      for (const d of w.departments.filter((x) => x.kind === 'plant')) d.morale = clamp(d.morale - 4, 0, 100);
      adjustTrust(w, 'CHR-NOVAK', -3);
      const s = state(w, 'union_strike_notice');
      s.data.strikeDate = addDays(end, 35); // next wave unless resolved
      s.activeUntil = String(s.data.strikeDate);
      emit(w, { type: 'strike', category: 'people', severity: 'critical', title: `Strike halts all plants until ${end}`, description: `About ${days} working days of production lost across Lyon, Sevilla and Brno. A further wave is threatened for ${s.data.strikeDate}.`, causeKind: 'causal', cause: { text: 'No agreement by the strike date.', refs: [{ type: 'issue', id: 'ISS-STRIKE' }] }, entities: w.factories.map((f) => ({ type: 'factory' as const, id: f.id })) });
    },
  },
  {
    key: 'absenteeism_rise',
    label: 'Absenteeism rise at a plant',
    kind: 'causal',
    frequency: 'monthly',
    cooldownDays: 90,
    preconditions: ['Plant workforce morale below 45'],
    magnitude: 'Absenteeism +2 percentage points at that plant.',
    proposable: true,
    check: (w) =>
      w.factories
        .map((f) => ({ f, dep: byId(w.departments, f.departmentId) }))
        .filter(({ dep }) => dep && dep.morale < 45)
        .map(({ f, dep }) => ({ entityId: f.id, probability: 0.6, cause: `${dep!.name} morale is ${dep!.morale.toFixed(0)}/100.`, refs: [{ type: 'factory' as const, id: f.id }, { type: 'department' as const, id: dep!.id }] })),
    apply: (w, _rng, e) => {
      const f = byId(w.factories, e.entityId!)!;
      f.absenteeismPct = Math.round((f.absenteeismPct + 2) * 100) / 100;
      emit(w, { type: 'absenteeism_rise', category: 'operations', severity: 'warning', title: `Absenteeism rising at ${f.name}`, description: `Absenteeism now ${f.absenteeismPct.toFixed(1)}%. ${e.cause}`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'factory', id: f.id }] });
    },
  },
  {
    key: 'dealer_stock_alarm',
    label: 'Dealer council stock complaint',
    kind: 'causal',
    frequency: 'monthly',
    cooldownDays: 90,
    preconditions: ['Dealer stock of a model above 75 days of retail sales'],
    magnitude: 'Dealer council trust −3; dealer-stock issue escalates.',
    proposable: true,
    check: (w) =>
      w.models
        .filter((m) => m.status === 'in_production' && m.retailLastMonth > 0 && (m.dealerStock / m.retailLastMonth) * 30 > 75)
        .map((m) => ({ entityId: m.id, probability: 1, cause: `${m.name} dealer stock at ${Math.round((m.dealerStock / m.retailLastMonth) * 30)} days of sales.`, refs: [{ type: 'model' as const, id: m.id }] })),
    apply: (w, _rng, e) => {
      const m = byId(w.models, e.entityId!)!;
      adjustTrust(w, 'CHR-BELLINI', -3);
      const iss = ensureIssue(w, { id: `ISS-DEALER-${m.id.replace('MDL-', '')}`, kind: 'dealer_stock', title: `${m.name} dealer stock above target`, description: `Dealers hold too many ${m.name}s.`, severity: 'medium', ownerId: 'CHR-GARNIER', discoveredDate: w.meta.currentDate, status: 'open', nextAction: 'Align production with retail demand or support retail.', deadline: null, linked: [{ type: 'model', id: m.id }], projectId: null, drag: 0, resolutionWorkTotal: 0, resolutionWorkDone: 0, options: [], data: { modelId: m.id } });
      iss.severity = SEVERITY_UP[iss.severity];
      emit(w, { type: 'dealer_stock_alarm', category: 'market', severity: 'warning', title: `Dealer council protests ${m.name} stock levels`, description: `${e.cause} Dealers are paying floor-plan interest and threaten to stop ordering.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'model', id: m.id }, { type: 'character', id: 'CHR-BELLINI' }, { type: 'issue', id: iss.id }] });
      inbox(w, { kind: 'letter', fromId: 'CHR-BELLINI', subject: `${m.name}: our yards are full`, body: `Our members are carrying far too many ${m.name}s. We need either fewer cars or real support to sell them — and we need it now, not next quarter.`, priority: 'high', linked: [{ type: 'model', id: m.id }] });
    },
  },
  {
    key: 'kora_inverter_incidents',
    label: 'Kora inverter field incidents',
    kind: 'causal',
    frequency: 'monthly',
    cooldownDays: 0,
    preconditions: ['Inverter issue not resolved'],
    magnitude: '+10 to +25 incidents per month (halved while investigating). At ≥160 incidents a regulator-mandated recall follows (€95m, quality −2, satisfaction −3, Kora demand −10% for 4 months).',
    proposable: false,
    check: (w) => {
      const iss = byId(w.issues, 'ISS-KORA-INV');
      if (!iss || ['resolved', 'closed'].includes(iss.status)) return [];
      return [{ probability: 1, cause: 'Unresolved inverter defect in the Kora fleet.', refs: [{ type: 'issue', id: iss.id }, { type: 'model', id: 'MDL-KORA' }] }];
    },
    apply: (w, rng) => {
      const iss = byId(w.issues, 'ISS-KORA-INV')!;
      const add = Math.round(rng.int(10, 25, w.meta.currentDate, 'inverter') * (iss.status === 'investigating' ? 0.5 : 1));
      iss.data.incidents = Number(iss.data.incidents ?? 0) + add;
      const n = Number(iss.data.incidents);
      if (n >= 160) {
        recall(w, iss);
      } else if (n >= 90 && iss.severity !== 'critical') {
        iss.severity = n >= 120 ? 'critical' : 'high';
        emit(w, { type: 'inverter_incidents_rising', category: 'product', severity: 'warning', title: `Kora inverter incidents now ${n}`, description: 'The European Vehicle Certification Agency has requested information on the Kora inverter shutdowns. A mandated recall becomes likely if the trend continues.', causeKind: 'causal', cause: { text: 'Field incidents accumulating without corrective action.', refs: [{ type: 'issue', id: iss.id }] }, entities: [{ type: 'issue', id: iss.id }, { type: 'model', id: 'MDL-KORA' }, { type: 'character', id: 'CHR-VERBEEK' }] });
      }
    },
  },
  {
    key: 'competitor_launch',
    label: 'Competitor product launch',
    kind: 'causal',
    frequency: 'daily',
    cooldownDays: 0,
    preconditions: ['Competitor development programme complete', 'Planned launch window reached'],
    magnitude: 'Product enters the segment share model.',
    proposable: false,
    check: (w) => {
      const out: Eligibility[] = [];
      for (const p of w.competitorProducts) {
        if (p.status !== 'development') continue;
        p.devProgress = Math.min(1, p.devProgress + p.devRatePerDay);
        if (p.devProgress >= 1 && p.launchDate && diffDays(p.launchDate, w.meta.currentDate) <= 30) out.push({ entityId: p.id, probability: 1, cause: `${p.name} development completed.`, refs: [{ type: 'competitor_product', id: p.id }] });
      }
      return out;
    },
    apply: (w, _rng, e) => {
      const p = byId(w.competitorProducts, e.entityId!)!;
      p.status = 'on_sale';
      p.launchDate = w.meta.currentDate;
      const ours = w.models.filter((m) => m.segmentId === p.segmentId && m.status === 'in_production');
      const rows = segmentShares(w, p.segmentId, w.meta.currentDate);
      const share = rows.find((r) => r.id === p.id)?.share ?? 0;
      const comp = byId(w.competitors, p.competitorId);
      emit(w, { type: 'competitor_launch', category: 'market', severity: 'notice', title: `${comp?.name} launches the ${p.name}`, description: `Priced at €${(p.priceCents / 100).toLocaleString('en-GB')} net. Expected to take ~${(share * 100).toFixed(1)}% of the segment${ours.length ? `, partly at the expense of ${ours.map((m) => m.name).join(' and ')}` : ''}.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'competitor_product', id: p.id }, { type: 'competitor', id: p.competitorId }, { type: 'segment', id: p.segmentId }] });
    },
  },
  {
    key: 'competitor_price_response',
    label: 'Competitor price response',
    kind: 'causal',
    frequency: 'monthly',
    cooldownDays: 150,
    preconditions: ['Asterion cut a model’s price ≥3% below its reference and gained share', 'Aggressive competitor present in the segment'],
    magnitude: 'Aggressive competitors cut prices 3–5% in that segment.',
    proposable: false,
    check: (w) => {
      const out: Eligibility[] = [];
      const base = state(w, 'price_baseline');
      for (const m of w.models) {
        if (m.status !== 'in_production') continue;
        const k = `price:${m.id}`;
        if (base.data[k] === undefined) {
          base.data[k] = m.netPriceCents;
          continue;
        }
        const ref = Number(base.data[k]);
        if (m.netPriceCents <= ref * 0.97 && !onCooldown(w, `competitor_price_response:${m.segmentId}`, 150)) {
          out.push({ entityId: m.segmentId, probability: 0.7, cause: `Asterion cut the ${m.name} price by ${(((ref - m.netPriceCents) / ref) * 100).toFixed(1)}%.`, refs: [{ type: 'model', id: m.id }, { type: 'segment', id: m.segmentId }] });
        }
      }
      return out;
    },
    apply: (w, rng, e) => {
      const seg = e.entityId!;
      const hit: string[] = [];
      for (const p of w.competitorProducts.filter((x) => x.segmentId === seg && x.status === 'on_sale')) {
        const comp = byId(w.competitors, p.competitorId);
        if (!comp || comp.aggressiveness < 0.5) continue;
        const cut = rng.range(0.03, 0.05, w.meta.currentDate, 'cut', p.id);
        p.priceCents = Math.round((p.priceCents * (1 - cut)) / 100) * 100;
        p.lastPriceChange = w.meta.currentDate;
        hit.push(`${p.name} −${(cut * 100).toFixed(1)}%`);
      }
      if (!hit.length) return;
      emit(w, { type: 'competitor_price_response', category: 'market', severity: 'warning', title: 'Competitors respond to Asterion price cuts', description: `${e.cause} Competitors matched: ${hit.join(', ')}.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'segment', id: seg }] });
    },
  },
  {
    key: 'rating_action',
    label: 'Credit rating action',
    kind: 'causal',
    frequency: 'monthly',
    cooldownDays: 90,
    preconditions: ['Downgrade (outlook negative): net leverage > 3.25x, or 2028 bond within 18 months with no refinancing', 'Outlook to negative (outlook stable): leverage > 3.75x, or bond within 11 months unrefinanced', 'Outlook to stable: leverage < 2.5x and refinancing secured'],
    magnitude: 'One-notch downgrade (outlook then resets to stable): credit insurers cut limits — key suppliers shorten payment terms by 15 days; board confidence −5. Negative outlook: board confidence −2. Outlook to stable: +3.',
    proposable: false,
    check: (w) => {
      const lev = netLeverage(w);
      const bond = byId(w.debts, 'DEBT-BOND28');
      const refiOpen = byId(w.issues, 'ISS-REFI')?.status !== 'resolved';
      const refiSecured = Number(byId(w.issues, 'ISS-REFI')?.data.securedCents ?? 0);
      const unrefinanced = refiSecured > 0 ? `only ${fmtEur(refiSecured)} of the €700m refinancing secured` : 'no refinancing plan';
      const monthsToBond = bond && bond.status === 'active' ? diffDays(bond.maturityDate, w.meta.currentDate) / 30.4 : 99;
      const o = w.meta.ratingOutlook;
      // A downgrade needs a negative outlook first; after a downgrade the outlook resets to stable.
      if (o === 'negative' && (lev > 3.25 || (refiOpen && monthsToBond < 18))) return [{ data: { dir: 'down' }, probability: 0.5, cause: lev > 3.25 ? `Net leverage ${lev.toFixed(2)}x above the agency's 3.25x downgrade trigger.` : `The 2028 bond matures in ${monthsToBond.toFixed(0)} months with ${unrefinanced}.`, refs: [{ type: 'debt', id: 'DEBT-BOND28' }] }];
      if (o === 'stable' && (lev > 3.75 || (refiOpen && monthsToBond < 11))) return [{ data: { dir: 'negative' }, probability: 0.6, cause: lev > 3.75 ? `Net leverage ${lev.toFixed(2)}x keeps rising.` : `Only ${monthsToBond.toFixed(0)} months to the 2028 bond maturity, with ${unrefinanced}.`, refs: [{ type: 'debt', id: 'DEBT-BOND28' }] }];
      if (o === 'negative' && lev < 2.5 && !refiOpen) return [{ data: { dir: 'stable' }, probability: 0.5, cause: 'Deleveraging and secured refinancing.', refs: [] }];
      return [];
    },
    apply: (w, _rng, e) => {
      if (e.data?.dir === 'down') {
        const ladder = ['BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-', 'CCC+'];
        const i = ladder.indexOf(w.meta.creditRating);
        const old = w.meta.creditRating;
        w.meta.creditRating = ladder[Math.min(ladder.length - 1, i + 1)];
        w.meta.ratingOutlook = 'stable';
        w.macro.creditSpreadBps += 70;
        for (const s of w.suppliers.filter((x) => ['SUP-TIER2', 'SUP-VALMONT', 'SUP-KESSLER'].includes(x.id))) s.paymentTermsDays = Math.max(30, s.paymentTermsDays - 15);
        w.meta.boardConfidence = clamp(w.meta.boardConfidence - 5, 0, 100);
        emit(w, { type: 'rating_downgrade', category: 'finance', severity: 'critical', title: `Meridian downgrades Asterion to ${w.meta.creditRating} (from ${old})`, description: `${e.cause} Trade-credit insurers have cut limits: Tier-2, Valmont and Kessler shorten payment terms by 15 days for new invoices, tying up working capital. New debt will be more expensive.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'company', id: 'asterion' }], followUps: ['Present a refinancing plan; consider equity or asset sales to reduce leverage.'] });
      } else if (e.data?.dir === 'negative') {
        w.meta.ratingOutlook = 'negative';
        w.meta.boardConfidence = clamp(w.meta.boardConfidence - 2, 0, 100);
        emit(w, { type: 'rating_outlook_negative', category: 'finance', severity: 'warning', title: `Meridian puts Asterion's ${w.meta.creditRating} rating on negative outlook`, description: `${e.cause} A further downgrade is likely unless this changes.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'company', id: 'asterion' }] });
      } else {
        w.meta.ratingOutlook = 'stable';
        w.meta.boardConfidence = clamp(w.meta.boardConfidence + 3, 0, 100);
        emit(w, { type: 'rating_outlook_stable', category: 'finance', severity: 'notice', title: 'Meridian revises Asterion outlook to stable', description: e.cause, causeKind: 'causal', entities: [{ type: 'company', id: 'asterion' }] });
      }
    },
  },
  {
    key: 'refinancing_pressure',
    label: 'Refinancing pressure from the board',
    kind: 'causal',
    frequency: 'monthly',
    cooldownDays: 120,
    preconditions: ['2028 bond matures within 15 months', 'Refinancing not secured'],
    magnitude: 'Board confidence −4; refinancing issue becomes critical.',
    proposable: false,
    check: (w) => {
      const bond = byId(w.debts, 'DEBT-BOND28');
      const iss = byId(w.issues, 'ISS-REFI');
      if (!bond || bond.status !== 'active' || !iss || iss.status === 'resolved') return [];
      const secured = Number(iss.data.securedCents ?? 0);
      return diffDays(bond.maturityDate, w.meta.currentDate) < 456 ? [{ probability: 1, cause: secured > 0 ? `The €900m bond matures within 15 months and only ${fmtEur(secured)} of the €700m refinancing is secured.` : 'The €900m bond matures within 15 months with no refinancing in place.', refs: [{ type: 'debt', id: bond.id }, { type: 'issue', id: iss.id }] }] : [];
    },
    apply: (w, _rng, e) => {
      const iss = byId(w.issues, 'ISS-REFI')!;
      iss.severity = 'critical';
      w.meta.boardConfidence = clamp(w.meta.boardConfidence - 4, 0, 100);
      emit(w, { type: 'refinancing_pressure', category: 'board', severity: 'critical', title: 'Board demands an immediate refinancing solution', description: e.cause, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'issue', id: iss.id }, { type: 'character', id: 'CHR-DUBREUIL' }] });
      inbox(w, { kind: 'board', fromId: 'CHR-VOGEL', subject: 'Refinancing — audit committee concern', body: 'Without a committed refinancing, our auditors will raise going-concern questions at the year-end audit. I expect a concrete proposal at the next board meeting.', priority: 'urgent', linked: [{ type: 'issue', id: iss.id }] });
    },
  },
  {
    key: 'eib_prepayment_demand',
    label: 'EIB prepayment demand',
    kind: 'causal',
    frequency: 'daily',
    cooldownDays: 3650,
    preconditions: ['After 31 March 2028', 'Eon not in series production'],
    magnitude: 'EIB loan (€400m) becomes repayable within 30 days.',
    proposable: false,
    check: (w) => {
      if (w.meta.currentDate <= '2028-03-31') return [];
      const eon = byId(w.models, 'MDL-EON');
      const eib = byId(w.debts, 'DEBT-EIB');
      if (!eon || eon.status === 'in_production' || !eib || eib.status !== 'active' || eib.principalCents <= 0) return [];
      return [{ probability: 1, cause: 'Eon series production did not start at Brno by 31 March 2028 (EIB loan condition).', refs: [{ type: 'debt', id: eib.id }, { type: 'project', id: 'PRJ-EON' }] }];
    },
    apply: (w, _rng, e) => {
      const eib = byId(w.debts, 'DEBT-EIB')!;
      const due = addDays(w.meta.currentDate, 30);
      eib.amortization = [...eib.amortization.filter((a) => a.date < due), { date: due, amountCents: eib.principalCents }];
      emit(w, { type: 'eib_prepayment', category: 'finance', severity: 'critical', title: 'EIB demands prepayment of the €400m green loan', description: `${e.cause} Repayment due ${due}.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'debt', id: eib.id }] });
    },
  },
  {
    key: 'favorable_reviews',
    label: 'Strong launch reviews',
    kind: 'causal',
    frequency: 'monthly',
    cooldownDays: 3650,
    preconditions: ['Model launched within the last 6 months', 'Quality ≥ 76 and appeal ≥ 74'],
    magnitude: 'Demand +6% for 60 days.',
    proposable: true,
    check: (w) =>
      w.models
        .filter((m) => m.launchDate && m.status === 'in_production' && diffDays(w.meta.currentDate, m.launchDate) < 183 && m.quality >= 76 && m.baseAppeal >= 74 && !onCooldown(w, `favorable_reviews:${m.id}`, 3650))
        .map((m) => ({ entityId: m.id, probability: 0.5, cause: `${m.name} combines high quality (${m.quality}) and strong appeal.`, refs: [{ type: 'model' as const, id: m.id }] })),
    apply: (w, _rng, e) => {
      const m = byId(w.models, e.entityId!)!;
      m.demandModifier = 1.06;
      m.demandModifierUntil = addDays(w.meta.currentDate, 60);
      emit(w, { type: 'favorable_reviews', category: 'product', severity: 'info', title: `${m.name} wins strong reviews`, description: `${e.cause} Showroom traffic is up.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'model', id: m.id }] });
    },
  },
  {
    key: 'liquidity_warning',
    label: 'Liquidity warning',
    kind: 'causal',
    frequency: 'daily',
    cooldownDays: 30,
    preconditions: ['Liquidity (cash + undrawn RCF) below €450m'],
    magnitude: 'CFO warning; board confidence −2.',
    proposable: false,
    check: (w) => (liquidity(w) < mEur(450) ? [{ probability: 1, cause: `Liquidity has fallen to €${(liquidity(w) / 1e8).toFixed(0)}m.`, refs: [] }] : []),
    apply: (w, _rng, e) => {
      w.meta.boardConfidence = clamp(w.meta.boardConfidence - 2, 0, 100);
      emit(w, { type: 'liquidity_warning', category: 'finance', severity: 'critical', title: 'Liquidity below €450m', description: `${e.cause} The EIB minimum-liquidity covenant is €400m.`, causeKind: 'causal', cause: { text: e.cause, refs: [] }, followUps: ['Cut production to release inventory cash, delay discretionary spend, or arrange financing.'] });
      inbox(w, { kind: 'warning', fromId: 'CHR-HOLM', subject: 'Liquidity is getting dangerously thin', body: `${e.cause} At this run-rate we will breach the EIB liquidity covenant. I need decisions this week: production cuts, capex deferral, or new money.`, priority: 'urgent', linked: [] });
    },
  },
  {
    key: 'executive_resignation',
    label: 'Executive resignation',
    kind: 'causal',
    frequency: 'monthly',
    cooldownDays: 3650,
    preconditions: ['An executive’s trust in the CEO is below 20'],
    magnitude: 'Executive leaves; board confidence −6; their department’s morale −5.',
    proposable: false,
    check: (w) =>
      w.characters
        .filter((c) => c.org === 'asterion' && c.active && c.trustInCeo < 20)
        .map((c) => ({ entityId: c.id, probability: 0.5, cause: `${c.name}'s trust in the CEO has collapsed (${c.trustInCeo.toFixed(0)}/100).`, refs: [{ type: 'character' as const, id: c.id }] })),
    apply: (w, _rng, e) => {
      const c = byId(w.characters, e.entityId!)!;
      c.active = 0;
      w.meta.boardConfidence = clamp(w.meta.boardConfidence - 6, 0, 100);
      const dep = byId(w.departments, c.departmentId ?? '');
      if (dep) dep.morale = clamp(dep.morale - 5, 0, 100);
      emit(w, { type: 'executive_resignation', category: 'people', severity: 'critical', title: `${c.name} (${c.title}) resigns`, description: `${e.cause} The board has noted the departure.`, causeKind: 'causal', cause: { text: e.cause, refs: e.refs }, entities: [{ type: 'character', id: c.id }] });
    },
  },
];

function recall(w: World, iss: Issue): void {
  const cost = mEur(95);
  post(w, { description: 'Kora inverter recall (regulator-mandated)', sourceType: 'recall', sourceId: iss.id, lines: [{ account: '6800', amountCents: cost }, { account: '2450', amountCents: -cost }] });
  const kora = byId(w.models, 'MDL-KORA')!;
  kora.quality = clamp(kora.quality - 2, 0, 100);
  kora.satisfaction = clamp(kora.satisfaction - 3, 0, 100);
  kora.demandModifier = 0.9;
  kora.demandModifierUntil = addDays(w.meta.currentDate, 120);
  iss.status = 'resolved';
  iss.resolvedDate = w.meta.currentDate;
  iss.resolutionNote = 'Regulator-mandated recall of ~62,000 vehicles.';
  iss.chosenOptions.push('recall');
  iss.data.campaignCostCents = cost;
  w.meta.boardConfidence = clamp(w.meta.boardConfidence - 6, 0, 100);
  adjustTrust(w, 'CHR-BELLINI', -6);
  emit(w, { type: 'recall', category: 'product', severity: 'critical', title: 'Regulator orders Kora inverter recall', description: `After ${iss.data.incidents} field incidents the EVCA has mandated a recall of ~62,000 Kora. Estimated cost €95m; Kora demand expected −10% for four months.`, causeKind: 'causal', cause: { text: 'Field incidents passed the regulator’s threshold without corrective action.', refs: [{ type: 'issue', id: iss.id }] }, entities: [{ type: 'model', id: 'MDL-KORA' }, { type: 'issue', id: iss.id }, { type: 'character', id: 'CHR-VERBEEK' }], consequences: [{ text: 'Recall provision', amountCents: cost }] });
}

/** Daily issue upkeep: investigations, automatic resolution conditions, missed deadlines. */
export function upkeepIssues(w: World): void {
  const d = w.meta.currentDate;
  for (const iss of w.issues) {
    if (['resolved', 'closed'].includes(iss.status)) continue;
    if (iss.status === 'investigating' && typeof iss.data.workPerDay === 'number' && isWorkingDay(d)) {
      iss.resolutionWorkDone += iss.data.workPerDay;
      if (iss.resolutionWorkDone >= iss.resolutionWorkTotal) finishInvestigation(w, iss);
    }
    switch (iss.kind) {
      case 'dealer_stock': {
        const m = byId(w.models, String(iss.data.modelId));
        if (m && m.retailLastMonth > 0 && (m.dealerStock / m.retailLastMonth) * 30 < 50) closeIssue(w, iss, `Dealer stock back to ${Math.round((m.dealerStock / m.retailLastMonth) * 30)} days of sales.`);
        if (m && !canRegister(w, m, d)) closeIssue(w, iss, `${m.name} can no longer be registered; remaining stock handled as run-out.`);
        break;
      }
      case 'supply_volume': {
        const total = w.supplies.filter((s) => s.component === 'Battery pack' && s.modelIds.includes('MDL-EON')).reduce((a, s) => a + Math.max(s.dailyCapacity, ...s.pendingCapacity.map((p) => p.dailyCapacity)), 0);
        if (total >= 250) closeIssue(w, iss, `Contracted Eon battery capacity now ${total} packs/day (incl. signed future increases).`);
        break;
      }
      case 'refinancing': {
        const secured = Number(iss.data.securedCents ?? 0);
        if (byId(w.debts, 'DEBT-BOND28')?.status === 'repaid') {
          closeIssue(w, iss, 'The 2028 notes have been repaid.');
          break;
        }
        if (secured >= mEur(700)) {
          closeIssue(w, iss, 'Refinancing of the 2028 notes secured.');
          break;
        }
        const planPresented = w.commitments.some((c) => c.id === 'COM-001' && c.status === 'fulfilled');
        const inFlight = w.financing.filter((f) => ['under_review', 'offered', 'accepted', 'pending_approval'].includes(f.status) && ['bank_term_loan', 'bond', 'rights_issue', 'sale_leaseback'].includes(f.kind)).reduce((a, f) => a + f.requestedCents, 0);
        if (secured > 0 || planPresented || inFlight > 0) {
          // The April deadline was for presenting a plan; once refinancing is under way, show progress instead.
          if (planPresented || secured > 0) iss.deadline = null;
          iss.title = `2028 bond (€900m) refinancing — ${fmtEur(secured)} of €700m secured`;
          iss.nextAction = `Secure at least €700m in total (bank loans, bonds, equity or asset sales) before the notes mature on 15 November 2028.${inFlight > 0 ? ` ${fmtEur(inFlight)} more is under review with lenders.` : ''}`;
        }
        break;
      }
      case 'labor_agreement': {
        if (w.contracts.some((c) => c.kind === 'labor' && c.status === 'active' && c.signedDate && c.signedDate >= '2027-01-01')) closeIssue(w, iss, 'New collective agreement signed.');
        break;
      }
    }
    // A deadline means "decide by": choosing one of the documented responses in time meets it.
    if (iss.deadline && d > iss.deadline && !iss.data.deadlineFlagged && iss.chosenOptions.length === 0 && !['resolved', 'closed'].includes(iss.status)) {
      iss.data.deadlineFlagged = 1;
      iss.severity = SEVERITY_UP[iss.severity];
      emit(w, { type: 'issue_deadline_missed', category: 'project', severity: 'warning', title: `Deadline missed: ${iss.title}`, description: `The issue was due to be addressed by ${iss.deadline}. Severity raised to ${iss.severity}.`, causeKind: 'causal', entities: [{ type: 'issue', id: iss.id }, ...iss.linked] });
      if (iss.ownerId) adjustTrust(w, iss.ownerId, -1);
    }
  }
}

function closeIssue(w: World, iss: Issue, note: string): void {
  iss.status = 'resolved';
  iss.resolvedDate = w.meta.currentDate;
  iss.resolutionNote = note;
  emit(w, { type: 'issue_resolved', category: 'project', severity: 'notice', title: `Resolved: ${iss.title}`, description: note, causeKind: 'causal', entities: [{ type: 'issue', id: iss.id }, ...iss.linked] });
}

function finishInvestigation(w: World, iss: Issue): void {
  if (iss.kind === 'kora_inverter') {
    iss.status = 'open';
    iss.data.rootCause = 'confirmed';
    iss.data.workPerDay = null;
    iss.severity = 'high';
    const campaign = iss.options.find((o) => o.key === 'service_campaign');
    if (campaign) {
      campaign.costCents = mEur(26);
      campaign.label = 'Targeted service campaign (~41,000 vehicles, capacitor batch)';
      campaign.description = 'Replace the affected capacitor batch at dealers; software update for all.';
      campaign.effects = campaign.effects.map((e) => (e.type === 'provision' ? { ...e, amountCents: mEur(26) } : e));
    }
    iss.options = iss.options.filter((o) => o.key !== 'investigate');
    iss.nextAction = 'Launch the targeted service campaign; then negotiate cost-sharing with Hanseatic.';
    emit(w, { type: 'investigation_complete', category: 'product', severity: 'warning', title: 'Kora inverter root cause confirmed', description: 'Teardowns trace the shutdowns to a capacitor batch from a Hanseatic sub-supplier change in 2025. About 41,000 vehicles are affected. A targeted campaign would cost ~€26m; the Hanseatic contract allows up to 50% cost recovery for systematic defects.', causeKind: 'causal', cause: { text: 'Root-cause investigation completed.', refs: [{ type: 'issue', id: iss.id }] }, entities: [{ type: 'issue', id: iss.id }, { type: 'supplier', id: 'SUP-HANSEATIC' }], followUps: ['Approve the targeted campaign', 'Open a cost-sharing negotiation with Hanseatic'] });
    inbox(w, { kind: 'report', fromId: 'CHR-MARCHETTI', subject: 'Kora inverter — root cause', body: 'We have it: a capacitor batch Hanseatic introduced in 2025 without telling us. ~41,000 cars. I recommend the targeted campaign now and a hard conversation with Hanseatic about cost-sharing.', priority: 'high', linked: [{ type: 'issue', id: iss.id }] });
    remember(w, { characterId: 'CHR-MARCHETTI', kind: 'observation', summary: 'Confirmed the Kora inverter root cause (Hanseatic capacitor batch).', importance: 4, sentiment: 1, sourceType: 'issue', sourceId: iss.id, entityRefs: [{ type: 'issue', id: iss.id }] });
  } else {
    closeIssue(w, iss, 'Investigation completed.');
  }
}

/** Scheduled world developments (regulations, tariff decision, Euro 7). */
export function scheduledDevelopments(w: World): void {
  const d = w.meta.currentDate;
  const rng = rngFor(w);
  for (const r of w.regulations) {
    if (r.kind === 'subsidy' && r.status === 'announced' && d >= r.effectiveDate) {
      r.status = 'in_force';
      emit(w, { type: 'regulation_in_force', category: 'regulatory', severity: 'info', title: `${r.name} now in force`, description: r.description, causeKind: 'scheduled', entities: [{ type: 'regulation', id: r.id }] });
    }
    if (r.kind === 'trade' && r.status === 'proposed' && d >= r.effectiveDate) {
      const raised = w.mode === 'live' ? rng.u('tariff-decision', r.id) < Number(r.params.probability ?? 0.5) : false;
      r.status = raised ? 'in_force' : 'expired';
      if (raised) {
        const pct = Number(r.params.priceEffectPct ?? 0.08);
        for (const p of w.competitorProducts.filter((x) => x.competitorId === 'CMP-SHENLONG')) p.priceCents = Math.round((p.priceCents * (1 + pct)) / 100) * 100;
      }
      emit(w, { type: 'tariff_decision', category: 'regulatory', severity: 'notice', title: raised ? 'EU raises duties on Chinese-built BEVs' : 'EU leaves duties on Chinese BEVs unchanged', description: raised ? `Shenlong prices rise by about ${Math.round(Number(r.params.priceEffectPct) * 100)}%.` : 'Shenlong keeps its price advantage.', causeKind: 'scheduled', cause: { text: 'Scheduled Commission decision (uncertain outcome).', refs: [{ type: 'regulation', id: r.id }] }, entities: [{ type: 'regulation', id: r.id }, { type: 'competitor', id: 'CMP-SHENLONG' }] });
    }
    if (r.kind === 'type_approval' && r.params.allNewCarsDate) {
      const cutoff = String(r.params.allNewCarsDate);
      const affected = w.models.filter((m) => m.status === 'in_production' && !m.euro7Compliant);
      if (d === addDays(cutoff, -60) && affected.length) {
        emit(w, { type: 'euro7_warning', category: 'regulatory', severity: 'critical', title: `Euro 7 applies to all new cars in 60 days`, description: `${affected.map((m) => m.name).join(', ')} ${affected.length > 1 ? 'are' : 'is'} not certified. From ${cutoff} they can no longer be registered; unsold stock must be exported or written down.`, causeKind: 'scheduled', entities: [{ type: 'regulation', id: r.id }, ...affected.map((m) => ({ type: 'model' as const, id: m.id }))] });
      }
      if (d === cutoff && affected.length) {
        for (const m of affected) {
          m.lifecycle = 'run_out';
          const lost = m.dealerStock + m.fgUnits;
          for (const l of w.lines.filter((x) => x.modelId === m.id)) l.status = 'idle';
          // Unregistrable stock is written down to export value (40%).
          const writeDown = Math.round(m.fgValueCents * 0.6);
          if (writeDown > 0) {
            post(w, { description: `${m.name}: write-down of non-Euro 7 stock`, sourceType: 'impairment', sourceId: m.id, lines: [{ account: '6850', amountCents: writeDown }, { account: '1200', amountCents: -writeDown }] });
            m.fgValueCents -= writeDown;
          }
          m.status = 'discontinued';
          emit(w, { type: 'euro7_stop', category: 'regulatory', severity: 'critical', title: `${m.name} can no longer be registered`, description: `Euro 7 now applies to all new cars. ${lost.toLocaleString('en-GB')} units in company and dealer stock are stranded; company stock written down by €${(writeDown / 1e8).toFixed(0)}m. The production line is idle.`, causeKind: 'scheduled', cause: { text: 'Regulatory deadline reached without certification.', refs: [{ type: 'regulation', id: r.id }] }, entities: [{ type: 'model', id: m.id }, { type: 'regulation', id: r.id }] });
        }
      }
    }
  }
  // Expire macro shocks and recompute energy index.
  w.macro.shocks = w.macro.shocks.filter((s) => s.until >= d);
  w.macro.energyIndex = Math.round((1 + w.macro.shocks.reduce((a, s) => a + s.energyEffect, 0)) * 1000) / 1000;
  if (!w.macro.shocks.some((s) => s.key === 'downturn') && w.macro.consumerConfidence < 98.5) w.macro.consumerConfidence = Math.min(98.5, Math.round((w.macro.consumerConfidence + 0.02) * 100) / 100);
}

/** Run eligible events for the day. Monthly events are checked on the 1st. */
export function runEvents(w: World): void {
  const rng = rngFor(w);
  const d = w.meta.currentDate;
  const firstOfMonth = d.endsWith('-01');
  // Pending, validated proposals from conversations are re-checked first.
  const proposals = w.eventStates.filter((s) => s.key.startsWith('proposed:'));
  for (const p of proposals) {
    const def = EVENT_CATALOGUE.find((e) => e.key === p.data.eventKey);
    w.eventStates = w.eventStates.filter((s) => s !== p);
    if (!def || !def.proposable) continue;
    const elig = def.check(w, rng).find((e) => !p.data.entityId || e.entityId === p.data.entityId);
    const key = `${def.key}${elig?.entityId ? `:${elig.entityId}` : ''}`;
    if (!elig || onCooldown(w, key, def.cooldownDays)) continue;
    def.apply(w, rng, { ...elig, cause: `${elig.cause} (escalated in conversation: ${p.data.rationale ?? ''})` });
    const st = state(w, key);
    st.lastFired = d;
    st.count += 1;
  }
  for (const def of EVENT_CATALOGUE) {
    if (def.frequency === 'monthly' && !firstOfMonth) continue;
    if (w.mode === 'forecast' && def.kind === 'random_shock') continue;
    for (const e of def.check(w, rng)) {
      const key = `${def.key}${e.entityId ? `:${e.entityId}` : ''}`;
      if (def.cooldownDays > 0 && onCooldown(w, key, def.cooldownDays)) continue;
      const p = w.mode === 'forecast' ? (e.probability >= 1 ? 1 : 0) : e.probability;
      if (p <= 0) continue;
      if (p < 1 && !rng.chance(p, d, 'event', key)) continue;
      def.apply(w, rng, e);
      const st = state(w, key);
      st.lastFired = d;
      st.count += 1;
    }
  }
}

/** Register an LLM-proposed event for engine re-validation at the next tick. */
export function proposeEvent(w: World, eventKey: string, entityId: string | null, rationale: string): { accepted: boolean; reason: string } {
  const def = EVENT_CATALOGUE.find((e) => e.key === eventKey);
  if (!def) return { accepted: false, reason: `Unknown event type "${eventKey}".` };
  if (!def.proposable) return { accepted: false, reason: `"${def.label}" can only be triggered by the simulation itself.` };
  const elig = def.check(w, makeProbeRng()).find((e) => !entityId || e.entityId === entityId);
  if (!elig) return { accepted: false, reason: `Preconditions not met: ${def.preconditions.join('; ')}.` };
  w.eventStates.push({ key: `proposed:${eventKey}:${nextId(w, 'EP')}`, lastFired: null, count: 0, activeUntil: null, data: { eventKey, entityId, rationale: rationale.slice(0, 200) } });
  return { accepted: true, reason: 'Eligible — the simulation will process it at the next time step.' };
}

function makeProbeRng(): Rng {
  return { u: () => 0.5, n: () => 0, chance: () => false, range: (lo, hi) => (lo + hi) / 2, int: (lo) => lo };
}

/** Cash helper re-exported for event consequences that require payment. */
export { ensureCash };
export type { SimDate };
