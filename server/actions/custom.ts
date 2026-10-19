/**
 * Projects the CEO designs: pick what to improve, where, and how big. The
 * engine sizes budget, engineers and duration, and sets the expected effect
 * (with diminishing returns for repeating the same improvement). The actual
 * result is drawn on completion: 60–120% of what was expected.
 */
import type { ProjectEffect, Project } from '../../shared/domain';
import { mEur, eur } from '../../shared/money';
import { byId, type World } from '../engine/world';
import type { ProjectTemplate } from './templates';

export type CustomSize = 'small' | 'medium' | 'large';

export const SIZES: Record<CustomSize, { label: string; budget: number; fte: number; days: number; k: number }> = {
  small: { label: 'Small', budget: mEur(12), fte: 25, days: 150, k: 1 },
  medium: { label: 'Medium', budget: mEur(35), fte: 60, days: 240, k: 2.2 },
  large: { label: 'Large', budget: mEur(90), fte: 120, days: 360, k: 4 },
};

export interface CustomKind {
  key: string;
  label: string;
  description: string;
  target: 'factory' | 'line' | 'model' | 'model_or_all' | 'none';
  kind: Project['kind'];
  ownerId: string;
  /** Cost multiplier relative to the size table. */
  costFactor: number;
  effects: (k: number, targetId: string | null, w: World) => ProjectEffect[];
  /** Why it cannot be done for this target (or null). */
  check?: (w: World, targetId: string | null) => string | null;
}

export const CUSTOM_KINDS: CustomKind[] = [
  {
    key: 'plant_efficiency',
    label: 'Plant efficiency (lean & automation)',
    description: 'Line balancing, automation and lean methods at one plant: lower overhead and fewer people needed per car.',
    target: 'factory',
    kind: 'industrial',
    ownerId: 'CHR-MARCHETTI',
    costFactor: 1,
    effects: (k, id) => [
      { type: 'factory_overhead_pct', factoryId: id!, pct: -0.03 * k },
      { type: 'factory_crew_pct', factoryId: id!, pct: -0.025 * k },
    ],
  },
  {
    key: 'line_capacity',
    label: 'Line capacity',
    description: 'Debottleneck one line to build more cars a day.',
    target: 'line',
    kind: 'industrial',
    ownerId: 'CHR-MARCHETTI',
    costFactor: 1.1,
    effects: (k, id) => [{ type: 'line_capacity', lineId: id!, delta: Math.round((15 * k) / 5) * 5 }],
  },
  {
    key: 'model_refresh',
    label: 'Model update',
    description: 'Design, interior and equipment update for one model: more appeal and a little quality, at some extra cost per car.',
    target: 'model',
    kind: 'vehicle_program',
    ownerId: 'CHR-WIERZBICKI',
    costFactor: 1.2,
    effects: (k, id, w) => [
      { type: 'model_appeal', modelId: id!, delta: Math.round(1.5 * k * 10) / 10 },
      { type: 'model_quality', modelId: id!, delta: Math.round(0.5 * k * 10) / 10 },
      { type: 'model_cost', modelId: id!, deltaCents: eur(Math.round(100 * k)) },
      { type: 'model_feature', modelId: id!, feature: `Model-year update ${Number(w.meta.currentDate.slice(0, 4)) + 1}` },
    ],
    check: (w, id) => (byId(w.models, id)?.status !== 'in_production' ? 'Only models on sale can be updated.' : null),
  },
  {
    key: 'design_to_cost',
    label: 'Design-to-cost',
    description: 'Value engineering and re-sourcing on one model: lower material cost per car.',
    target: 'model',
    kind: 'cost',
    ownerId: 'CHR-LINDQVIST',
    costFactor: 0.8,
    effects: (k, id) => [{ type: 'material_pct', modelId: id!, pct: -0.008 * k }],
  },
  {
    key: 'quality',
    label: 'Quality offensive',
    description: 'Supplier audits, testing and fixes: better build quality (demand) — and lower warranty cost if run for all models.',
    target: 'model_or_all',
    kind: 'quality',
    ownerId: 'CHR-MARCHETTI',
    costFactor: 0.8,
    effects: (k, id) => (id ? [{ type: 'model_quality', modelId: id, delta: Math.round(1.2 * k * 10) / 10 }] : [{ type: 'model_quality', modelId: '*', delta: Math.round(0.8 * k * 10) / 10 }, { type: 'warranty_pct', pct: -0.03 * k }]),
  },
  {
    key: 'co2_reduction',
    label: 'CO₂ reduction',
    description: 'Aerodynamics, low-rolling-resistance tyres, engine calibration on one petrol or hybrid model.',
    target: 'model',
    kind: 'vehicle_program',
    ownerId: 'CHR-WIERZBICKI',
    costFactor: 0.9,
    effects: (k, id, w) => {
      const m = byId(w.models, id);
      return [{ type: 'model_co2', modelId: id!, gkm: Math.max(0, Math.round(((m?.co2Gkm ?? 0) - 2 * k) * 10) / 10) }, { type: 'model_cost', modelId: id!, deltaCents: eur(Math.round(60 * k)) }];
    },
    check: (w, id) => ((byId(w.models, id)?.co2Gkm ?? 0) <= 0 ? 'This model emits no CO₂ already.' : null),
  },
  {
    key: 'digital_marketing',
    label: 'Digital marketing',
    description: 'Data, targeting and online lead generation: every marketing euro works harder.',
    target: 'none',
    kind: 'commercial',
    ownerId: 'CHR-GARNIER',
    costFactor: 0.6,
    effects: (k) => [{ type: 'marketing_efficiency', pct: Math.round(0.06 * k * 100) / 100 }],
  },
  {
    key: 'dealer_network',
    label: 'Dealer network support',
    description: 'Co-fund dealer upgrades and training: wider reach and better dealer relations.',
    target: 'none',
    kind: 'commercial',
    ownerId: 'CHR-GARNIER',
    costFactor: 0.8,
    effects: (k) => [{ type: 'distribution', delta: Math.round(0.008 * k * 1000) / 1000 }, { type: 'trust', characterId: 'CHR-BELLINI', delta: Math.round(k) }],
  },
  {
    key: 'people',
    label: 'People & workplace',
    description: 'Training, ergonomics and working conditions at one plant: morale up, absenteeism down.',
    target: 'factory',
    kind: 'restructuring',
    ownerId: 'CHR-OKAFOR',
    costFactor: 0.5,
    effects: (k, id, w) => [
      { type: 'morale', departmentId: byId(w.factories, id)?.departmentId ?? '*', delta: Math.round(2 * k) },
      { type: 'absenteeism', factoryId: id!, delta: -Math.round(0.3 * k * 10) / 10 },
    ],
  },
];

