/**
 * Daily production: supplier deliveries into consignment stock, then line
 * output limited by planned rate, ramp-up, factory calendar/downtime,
 * workforce availability and critical-component availability.
 *
 * Accounting: components are consignment stock (supplier-owned) until
 * consumed; at consumption the vehicle's material cost is capitalised into
 * finished-goods inventory and a payable to each supplier is created at its
 * payment terms. Conversion costs (labour, overhead) are period costs
 * (variable-costing inventory valuation — see README).
 */
import type { ComponentSupply, Factory, ProductionLine, VehicleModel } from '../../shared/domain';
import { addDays, isWorkingDay, type SimDate } from '../../shared/dates';
import { times, type Cents } from '../../shared/money';
import { post } from './ledger';
import { byId, nextId, rngFor, type World } from './world';

export function inDowntime(f: Factory, d: SimDate): { kind: string; reason: string } | null {
  for (const dt of f.downtime) if (d >= dt.start && d <= dt.end) return { kind: dt.kind, reason: dt.reason };
  return null;
}

export function factoryOperatingToday(f: Factory, d: SimDate): boolean {
  return f.status === 'operating' && isWorkingDay(d) && !inDowntime(f, d);
}

export function rampFactor(line: ProductionLine, d: SimDate): number {
  if (line.status !== 'ramp_up' || !line.rampStartDate) return line.status === 'running' ? 1 : 0;
  const elapsed = Math.max(0, (Date.parse(d) - Date.parse(line.rampStartDate)) / 86_400_000);
  return Math.min(1, 0.25 + 0.75 * (elapsed / Math.max(1, line.rampDays)));
}

export function effectiveDailyTarget(line: ProductionLine, d: SimDate): number {
  if (line.status === 'idle' || line.status === 'not_ready') return 0;
  return Math.min(line.plannedDailyRate, line.maxDailyRate) * rampFactor(line, d);
}

export function requiredCrew(w: World, f: Factory, d: SimDate): number {
  const lines = w.lines.filter((l) => l.factoryId === f.id);
  const planned = lines.reduce((a, l) => a + effectiveDailyTarget(l, d), 0);
  if (planned <= 0) return 0;
  return f.fixedCrew + f.crewPerDailyUnit * planned;
}

/** Crew the factory needs once every non-idle line runs at its planned rate (ramp-up complete). */
export function steadyStateCrew(w: World, f: Factory): number {
  const planned = w.lines.filter((l) => l.factoryId === f.id && l.status !== 'idle').reduce((a, l) => a + Math.min(l.plannedDailyRate, l.maxDailyRate), 0);
  return planned > 0 ? f.fixedCrew + f.crewPerDailyUnit * planned : 0;
}

export function availableCrew(w: World, f: Factory): number {
  const dept = byId(w.departments, f.departmentId);
  if (!dept) return 0;
  return dept.headcount * (1 - f.absenteeismPct / 100);
}

/** Workforce constraint: share of the planned output the present crew can build (≤ 1). */
export function workforceFactor(w: World, f: Factory, d: SimDate): number {
  const req = requiredCrew(w, f, d);
  if (req <= 0) return 1;
  return Math.min(1, availableCrew(w, f) / req);
}

/** Capacity per day currently available from a supply (after disruptions). */
export function supplyCapacityToday(s: ComponentSupply, d: SimDate): number {
  const disrupted = s.disruptionUntil && d <= s.disruptionUntil ? s.disruptionFactor : 0;
  return Math.floor(s.dailyCapacity * (1 - disrupted));
}

/** Supplies grouped by component for a model. */
export function componentGroups(w: World, modelId: string): Map<string, ComponentSupply[]> {
  const m = new Map<string, ComponentSupply[]>();
  for (const s of w.supplies) {
    if (!s.modelIds.includes(modelId)) continue;
    const arr = m.get(s.component) ?? [];
    arr.push(s);
    m.set(s.component, arr);
  }
  return m;
}

/** Contracted (non-disrupted) daily capacity for the component group of the listed supplies. */
export function groupCapacity(w: World, supplyIds: string[], asOf?: SimDate): number {
  const ref = supplyIds.map((id) => byId(w.supplies, id)).find(Boolean);
  if (!ref) return 0;
  return w.supplies
    .filter((s) => s.component === ref.component && s.modelIds.some((m) => ref.modelIds.includes(m)))
    .reduce((a, s) => {
      let cap = s.dailyCapacity;
      if (asOf) for (const p of s.pendingCapacity) if (p.date <= asOf) cap = Math.max(cap, p.dailyCapacity);
      return a + cap;
    }, 0);
}

export interface ProductionResult {
  byModel: Record<string, number>;
  constraints: string[];
}

/** Apply pending capacity changes and end of disruptions. */
export function updateSupplies(w: World): void {
  const d = w.meta.currentDate;
  for (const s of w.supplies) {
    const due = s.pendingCapacity.filter((p) => p.date <= d);
    if (due.length) {
      for (const p of due) s.dailyCapacity = p.dailyCapacity;
      s.pendingCapacity = s.pendingCapacity.filter((p) => p.date > d);
    }
    if (s.disruptionUntil && d > s.disruptionUntil) {
      s.disruptionFactor = 0;
      s.disruptionUntil = null;
    }
  }
}

