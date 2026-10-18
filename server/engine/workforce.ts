/** Workforce: hires, leavers, headcount-days (payroll base), morale and absenteeism. */
import { scale, times } from '../../shared/money';
import { isMonthEnd } from '../../shared/dates';
import { payOrDefer } from './treasury';
import { byId, clamp, emit, type World } from './world';

export function workforceDaily(w: World): void {
  const d = w.meta.currentDate;
  for (const dep of w.departments) {
    const arrivals = dep.hiring.filter((h) => h.arrivalDate <= d);
    if (arrivals.length) {
      const n = arrivals.reduce((a, h) => a + h.count, 0);
      dep.headcount += n;
      dep.hiring = dep.hiring.filter((h) => h.arrivalDate > d);
      emit(w, { type: 'hires_arrived', category: 'people', severity: 'info', title: `${n} new employees joined ${dep.name}`, description: `Headcount now ${dep.headcount.toLocaleString('en-GB')}.`, causeKind: 'scheduled', entities: [{ type: 'department', id: dep.id }] });
    }
    const leavers = dep.leaving.filter((l) => l.date <= d);
    if (leavers.length) {
      for (const l of leavers) {
        const n = Math.min(l.count, dep.headcount);
        dep.headcount -= n;
        const sev = times(l.severancePerHeadCents, n);
        if (sev > 0) payOrDefer(w, { description: `Severance paid — ${dep.name} (${n} employees)`, sourceType: 'restructuring', sourceId: l.actionId, cf: { category: 'operating', line: 'restructuring' }, debits: [{ account: '2400', amountCents: sev }], counterpartyId: 'EMPLOYEES', category: 'restructuring' });
        emit(w, { type: 'job_cuts_effective', category: 'people', severity: 'notice', title: `${n} positions eliminated at ${dep.name}`, description: `${l.reason}. Headcount now ${dep.headcount.toLocaleString('en-GB')}.`, causeKind: 'player_action', actionId: l.actionId, entities: [{ type: 'department', id: dep.id }] });
      }
      dep.leaving = dep.leaving.filter((l) => l.date > d);
    }
    dep.headcountDays += dep.headcount;
  }
  if (isMonthEnd(d)) monthlyPeople(w);
}

function monthlyPeople(w: World): void {
  for (const dep of w.departments) {
    dep.morale = clamp(Math.round((dep.morale + (60 - dep.morale) * 0.04) * 10) / 10, 0, 100);
    if (dep.kind === 'plant' && dep.factoryId) {
      const f = byId(w.factories, dep.factoryId);
      if (f) {
        const target = 3.5 + Math.max(0, 70 - dep.morale) * 0.15;
        f.absenteeismPct = Math.round((f.absenteeismPct + (target - f.absenteeismPct) * 0.3) * 100) / 100;
      }
    }
    if (dep.kind === 'engineering' && dep.morale < 45) {
      const lost = Math.round(scale(dep.headcount, (45 - dep.morale) * 0.001));
      if (lost > 0) {
        dep.headcount -= lost;
        emit(w, { type: 'engineering_attrition', category: 'people', severity: 'warning', title: `${lost} engineers resigned from ${dep.name}`, description: `Low morale (${dep.morale.toFixed(0)}/100) is driving resignations.`, causeKind: 'causal', cause: { text: 'Department morale below 45.', refs: [{ type: 'department', id: dep.id }] }, entities: [{ type: 'department', id: dep.id }] });
      }
    }
  }
}
