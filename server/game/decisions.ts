/**
 * The Decisions view: one place that lists every decision the CEO can take
 * (with the data each form needs), the drafts waiting for confirmation, and
 * everything already set in motion — with dates and what happens next.
 */
import { addDays } from '../../shared/dates';
import type { DB } from '../db/connection';
import { loadWorld, rowToAction } from '../db/repo';
import { meetingForSubmission, predictVote, proposalActionIds, upcomingMeeting } from '../engine/board';
import { engineeringFreeFte, rcfAvailable, rcf } from '../engine/metrics';
import { NEGOTIATION_TEMPLATES } from '../engine/negotiation';
import { PARAMS, RULES } from '../engine/params';
import { byId } from '../engine/world';
import { staffingNeed } from '../actions/defs/people';
import { supersededProposals } from '../actions/defs/projects';
import { PROJECT_TEMPLATES } from '../actions/templates';
import { CUSTOM_KINDS, SIZES, type CustomSize } from '../actions/custom';
import { describeEffect } from '../reports/catalog';
import { ACTION_BY_TYPE } from '../actions/registry';
import { actionView, pendingSignatures } from './game';

type Row = Record<string, unknown>;

export interface InProgressItem {
  kind: 'board_agenda' | 'approved_waiting' | 'hiring' | 'departures' | 'financing' | 'negotiation' | 'contract' | 'project_proposed' | 'meeting';
  date: string | null;
  title: string;
  detail: string;
  status: string;
  actionId?: string | null;
  link?: { page: string; param?: string | null };
  outlook?: ReturnType<typeof predictVote> | null;
  /** For approved decisions waiting: can it be carried out right now? */
  executable?: boolean;
}

/** Can a catalogue project start now? If not, why — in words the player can act on. */
export function templateStatus(w: ReturnType<typeof loadWorld>, key: string) {
  const t = PROJECT_TEMPLATES.find((x) => x.key === key)!;
  const free = Math.max(0, Math.floor(engineeringFreeFte(w)));
  const underWay = (k: string) => w.projects.some((x) => x.templateKey === k && !['cancelled', 'completed', 'proposed'].includes(x.status));
  const existing = w.projects.find((x) => x.templateKey === t.key && !['cancelled', 'completed'].includes(x.status));
  const completed = w.projects.find((x) => x.templateKey === t.key && x.status === 'completed');
  if (completed && !t.repeatable) return { running: false, completed: completed.completedDate, available: false, reason: `Completed on ${completed.completedDate} — its effects are in place.`, replaces: [], needsBoard: t.budgetCents > RULES.ceoSpendLimitCents };
  const blocker = t.available?.({ hasActive: underWay, modelStatus: (id) => byId(w.models, id)?.status }) ?? null;
  const reason = existing ? (existing.status === 'proposed' ? 'Already proposed — approve it under “Approve a proposed project”.' : `Already under way (${existing.id}).`) : blocker ?? (t.fte > free ? `Needs ${t.fte} free engineers; ${free} are free now. Hire engineers (≈90 days) or reduce staffing on another project.` : null);
  return { running: !!existing, completed: null as string | null, available: !reason, reason, replaces: supersededProposals(w, t.key).map((p) => p.name), needsBoard: t.budgetCents > RULES.ceoSpendLimitCents };
}