export const CUSTOM_KIND_BY_KEY = new Map(CUSTOM_KINDS.map((k) => [k.key, k]));

export interface CustomSpecInput {
  name: string;
  kind: string;
  targetId: string | null;
  size: CustomSize;
}

/** Earlier completed projects of the same kind on the same target reduce what a new one can achieve. */
export function repeatFactor(w: World, kind: string, targetId: string | null): number {
  const n = w.projects.filter((p) => p.custom && p.custom.kind === kind && p.custom.targetId === targetId && p.status !== 'cancelled').length;
  return Math.pow(0.7, n);
}

export function validateCustom(w: World, s: CustomSpecInput): string[] {
  const k = CUSTOM_KIND_BY_KEY.get(s.kind);
  if (!k) return [`Unknown kind of project "${s.kind}".`];
  const errs: string[] = [];
  if (k.target === 'factory' && !byId(w.factories, s.targetId)) errs.push('Choose a plant.');
  if (k.target === 'line' && !byId(w.lines, s.targetId)) errs.push('Choose a production line.');
  if ((k.target === 'model' || (k.target === 'model_or_all' && s.targetId)) && !byId(w.models, s.targetId)) errs.push('Choose a model.');
  if (k.target === 'none' && s.targetId) errs.push('This kind of project has no target.');
  const why = k.check?.(w, s.targetId);
  if (why) errs.push(why);
  if (w.projects.some((p) => p.custom && p.custom.kind === s.kind && p.custom.targetId === s.targetId && !['completed', 'cancelled'].includes(p.status))) errs.push('A project of this kind on the same target is already under way.');
  return errs;
}

/** Build a template-like definition for a project the CEO designed. */
export function customTemplate(w: World, s: CustomSpecInput): ProjectTemplate {
  const k = CUSTOM_KIND_BY_KEY.get(s.kind)!;
  const size = SIZES[s.size];
  const factor = repeatFactor(w, s.kind, s.targetId);
  const budget = Math.round((size.budget * k.costFactor) / 1e6) * 1e6;
  const work = Math.round(size.fte * size.days * 0.69);
  const ext = (x: number) => Math.round((budget * x) / 1e6) * 1e6;
  const target = s.targetId ? byId(w.factories, s.targetId)?.name ?? byId(w.lines, s.targetId)?.name ?? byId(w.models, s.targetId)?.name ?? s.targetId : 'company-wide';
  return {
    key: `custom_${s.kind}`,
    name: s.name.trim() || `${k.label} — ${target}`,
    kind: k.kind,
    strategy: 'Your own project',
    objective: `${k.description} (${target}, ${size.label.toLowerCase()}).`,
    scope: `${k.label} — ${target}.`,
    sponsorId: k.ownerId,
    managerId: k.ownerId,
    departmentId: 'DEP-LTC',
    fte: size.fte,
    budgetCents: budget,
    capitalize: k.kind === 'industrial' || k.kind === 'vehicle_program',
    priority: 'medium',
    linkedModelId: k.target === 'model' ? s.targetId : null,
    durationDays: size.days,
    milestones: [
      { name: 'Concept & business case', description: 'Analysis, targets and plan.', work: Math.round(work * 0.2), externalCents: ext(0.1) },
      { name: 'Execution', description: 'Engineering, purchasing and implementation.', work: Math.round(work * 0.6), externalCents: ext(0.75) },
      { name: 'Validation & hand-over', description: 'Results validated and handed to operations.', work: Math.round(work * 0.2), externalCents: ext(0.15) },
    ],
    effects: k.effects(size.k * factor, s.targetId, w),
    risks: [{ text: 'The result is uncertain: projects like this deliver 60–120% of the expected effect.', likelihood: 'medium', impact: 'low' }, ...(factor < 0.99 ? [{ text: `Diminishing returns: similar projects already ran here, so expect ${Math.round(factor * 100)}% of a first-time effect.`, likelihood: 'high' as const, impact: 'low' as const }] : [])],
    acceptanceCriteria: ['Effect validated by the controller'],
    tradeoffs: `${size.label} project: ${Math.round(size.days / 30)} months, ${size.fte} engineers.`,
    repeatable: true,
  };
}