export function runProduction(w: World): ProductionResult {
  const d = w.meta.currentDate;
  const rng = rngFor(w);
  const res: ProductionResult = { byModel: {}, constraints: [] };

  // 1. planned output per line (calendar, downtime, ramp, workforce, random losses)
  const target: Record<string, number> = {}; // lineId -> units
  for (const f of w.factories) {
    if (!factoryOperatingToday(f, d)) continue;
    const wf = workforceFactor(w, f, d);
    if (wf < 0.999) res.constraints.push(`${f.name}: workforce limits output to ${(wf * 100).toFixed(0)}% of plan`);
    for (const line of w.lines.filter((l) => l.factoryId === f.id)) {
      const t = effectiveDailyTarget(line, d);
      if (t <= 0) continue;
      const loss = rng.u(d, 'lineloss', line.id) * 0.04; // 0–4% unplanned losses (2% in forecasts)
      target[line.id] = Math.floor(t * wf * (1 - loss));
    }
  }

  // 2. supplier deliveries into consignment stock, sized to planned consumption
  const plannedNeed: Record<string, number> = {}; // supplyId -> sets needed today
  const lineByModel = new Map<string, ProductionLine[]>();
  for (const l of w.lines) lineByModel.set(l.modelId, [...(lineByModel.get(l.modelId) ?? []), l]);
  const modelTarget: Record<string, number> = {};
  for (const [lineId, units] of Object.entries(target)) {
    const l = byId(w.lines, lineId)!;
    modelTarget[l.modelId] = (modelTarget[l.modelId] ?? 0) + units;
  }
  if (isWorkingDay(d)) {
    for (const s of w.supplies) {
      // Split the group's need across parallel sources in proportion to today's capacity.
      const group = w.supplies.filter((o) => o.component === s.component && o.modelIds.some((m) => s.modelIds.includes(m)));
      const groupCap = group.reduce((a, o) => a + supplyCapacityToday(o, d), 0);
      const split = groupCap > 0 ? supplyCapacityToday(s, d) / groupCap : 1 / group.length;
      const need = s.modelIds.reduce((a, m) => a + (modelTarget[m] ?? 0), 0) * split;
      plannedNeed[s.id] = need;
      const planDaily = s.modelIds.reduce((a, m) => a + (lineByModel.get(m) ?? []).reduce((b, l) => b + effectiveDailyTarget(l, d), 0), 0) * split;
      const targetStock = Math.round(planDaily * s.targetStockDays);
      const want = Math.max(0, Math.round(need + targetStock - s.stockUnits));
      const deliver = Math.min(want, supplyCapacityToday(s, d));
      s.stockUnits += deliver;
    }
  }

  // 3. component availability per model, allocated across models sharing a supply
  const produced: Record<string, number> = {};
  for (const [modelId, want] of Object.entries(modelTarget)) {
    let canBuild = want;
    for (const [component, group] of componentGroups(w, modelId)) {
      let avail = 0;
      for (const s of group) {
        const sharers = s.modelIds.map((m) => modelTarget[m] ?? 0);
        const totalWant = sharers.reduce((a, b) => a + b, 0);
        const share = totalWant > 0 ? want / totalWant : 1;
        avail += Math.floor(s.stockUnits * share);
      }
      if (avail < canBuild) {
        canBuild = avail;
        res.constraints.push(`${byId(w.models, modelId)?.name}: ${component} shortage limits output to ${avail}`);
      }
    }
    produced[modelId] = Math.max(0, canBuild);
  }

  // 4. consume components, value production, create payables
  const supplierAmounts: Record<string, Cents> = {};
  let inventoryIn = 0;
  for (const [modelId, units] of Object.entries(produced)) {
    if (units <= 0) continue;
    const m = byId(w.models, modelId)!;
    let cost = times(m.otherMaterialCostCents, units);
    supplierAmounts['SUP-TIER2'] = (supplierAmounts['SUP-TIER2'] ?? 0) + times(m.otherMaterialCostCents, units);
    for (const [, group] of componentGroups(w, modelId)) {
      let left = units;
      // consume primary sources first, then alternatives
      for (const s of [...group].sort((a, b) => a.isAlternative - b.isAlternative)) {
        if (left <= 0) break;
        const take = Math.min(left, s.stockUnits);
        s.stockUnits -= take;
        left -= take;
        const amt = times(s.unitPriceCents, take);
        cost += amt;
        supplierAmounts[s.supplierId] = (supplierAmounts[s.supplierId] ?? 0) + amt;
      }
    }
    m.fgUnits += units;
    m.fgValueCents += cost;
    m.productionMtd += units;
    inventoryIn += cost;
    res.byModel[modelId] = units;
  }
  if (inventoryIn > 0) {
    post(w, {
      description: `Production ${d}: ${Object.entries(res.byModel).map(([id, u]) => `${byId(w.models, id)?.name} ×${u}`).join(', ')}`,
      sourceType: 'production',
      lines: [
        { account: '1200', amountCents: inventoryIn },
        { account: '2000', amountCents: -inventoryIn },
      ],
    });
    for (const [supplierId, amt] of Object.entries(supplierAmounts)) {
      if (amt <= 0) continue;
      const sup = byId(w.suppliers, supplierId);
      w.payables.push({ id: nextId(w, 'AP'), counterpartyId: supplierId, category: 'materials', amountCents: amt, issueDate: d, dueDate: addDays(d, sup?.paymentTermsDays ?? 60), status: 'open', paidDate: null, sourceId: `PROD-${d}`, liabilityAccount: '2000' });
    }
  }
  for (const m of w.models) m.fgUnitDaysMtd += m.fgUnits;
  return res;
}

export function unitCostOf(m: VehicleModel): Cents {
  return m.fgUnits > 0 ? Math.round(m.fgValueCents / m.fgUnits) : 0;
}
