/**
 * The CEO's three-year mandate. The board hired you to turn Asterion around;
 * these objectives are what it will judge at the end of the term. They are
 * tracked live (dashboard "Your mandate") and scored at the final review on
 * the term-end date. A passing score means the board renews your contract —
 * you win and may keep playing. Otherwise the board does not renew you.
 */
import type { MandateResult } from '../../shared/domain';
import { diffDays } from '../../shared/dates';
import { fmtEur, mEur } from '../../shared/money';
import { difficultyOf } from './difficulty';
import { liquidity } from './metrics';
import { byId, clamp, emit, inbox, type World } from './world';

export type ObjectiveState = 'met' | 'on_track' | 'at_risk' | 'missed';

export interface ObjectiveStatus {
  id: string;
  label: string;
  weight: number;
  /** 0..1 — the share of the weight earned if the term ended today. */
  score: number;
  state: ObjectiveState;
  detail: string;
  hint: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Live view of every mandate objective. */
export function mandateObjectives(w: World): ObjectiveStatus[] {
  const d = w.meta.currentDate;
  const end = w.meta.termEndDate;
  const plan = w.meta.boardPlan;
  const out: ObjectiveStatus[] = [];

  // 1. Board confidence
  const conf = w.meta.boardConfidence;
  out.push({
    id: 'confidence',
    label: 'Keep the board’s confidence',
    weight: 20,
    score: clamp(conf / 70, 0, 1),
    state: conf >= 60 ? 'met' : conf >= 40 ? 'on_track' : 'at_risk',
    detail: `Board confidence ${Math.round(conf)}/100 (full marks at 70+).`,
    hint: 'Deliver the plan the board approved, keep promises to directors, meet them regularly.',
  });

  // 2. The Eon
  const eon = byId(w.projects, 'PRJ-EON');
  const eonModel = byId(w.models, 'MDL-EON');
  if (eon) {
    const done = eon.status === 'completed' || eonModel?.status === 'in_production';
    const when = eon.completedDate ?? eon.forecastDate;
    const late = when ? diffDays(when, plan.eonSopDate) : 999;
    const score = done ? (late <= 90 ? 1 : late <= 240 ? 0.7 : 0.5) : eon.status === 'cancelled' ? 0 : when && when <= end ? (late <= 90 ? 0.6 : 0.4) : 0.1;
    out.push({
      id: 'eon',
      label: 'Launch the Eon electric crossover',
      weight: 20,
      score,
      state: done ? 'met' : eon.status === 'cancelled' ? 'missed' : when && late <= 90 ? 'on_track' : 'at_risk',
      detail: done ? `In production since ${eon.completedDate ?? 'launch'}${late > 0 ? ` (${late} days after plan)` : ''}.` : eon.status === 'cancelled' ? 'Cancelled.' : when ? `Forecast start of production ${when} (plan ${plan.eonSopDate}).` : 'No credible launch date yet — something blocks it (battery supply or validation).',
      hint: 'Secure battery supply (Voltaris or a second source) and clear the validation issues.',
    });
  }

  // 3. The Vela and Euro 7
  const vela = byId(w.models, 'MDL-VELA');
  const reg = byId(w.regulations, 'REG-EURO7');
  const cutoff = String(reg?.params.allNewCarsDate ?? '2027-11-29');
  if (vela) {
    const compliant = vela.euro7Compliant === 1;
    const programme = w.projects.find((p) => (p.templateKey === 'vela_euro7' || p.templateKey === 'vela_hybrid_refresh') && !['cancelled'].includes(p.status) && p.status !== 'proposed');
    const fc = programme?.completedDate ?? programme?.forecastDate ?? null;
    const score = compliant ? 1 : vela.status === 'discontinued' ? 0.5 : programme && fc && fc <= cutoff ? 0.7 : programme ? 0.4 : d > cutoff ? 0 : 0.1;
    out.push({
      id: 'vela',
      label: 'Keep the Vela sellable under Euro 7',
      weight: 10,
      score,
      state: compliant ? 'met' : programme && fc && fc <= cutoff ? 'on_track' : d > cutoff ? 'missed' : 'at_risk',
      detail: compliant ? 'Certified to Euro 7.' : programme ? `${programme.name}: forecast ${fc ?? 'blocked'} vs cut-off ${cutoff}.` : `No Euro 7 programme under way; the Vela cannot be registered after ${cutoff}.`,
      hint: 'Approve the Vela Euro 7 compliance project, or start the mild-hybrid refresh early enough.',
    });
  }

  // 4. Refinancing the 2028 bond
  const bond = byId(w.debts, 'DEBT-BOND28');
  const refi = byId(w.issues, 'ISS-REFI');
  if (bond) {
    const secured = Number(refi?.data.securedCents ?? 0);
    const repaid = bond.status === 'repaid';
    const resolved = refi?.status === 'resolved';
    out.push({
      id: 'refinancing',
      label: 'Refinance the 2028 bond',
      weight: 15,
      score: repaid ? 1 : resolved ? 1 : clamp(secured / mEur(700), 0, 0.9),
      state: repaid || resolved ? 'met' : secured > 0 ? 'on_track' : diffDays(bond.maturityDate, d) < 450 ? 'at_risk' : 'on_track',
      detail: repaid ? 'Repaid at maturity.' : resolved ? 'Refinancing secured.' : `${fmtEur(secured)} of €700m secured; the notes mature ${bond.maturityDate}.`,
      hint: 'Raise at least €700m (bank loans, a new bond, equity or asset sales) well before maturity.',
    });
  }

  // 5. Profit
  const fc = w.meta.lastForecastSummary;
  const fyEbit = fc?.fyEbitCents ?? 0;
  const profitScore = fyEbit >= plan.ebitTargetCents ? 1 : fyEbit >= 0 ? 0.5 + 0.5 * (fyEbit / Math.max(1, plan.ebitTargetCents)) : clamp(0.4 + fyEbit / mEur(500), 0, 0.4);
  out.push({
    id: 'profit',
    label: 'Return to solid profit',
    weight: 15,
    score: profitScore,
    state: fyEbit >= plan.ebitTargetCents ? 'met' : fyEbit >= 0 ? 'on_track' : 'at_risk',
    detail: `This year’s operating profit forecast ${fmtEur(fyEbit)} vs budget ${fmtEur(plan.ebitTargetCents)} (estimate).`,
    hint: 'Build only what dealers can sell, price for margin, cut fixed cost where you have surplus capacity.',
  });

  // 6. Liquidity
  const liq = liquidity(w);
  const low = fc ? (fc.minLiquidity12mCents ?? fc.minLiquidityCents) : liq;
  out.push({
    id: 'liquidity',
    label: 'Keep a safe liquidity buffer',
    weight: 10,
    score: clamp(Math.min(liq, low + mEur(200)) / plan.minLiquidityCents, 0, 1),
    state: low >= plan.minLiquidityCents ? 'met' : low >= mEur(400) ? 'on_track' : 'at_risk',
    detail: `Liquidity ${fmtEur(liq)} today; 12-month low ${fmtEur(low)} (board minimum ${fmtEur(plan.minLiquidityCents)}).`,
    hint: 'Refinance early, avoid surplus stock, and keep the credit line available.',
  });

  // 7. Commitments
  const resolved = w.commitments.filter((c) => c.promisorId === 'ceo' && ['fulfilled', 'broken'].includes(c.status));
  const kept = resolved.filter((c) => c.status === 'fulfilled').length;
  const ratio = resolved.length ? kept / resolved.length : 1;
  out.push({
    id: 'commitments',
    label: 'Keep your word',
    weight: 10,
    score: clamp((ratio - 0.4) / 0.5, 0, 1),
    state: ratio >= 0.85 ? 'met' : ratio >= 0.65 ? 'on_track' : 'at_risk',
    detail: resolved.length ? `${kept} of ${resolved.length} commitments kept (${pct(ratio)}).` : 'No commitments resolved yet.',
    hint: 'Only promise what you control, and report free-form promises as kept on time (Inbox → Commitments).',
  });
  return out;
}

export function mandateScore(objs: ObjectiveStatus[]): number {
  const total = objs.reduce((a, o) => a + o.weight, 0);
  return Math.round((objs.reduce((a, o) => a + o.weight * o.score, 0) / Math.max(1, total)) * 100);
}

export function gradeFor(score: number): MandateResult['grade'] {
  return score >= 85 ? 'A' : score >= 72 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F';
}

/** Final review on the term-end date. Called from the daily tick (live mode only). */
export function finalReview(w: World): void {
  if (w.mode !== 'live' || w.meta.status !== 'active' || w.meta.mandate || w.meta.currentDate !== w.meta.termEndDate) return;
  const objs = mandateObjectives(w);
  const score = mandateScore(objs);
  const passScore = difficultyOf(w).passScore;
  const passed = score >= passScore;
  w.meta.mandate = { date: w.meta.currentDate, score, grade: gradeFor(score), passed, passScore, objectives: objs.map((o) => ({ id: o.id, label: o.label, weight: o.weight, score: Math.round(o.score * 100) / 100, detail: o.detail })) };
  const lines = objs.map((o) => `• ${o.label}: ${Math.round(o.score * o.weight)}/${o.weight} — ${o.detail}`);
  if (passed) {
    emit(w, { type: 'mandate_renewed', category: 'board', severity: 'notice', title: `Mandate renewed — final review ${score}/100 (grade ${gradeFor(score)})`, description: `The board renews your contract. ${lines.join(' ')}`, causeKind: 'scheduled' });
    inbox(w, { kind: 'board', fromId: 'CHR-DUBREUIL', subject: `Your mandate: renewed (grade ${gradeFor(score)}, ${score}/100)`, body: `The board has completed its review of your three-year mandate and has decided to renew your contract.\n\n${lines.join('\n')}\n\nScore ${score}/100 (needed ${passScore}). Congratulations — you can keep running Asterion for as long as you like.`, priority: 'urgent', linked: [] });
  } else {
    w.meta.status = 'not_renewed';
    w.meta.terminalReason = `At the end of your three-year mandate the board scored your results ${score}/100 (grade ${gradeFor(score)}; ${passScore} needed) and did not renew your contract.`;
    emit(w, { type: 'mandate_not_renewed', category: 'board', severity: 'critical', title: `Mandate not renewed — final review ${score}/100`, description: `${w.meta.terminalReason} ${lines.join(' ')}`, causeKind: 'scheduled' });
    inbox(w, { kind: 'board', fromId: 'CHR-DUBREUIL', subject: `Your mandate: not renewed (${score}/100)`, body: `The board has completed its review of your mandate.\n\n${lines.join('\n')}\n\nScore ${score}/100 (needed ${passScore}). The board will not renew your contract.`, priority: 'urgent', linked: [] });
  }
}
