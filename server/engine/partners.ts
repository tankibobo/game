/**
 * Deals the CEO negotiated beyond the core supply chain:
 *  - fleet sales: a rental/leasing company takes N cars of one model over M
 *    months at a discount, delivered from factory stock and invoiced on
 *    delivery (they register them, so they count for CO₂ like retail);
 *  - contract assembly: a partner builds cars at Lyon for a fee per car,
 *    using Lyon capacity and crews (from the agreed start date to the end).
 */
import { addDays, isWorkingDay } from '../../shared/dates';
import { scale, times } from '../../shared/money';
import { post } from './ledger';
import { canRegister } from './demand';
import { factoryOperatingToday, workforceFactor } from './operations';
import { PARAMS } from './params';
import { adjustTrust, byId, emit, inbox, nextId, type World } from './world';

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));

export function runPartnerDeals(w: World): void {
  const d = w.meta.currentDate;
  if (!isWorkingDay(d)) return;
  for (const k of w.contracts.filter((c) => c.status === 'active' && c.templateKey)) {
    if (k.templateKey!.startsWith('fleet_')) fleetDelivery(w, k);
    else if (k.templateKey === 'contract_assembly') assemblyFee(w, k);
  }
}

function fleetDelivery(w: World, k: World['contracts'][number]): void {
  const d = w.meta.currentDate;
  const m = byId(w.models, String(k.terms.modelId));
  if (!m) return;
  // Fleet buyers register the cars: after the Euro 7 cut-off an uncertified model cannot be delivered.
  if (!canRegister(w, m, d)) {
    if (k.endDate && d > addDays(k.endDate, 60)) closeFleet(w, k, num(k.terms.units) - num(k.terms.delivered));
    return;
  }
  const units = num(k.terms.units);
  const delivered = num(k.terms.delivered);
  if (delivered >= units) return;
  const months = Math.max(1, num(k.terms.months));
  const quota = Math.ceil(units / (months * 21.5));
  const behind = Math.max(0, Math.round(units * Math.min(1, (num(k.terms.workingDaysElapsed) + 1) / (months * 21.5))) - delivered);
  k.terms.workingDaysElapsed = num(k.terms.workingDaysElapsed) + 1;
  const want = Math.min(units - delivered, Math.max(quota, behind));
  const ship = Math.min(want, m.fgUnits);
  if (ship <= 0) {
    // Out of factory stock: the order waits; after the end date the buyer cancels the rest.
    if (k.endDate && d > addDays(k.endDate, 60)) closeFleet(w, k, units - delivered);
    return;
  }
  const price = Math.round(m.netPriceCents * (1 - num(k.terms.discountPct) / 100));
  const unitCost = Math.round(m.fgValueCents / m.fgUnits);
  const cogs = ship === m.fgUnits ? m.fgValueCents : times(unitCost, ship);
  m.fgUnits -= ship;
  m.fgValueCents -= cogs;
  const revenue = times(price, ship);
  const warranty = scale(times(m.warrantyPerUnitCents, ship), 1);
  const logistics = times(m.logisticsPerUnitCents, ship);
  post(w, {
    description: `Fleet deliveries ${d}: ${ship} × ${m.name} (${k.title})`,
    sourceType: 'sales',
    sourceId: k.id,
    lines: [
      { account: '1100', amountCents: revenue },
      { account: '4000', amountCents: -revenue },
      { account: '5000', amountCents: cogs },
      { account: '1200', amountCents: -cogs },
      { account: '5200', amountCents: warranty },
      { account: '2200', amountCents: -warranty },
      { account: '5300', amountCents: logistics },
      { account: '2000', amountCents: -logistics },
    ],
  });
  w.receivables.push({ id: nextId(w, 'AR'), counterparty: k.counterpartyName, amountCents: revenue, issueDate: d, dueDate: addDays(d, 45), status: 'open', settledDate: null, source: `FLEET-${k.id}-${d}` });
  if (logistics > 0) w.payables.push({ id: nextId(w, 'AP'), counterpartyId: 'SUP-LOGISTICS', category: 'other', amountCents: logistics, issueDate: d, dueDate: addDays(d, 30), status: 'open', paidDate: null, sourceId: k.id, liabilityAccount: '2000' });
  // Fleet buyers register the cars: CO₂ and the service parc count them.
  w.meta.co2UnitsYtd += ship;
  w.meta.co2GramsYtd += ship * m.co2Gkm;
  m.wholesaleMtd += ship;
  k.terms.delivered = delivered + ship;
  k.terms.revenueCents = num(k.terms.revenueCents) + revenue;
  if (num(k.terms.delivered) >= units) closeFleet(w, k, 0);
  void PARAMS;
}

