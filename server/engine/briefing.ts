/** Deterministic management briefing generated after each time advance. */
import type { GameEvent } from '../../shared/domain';
import { addDays, diffDays, fmtDate, type SimDate } from '../../shared/dates';
import { fmtEur } from '../../shared/money';
import { upcomingMeeting } from './board';
import { cash } from './ledger';
import { liquidity } from './metrics';
import type { DayResult } from './tick';
import { byId, type World } from './world';

export function buildBriefing(w: World, from: SimDate, days: DayResult[], events: GameEvent[], cashBefore: number): { subject: string; body: string } {
  const to = days.length ? days[days.length - 1].date : from;
  const prod: Record<string, number> = {};
  const retail: Record<string, number> = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(d.produced)) prod[k] = (prod[k] ?? 0) + v;
    for (const [k, v] of Object.entries(d.retail)) retail[k] = (retail[k] ?? 0) + v;
  }
  const lines: string[] = [];
  lines.push(`Period: ${fmtDate(from)} – ${fmtDate(to)} (${days.length} day${days.length === 1 ? '' : 's'}).`);
  const names = (r: Record<string, number>) => Object.entries(r).filter(([, v]) => v > 0).map(([k, v]) => `${byId(w.models, k)?.name.replace('Asterion ', '')} ${v.toLocaleString('en-GB')}`).join(', ');
  lines.push(`Built: ${names(prod) || 'none'}. Retail sales: ${names(retail) || 'none'}.`);
  const c = cash(w);
  lines.push(`Cash ${fmtEur(c)} (${c - cashBefore >= 0 ? '+' : ''}${fmtEur(c - cashBefore)}); liquidity incl. undrawn RCF ${fmtEur(liquidity(w))}.`);
  const constraints = [...new Set(days.flatMap((d) => d.constraints))].slice(0, 3);
  if (constraints.length) lines.push(`Constraints: ${constraints.join('; ')}.`);
  const important = events.filter((e) => e.severity === 'critical' || e.severity === 'warning').slice(0, 8);
  if (important.length) {
    lines.push('', 'Needs attention:');
    for (const e of important) lines.push(`• ${e.title}`);
  }
  for (const b of events.filter((e) => e.type === 'board_meeting')) lines.push('', `Board (${fmtDate(b.date)}): ${b.description}`);
  const good = events.filter((e) => ['milestone_completed', 'project_completed', 'issue_resolved', 'contract_signed', 'financing_executed', 'negotiation_agreed', 'board_approved', 'approved_action_executed', 'hires_arrived', 'project_started'].includes(e.type)).slice(0, 6);
  if (good.length) {
    lines.push('', 'Progress:');
    for (const e of good) lines.push(`• ${e.title}`);
  }
  const horizon = addDays(w.meta.currentDate, 21);
  const upcoming: string[] = [];
  for (const cm of w.commitments) if (['open', 'due'].includes(cm.status) && cm.dueDate && cm.dueDate <= horizon) upcoming.push(`${cm.dueDate}: ${cm.description}${cm.status === 'due' ? ' (DUE — report outcome)' : ''}`);
  const meeting = upcomingMeeting(w);
  if (diffDays(meeting, w.meta.currentDate) <= 21) upcoming.push(`${meeting}: board meeting`);
  for (const n of w.negotiations) if (n.status === 'open' && n.deadline && n.deadline <= horizon) upcoming.push(`${n.deadline}: deadline — ${n.title}`);
  for (const f of w.financing) if (f.status === 'offered' && f.offer) upcoming.push(`${f.offer.validUntil}: offer expires — ${f.counterparty}`);
  if (upcoming.length) {
    lines.push('', 'Coming up (next 3 weeks):');
    for (const u of upcoming.sort().slice(0, 8)) lines.push(`• ${u}`);
  }
  const subject = `CEO briefing — ${fmtDate(to)}${important.length ? ` · ${important.length} item${important.length > 1 ? 's need' : ' needs'} attention` : ''}`;
  return { subject, body: lines.join('\n') };
}