export function decisionsView(db: DB) {
  const w = loadWorld(db);
  const d = w.meta.currentDate;
  const pending = (db.prepare("SELECT * FROM actions WHERE status IN ('pending_confirmation','pending_approval','approved') ORDER BY created_at DESC LIMIT 80").all() as Row[]).map(rowToAction);
  const drafts = pending.filter((a) => a.status === 'pending_confirmation').map((a) => actionView(db, a, w));
  const inProgress: InProgressItem[] = [];

  for (const bp of w.boardProposals.filter((b) => b.status === 'scheduled')) {
    const ids = proposalActionIds(bp);
    const items = ids.map((id) => pending.find((a) => a.id === id)?.summary ?? id);
    inProgress.push({
      kind: 'board_agenda',
      date: bp.meetingDate,
      title: bp.title,
      detail: ids.length ? `Board vote on ${bp.meetingDate}. If approved: ${items.join('; ')} — carried out that day.` : `Board vote on ${bp.meetingDate}. Endorsement only — changes nothing by itself.`,
      status: 'scheduled',
      actionId: bp.actionId ?? (ids.length === 1 ? ids[0] : null),
      link: { page: 'inbox', param: 'board' },
      outlook: predictVote(w, bp.analysis as Record<string, number>, bp.rationale),
    });
  }
  for (const a of pending.filter((x) => x.status === 'approved')) {
    const r = (a.result ?? {}) as { blockedBy?: string[]; validUntil?: string; approvedDate?: string };
    const def = ACTION_BY_TYPE.get(a.type);
    const now = def ? def.validate(w, a.payload, a.actorId).errors : ['Unknown action'];
    inProgress.push({ kind: 'approved_waiting', date: r.validUntil ?? null, title: a.summary, detail: now.length ? `Approved by the board${r.approvedDate ? ` on ${r.approvedDate}` : ''}, not possible yet: ${now.join(' ')} Retried automatically after each time advance; valid until ${r.validUntil ?? '—'}.` : `Approved by the board${r.approvedDate ? ` on ${r.approvedDate}` : ''} and now possible — click “Execute now”, or it runs automatically at the next time advance.`, status: 'approved', actionId: a.id, executable: now.length === 0 });
  }
  for (const dep of w.departments) {
    for (const h of dep.hiring) inProgress.push({ kind: 'hiring', date: h.arrivalDate, title: `${h.count.toLocaleString('en-GB')} new hires join ${dep.name}`, detail: `Recruiting under way; they count towards headcount and crews from ${h.arrivalDate}.`, status: 'in_progress', actionId: h.actionId ?? null, link: { page: 'company', param: null } });
    for (const l of dep.leaving) inProgress.push({ kind: 'departures', date: l.date, title: `${l.count.toLocaleString('en-GB')} leave ${dep.name}`, detail: `${l.reason}. Consultation runs until ${l.date}; severance is paid then.`, status: 'in_progress', actionId: l.actionId ?? null, link: { page: 'company', param: null } });
  }
  for (const f of w.financing.filter((x) => ['under_review', 'offered', 'accepted', 'pending_approval'].includes(x.status))) {
    inProgress.push({ kind: 'financing', date: f.status === 'offered' ? f.offer?.validUntil ?? null : f.decisionDate, title: `${f.kind.replace(/_/g, ' ')} — ${f.counterparty}`, detail: f.status === 'offered' ? `Offer received: accept it before ${f.offer?.validUntil} (Finance → Financing).` : f.status === 'under_review' ? `Under review by ${f.counterparty}; answer expected ${f.decisionDate ?? 'soon'}.` : f.status.replace(/_/g, ' '), status: f.status, link: { page: 'finance', param: f.id } });
  }
  for (const n of w.negotiations.filter((x) => x.pendingDecision)) inProgress.push({ kind: 'negotiation', date: n.pendingDecision!.date, title: n.title, detail: `Terms agreed at the table; waiting for the ${n.pendingDecision!.approver}'s decision by ${n.pendingDecision!.date}.`, status: 'pending_approval', link: { page: 'inbox', param: n.id } });
  const signing = pendingSignatures(db, w);
  // A signature already sent to the board appears once, as its board agenda item — not as "to sign".
  for (const c of w.contracts.filter((x) => x.status === 'agreed' && !signing.has(x.id))) inProgress.push({ kind: 'contract', date: null, title: `Sign: ${c.title}`, detail: 'Agreed but not signed — it has no effect until you sign it (Deals → Contracts).', status: 'agreed', link: { page: 'inbox', param: c.id } });
  for (const p of w.projects.filter((x) => x.status === 'proposed')) {
    const replacement = pending.find((a) => a.type === 'start_project' && (PROJECT_TEMPLATES.find((t) => t.key === a.payload.templateKey)?.supersedes ?? []).includes(p.templateKey ?? ''));
    inProgress.push({ kind: 'project_proposed', date: p.targetDate, title: `Awaiting your approval: ${p.name}`, detail: replacement ? `Proposed project (${p.staffingFte} engineers). It will be withdrawn if “${replacement.summary}” is carried out, which covers the same work.` : `Proposed project (${p.staffingFte} engineers). Nothing happens until you approve it (Projects).`, status: 'proposed', link: { page: 'projects', param: p.id } });
  }
  if (w.meta.extraordinaryMeeting) inProgress.push({ kind: 'meeting', date: w.meta.extraordinaryMeeting, title: 'Extraordinary board meeting', detail: 'Proposals submitted at least 7 days before are voted then.', status: 'scheduled', link: { page: 'inbox', param: 'board' } });
  inProgress.sort((a, b) => (a.date ?? '9999') < (b.date ?? '9999') ? -1 : 1);

  const recent = (db.prepare("SELECT * FROM actions WHERE status IN ('committed','rejected','expired','cancelled','failed') AND type NOT IN ('advance_time','approve_budget','negotiate_contract') ORDER BY updated_at DESC LIMIT 30").all() as Row[]).map(rowToAction).map((a) => actionView(db, a, w));

  const free = Math.max(0, Math.floor(engineeringFreeFte(w)));
  return {
    today: d,
    nextBoardMeeting: upcomingMeeting(w),
    submissionMeeting: meetingForSubmission(w),
    limits: { ceoSpendCents: RULES.ceoSpendLimitCents, ceoFinancingCents: RULES.ceoFinancingLimitCents, hiring: RULES.ceoHiringLimit, restructuring: RULES.boardRestructuringHeadcount },
    freeEngineers: free,
    rcf: { availableCents: rcfAvailable(w), drawnCents: rcf(w)?.principalCents ?? 0 },
    departments: w.departments.map((dep) => ({ id: dep.id, name: dep.name, kind: dep.kind, headcount: dep.headcount, morale: dep.morale, need: staffingNeed(w, dep.id), leadDays: PARAMS.hiringLeadDays[dep.kind] ?? 60, hiring: dep.hiring.reduce((x, h) => x + h.count, 0), leaving: dep.leaving.reduce((x, l) => x + l.count, 0) })),
    models: w.models.map((m) => ({ id: m.id, name: m.name, status: m.status, netPriceCents: m.netPriceCents })),
    lines: w.lines.map((l) => ({ id: l.id, name: l.name, factoryId: l.factoryId, status: l.status, plannedDailyRate: l.plannedDailyRate, maxDailyRate: l.maxDailyRate })),
    factories: w.factories.map((f) => ({ id: f.id, name: f.name })),
    marketingMonthlyCents: w.meta.marketingMonthlyCents,
    campaigns: (w.meta.campaigns ?? []).slice(-12).reverse().map((c) => ({ ...c, modelName: byId(w.models, c.modelId)?.name ?? c.modelId, running: c.end >= d })),
    customKinds: CUSTOM_KINDS.map((k) => ({ key: k.key, label: k.label, description: k.description, target: k.target, owner: byId(w.characters, k.ownerId)?.name ?? k.ownerId, sizes: Object.fromEntries((Object.keys(SIZES) as CustomSize[]).map((sz) => [sz, { label: SIZES[sz].label, budgetCents: Math.round((SIZES[sz].budget * k.costFactor) / 1e6) * 1e6, fte: SIZES[sz].fte, months: Math.round(SIZES[sz].days / 30) }])) })),
    templates: PROJECT_TEMPLATES.map((t) => ({ key: t.key, name: t.name, strategy: t.strategy, objective: t.objective, effects: t.effects.map((e) => describeEffect(w, e)), tradeoffs: t.tradeoffs, budgetCents: t.budgetCents, fte: t.fte, months: Math.round(t.durationDays / 30), ...templateStatus(w, t.key) })),
    projects: w.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, kind: p.kind, targetDate: p.targetDate, completedDate: p.completedDate, impact: p.impact ?? [], staffingFte: Math.round(p.staffingFte), budgetCents: p.budgetCents, spentCents: p.spentCents })),
    issues: w.issues.filter((i) => !['resolved', 'closed'].includes(i.status)).map((i) => ({ id: i.id, title: i.title, severity: i.severity, options: i.options.filter((o) => !i.chosenOptions.includes(o.key)).map((o) => ({ key: o.key, label: o.label, costCents: o.costCents, description: o.description })) })),
    financing: w.financing.filter((f) => !['withdrawn', 'expired'].includes(f.status)).map((f) => ({ id: f.id, kind: f.kind, counterparty: f.counterparty, status: f.status, requestedCents: f.requestedCents, offer: f.offer })),
    negotiations: w.negotiations.map((n) => ({ id: n.id, title: n.title, status: n.status, counterpartyName: byId(w.characters, n.counterpartyId)?.name ?? n.counterpartyId, deadline: n.deadline })),
    negotiationTemplates: Object.values(NEGOTIATION_TEMPLATES).map((t) => ({ key: t.key, title: t.title, description: t.description ?? '', category: t.category ?? 'supply', counterpartyName: byId(w.characters, t.counterpartyId)?.name ?? t.counterpartyId, counterpartyOrg: byId(w.characters, t.counterpartyId)?.orgName ?? '', open: w.negotiations.some((n) => n.templateKey === t.key && n.status === 'open'), unavailable: t.available?.(w) ?? null, terms: t.terms.map((x) => x.label) })),
    contractsToSign: w.contracts.filter((c) => c.status === 'agreed').map((c) => ({ id: c.id, title: c.title, counterpartyName: c.counterpartyName, pendingNote: signing.get(c.id) ?? null })),
    characters: w.characters.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, title: c.title, org: c.org })),
    actionTypes: [...ACTION_BY_TYPE.values()].map((a) => ({ type: a.type, label: a.label, description: a.description })),
    drafts,
    inProgress,
    recent,
    horizon: addDays(d, 120),
  };
}
