/**
 * Commitments (promises): tracked separately from projects and issues.
 * Machine-checkable commitments are verified by the engine; free-form ones
 * become "due" and must be marked fulfilled/broken by the CEO — if ignored for
 * 14 days past the due date, the promisee considers them broken.
 */
import type { Commitment } from '../../shared/domain';
import { addDays, diffDays } from '../../shared/dates';
import { fmtEur } from '../../shared/money';
import { liquidity } from './metrics';
import { adjustTrust, byId, emit, inbox, remember, type World } from './world';

export function evaluateCheck(w: World, c: Commitment): 'fulfilled' | 'broken' | 'pending' {
  const d = w.meta.currentDate;
  const past = !!c.dueDate && d > c.dueDate;
  switch (c.check.type) {
    case 'milestone_completed_by': {
      const m = byId(w.milestones, c.check.milestoneId);
      if (m?.status === 'completed' && (!c.dueDate || (m.completedDate ?? d) <= c.dueDate)) return 'fulfilled';
      return past ? 'broken' : 'pending';
    }
    case 'project_completed_by': {
      const p = byId(w.projects, c.check.projectId);
      if (p?.status === 'completed' && (!c.dueDate || (p.completedDate ?? d) <= c.dueDate)) return 'fulfilled';
      if (p?.status === 'cancelled') return 'broken';
      return past ? 'broken' : 'pending';
    }
    case 'no_headcount_reduction': {
      const ids = c.check.departmentIds;
      const violated = w.departments.some((dep) => ids.includes(dep.id) && dep.leaving.some((l) => l.reason.toLowerCase().includes('compulsory')));
      if (violated) return 'broken';
      return past ? 'fulfilled' : 'pending';
    }
    case 'min_liquidity': {
      if (liquidity(w) < c.check.amountCents) return 'broken';
      return past ? 'fulfilled' : 'pending';
    }
    case 'price_floor': {
      const m = byId(w.models, c.check.modelId);
      if (m && m.netPriceCents < c.check.minNetPriceCents) return 'broken';
      return past ? 'fulfilled' : 'pending';
    }
    case 'deliver_plan': {
      const topic = c.check.topic;
      const since = c.createdDate;
      let delivered = false;
      if (topic === 'voltaris_volume') delivered = w.negotiations.some((n) => n.templateKey === 'voltaris_supply' && (n.status === 'agreed' || n.pendingDecision !== null));
      else if (topic === 'refinancing')
        delivered =
          w.financing.some((f) => ['bank_term_loan', 'bond', 'rights_issue', 'sale_leaseback', 'shareholder_loan'].includes(f.kind) && !['draft', 'withdrawn'].includes(f.status) && f.submittedDate >= since) ||
          // A financing request put to the board for a meeting on or before the deadline counts as presenting the plan.
          w.boardProposals.some((b) => b.submittedDate >= since && (!c.dueDate || b.meetingDate <= c.dueDate) && !['withdrawn', 'rejected'].includes(b.status) && (b.kind === 'request_financing' || Number(b.analysis.containsFinancing ?? 0) === 1));
      else delivered = w.boardProposals.some((p) => p.submittedDate >= since && p.status !== 'withdrawn');
      if (delivered) return 'fulfilled';
      return past ? 'broken' : 'pending';
    }
    case 'freeform':
      return 'pending';
  }
}

export function resolveCommitment(w: World, c: Commitment, outcome: 'fulfilled' | 'broken' | 'cancelled', note: string): void {
  c.status = outcome;
  c.resolvedDate = w.meta.currentDate;
  const promisee = byId(w.characters, c.promiseeId);
  const delta = outcome === 'fulfilled' ? 4 + c.importance : outcome === 'broken' ? -(6 + c.importance * 2) : -1;
  if (c.promisorId === 'ceo' && promisee) {
    adjustTrust(w, promisee.id, delta);
    remember(w, { characterId: promisee.id, kind: outcome === 'broken' ? 'grievance' : 'promise', summary: `The CEO ${outcome === 'fulfilled' ? 'kept' : outcome === 'broken' ? 'broke' : 'withdrew'} a promise: "${c.description}". ${note}`, importance: Math.min(5, c.importance + (outcome === 'broken' ? 1 : 0)), sentiment: outcome === 'fulfilled' ? 2 : outcome === 'broken' ? -2 : -1, sourceType: 'commitment', sourceId: c.id, entityRefs: [{ type: 'commitment', id: c.id }] });
  }
  emit(w, {
    type: `commitment_${outcome}`,
    category: 'people',
    severity: outcome === 'broken' ? 'warning' : 'info',
    title: `Commitment ${outcome}: ${c.description.slice(0, 80)}${c.description.length > 80 ? '…' : ''}`,
    description: `${note}${promisee ? ` ${promisee.name}'s trust ${delta >= 0 ? '+' : ''}${delta}.` : ''}`,
    causeKind: outcome === 'cancelled' ? 'player_action' : 'causal',
    entities: [{ type: 'commitment', id: c.id }, ...(promisee ? [{ type: 'character' as const, id: promisee.id }] : [])],
  });
}

export function processCommitments(w: World): void {
  const d = w.meta.currentDate;
  for (const c of w.commitments) {
    if (!['open', 'due'].includes(c.status)) continue;
    if (c.check.type !== 'freeform') {
      const r = evaluateCheck(w, c);
      if (r !== 'pending') {
        resolveCommitment(w, c, r, r === 'fulfilled' ? 'Verified by the simulation.' : c.dueDate && d > c.dueDate ? `Not delivered by ${c.dueDate}.` : 'Condition violated.');
        continue;
      }
    } else if (c.dueDate && d > c.dueDate) {
      if (c.status === 'open') {
        c.status = 'due';
        inbox(w, { kind: 'warning', fromId: null, subject: `Commitment due: ${c.description.slice(0, 60)}`, body: `You promised ${byId(w.characters, c.promiseeId)?.name ?? c.promiseeId}: "${c.description}" by ${c.dueDate}. Mark it fulfilled or broken (Inbox → Commitments). If nothing is reported within 14 days the promisee will consider it broken.`, priority: 'high', linked: [{ type: 'commitment', id: c.id }] });
      } else if (diffDays(d, c.dueDate) > 14) {
        resolveCommitment(w, c, 'broken', 'No delivery was reported within 14 days of the due date.');
        continue;
      }
    }
    if (c.dueDate && !c.notifiedUpcoming && c.dueDate >= d && c.dueDate <= addDays(d, 14)) {
      c.notifiedUpcoming = 1;
      const promisee = byId(w.characters, c.promiseeId);
      inbox(w, { kind: 'warning', fromId: null, subject: `Due in ${diffDays(c.dueDate, d)} days: ${c.description.slice(0, 60)}`, body: `Commitment to ${promisee?.name ?? c.promiseeId}, due ${c.dueDate}: "${c.description}". ${c.conditions}`, priority: c.importance >= 4 ? 'high' : 'normal', linked: [{ type: 'commitment', id: c.id }] });
      emit(w, { type: 'commitment_upcoming', category: 'people', severity: 'notice', title: `Commitment due ${c.dueDate}: ${c.description.slice(0, 70)}`, description: `Promised to ${promisee?.name ?? c.promiseeId}.`, causeKind: 'scheduled', entities: [{ type: 'commitment', id: c.id }] });
    }
  }
}

export { fmtEur };