function closeFleet(w: World, k: World['contracts'][number], cancelled: number): void {
  k.status = 'expired';
  k.summary = `${k.summary} Completed ${w.meta.currentDate}: ${num(k.terms.delivered).toLocaleString('en-GB')} cars delivered${cancelled ? `, ${cancelled.toLocaleString('en-GB')} cancelled by the buyer (not available in time)` : ''}.`;
  if (cancelled && k.counterpartyId) adjustTrust(w, k.counterpartyId, -5);
  emit(w, { type: 'fleet_deal_completed', category: 'market', severity: cancelled ? 'warning' : 'notice', title: `${k.title}: ${cancelled ? 'closed early' : 'fully delivered'}`, description: `${num(k.terms.delivered).toLocaleString('en-GB')} cars delivered for €${Math.round(num(k.terms.revenueCents) / 1e8)}m.${cancelled ? ` ${cancelled.toLocaleString('en-GB')} cars could not be supplied in time and were cancelled.` : ''}`, causeKind: 'causal', entities: [{ type: 'contract', id: k.id }] });
  if (k.counterpartyId) inbox(w, { kind: 'letter', fromId: k.counterpartyId, subject: `${k.title}: ${cancelled ? 'we cancel the remainder' : 'order complete'}`, body: cancelled ? `We have waited long enough for the remaining ${cancelled.toLocaleString('en-GB')} cars and have cancelled them. A pity — we would have ordered again.` : 'All cars delivered. Our fleet managers are satisfied; we would be open to a follow-up order next season.', priority: 'normal', linked: [{ type: 'contract', id: k.id }] });
}

function assemblyFee(w: World, k: World['contracts'][number]): void {
  const d = w.meta.currentDate;
  const start = String(k.terms.productionStart ?? k.startDate ?? d);
  if (d < start) return;
  if (k.endDate && d > k.endDate) {
    endAssembly(w, k);
    return;
  }
  // Partner cars need Lyon's crews like our own: a short-staffed plant builds (and bills) fewer.
  const f = byId(w.factories, 'FAC-LYON');
  if (f && !factoryOperatingToday(f, d)) return;
  const cars = Math.floor(num(k.terms.carsPerDay) * (f ? workforceFactor(w, f, d) : 1));
  if (cars <= 0) return;
  const fee = times(Math.round(num(k.terms.feePerCarEur) * 100), cars);
  post(w, { description: `Contract assembly fee ${d}: ${cars} cars (${k.title})`, sourceType: 'contract', sourceId: k.id, lines: [{ account: '1100', amountCents: fee }, { account: '4900', amountCents: -fee }] });
  w.receivables.push({ id: nextId(w, 'AR'), counterparty: k.counterpartyName, amountCents: fee, issueDate: d, dueDate: addDays(d, 30), status: 'open', settledDate: null, source: `ASSY-${k.id}-${d}` });
  k.terms.carsBuilt = num(k.terms.carsBuilt) + cars;
  k.terms.feesCents = num(k.terms.feesCents) + fee;
}

/** Release Lyon capacity and crew when a contract-assembly deal ends. */
export function endAssembly(w: World, k: World['contracts'][number]): void {
  if (k.status !== 'active') return;
  k.status = 'expired';
  const f = byId(w.factories, 'FAC-LYON');
  const line = byId(w.lines, 'LINE-LYON-VELA');
  const cars = num(k.terms.carsPerDay);
  if (f) f.fixedCrew = Math.max(0, Math.round(f.fixedCrew - cars * f.crewPerDailyUnit));
  if (line) line.maxDailyRate += cars;
  emit(w, { type: 'assembly_deal_ended', category: 'market', severity: 'notice', title: `${k.title} ended`, description: `${num(k.terms.carsBuilt).toLocaleString('en-GB')} partner cars built at Lyon; fees €${Math.round(num(k.terms.feesCents) / 1e8)}m. Lyon capacity and crews are free again.`, causeKind: 'scheduled', entities: [{ type: 'contract', id: k.id }] });
}
