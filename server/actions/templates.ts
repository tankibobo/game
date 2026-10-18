/**
 * Catalogue of projects the CEO can start. Each template has a fixed budget,
 * staffing, milestone plan and completion effects, so strategies (premium,
 * mass-market EV, hybrid transition, cost-down …) have concrete costs, lead
 * times and consequences.
 */
import type { Milestone, Project, ProjectEffect } from '../../shared/domain';
import { addDays, type SimDate } from '../../shared/dates';
import { eur, mEur, type Cents } from '../../shared/money';

export interface ProjectTemplate {
  key: string;
  name: string;
  kind: Project['kind'];
  strategy: string;
  objective: string;
  scope: string;
  sponsorId: string;
  managerId: string;
  departmentId: string;
  fte: number;
  budgetCents: Cents;
  capitalize: boolean;
  priority: Project['priority'];
  linkedModelId: string | null;
  durationDays: number;
  milestones: { name: string; description: string; work: number; externalCents: Cents }[];
  effects: ProjectEffect[];
  risks: Project['risks'];
  acceptanceCriteria: string[];
  /** Returns a reason when the template cannot be started now. */
  available?: (ctx: { hasActive: (key: string) => boolean; modelStatus: (id: string) => string | undefined }) => string | null;
  tradeoffs: string;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    key: 'vela_hybrid_refresh',
    name: 'Vela mild-hybrid refresh (incl. Euro 7)',
    kind: 'vehicle_program',
    strategy: 'Hybrid transition',
    objective: 'Turn the Vela into a 48V mild hybrid, certified to Euro 7, with a facelift.',
    scope: '48V belt starter-generator, Euro 7 after-treatment, new front end and infotainment.',
    sponsorId: 'CHR-WIERZBICKI',
    managerId: 'CHR-MARCHETTI',
    departmentId: 'DEP-LTC',
    fte: 220,
    budgetCents: mEur(165),
    capitalize: true,
    priority: 'high',
    linkedModelId: 'MDL-VELA',
    durationDays: 330,
    milestones: [
      { name: 'Hybrid system integration', description: '48V system and calibration.', work: 26_000, externalCents: mEur(60) },
      { name: 'Facelift tooling', description: 'New front end and interior tooling.', work: 16_000, externalCents: mEur(55) },
      { name: 'Euro 7 homologation', description: 'Certification of all variants.', work: 10_000, externalCents: mEur(15) },
      { name: 'Production start (Lyon)', description: 'Running change at Lyon.', work: 6_000, externalCents: mEur(10) },
    ],
    effects: [
      { type: 'model_euro7', modelId: 'MDL-VELA' },
      { type: 'model_co2', modelId: 'MDL-VELA', gkm: 109 },
      { type: 'model_appeal', modelId: 'MDL-VELA', delta: 7 },
      { type: 'model_cost', modelId: 'MDL-VELA', deltaCents: eur(780) },
    ],
    risks: [{ text: 'Takes ~11 months; may not certify before the Euro 7 cut-off (29 Nov 2027) if started late', likelihood: 'medium', impact: 'high' }],
    acceptanceCriteria: ['Euro 7 type approval', 'CO₂ ≤ 110 g/km', 'Clinic appeal +5'],
    available: ({ hasActive }) => (hasActive('vela_euro7') ? 'The plain Euro 7 compliance project is already running.' : null),
    tradeoffs: 'More expensive than plain Euro 7 compliance, but lowers CO₂ and revives demand for 2–3 more years.',
  },
  {
    key: 'kora_premium',
    name: 'Kora GT premium line',
    kind: 'vehicle_program',
    strategy: 'Premium positioning',
    objective: 'Add a premium Kora GT trim with higher-grade interior, adaptive chassis and 4×4 hybrid.',
    scope: 'Trim, interior, chassis and a rear e-axle option.',
    sponsorId: 'CHR-GARNIER',
    managerId: 'CHR-WIERZBICKI',
    departmentId: 'DEP-LTC',
    fte: 140,
    budgetCents: mEur(85),
    capitalize: true,
    priority: 'medium',
    linkedModelId: 'MDL-KORA',
    durationDays: 300,
    milestones: [
      { name: 'Design & engineering', description: 'GT trim and e-axle integration.', work: 18_000, externalCents: mEur(35) },
      { name: 'Supplier tooling', description: 'Interior and chassis tooling.', work: 10_000, externalCents: mEur(30) },
      { name: 'Launch', description: 'Running change in Sevilla.', work: 5_000, externalCents: mEur(10) },
    ],
    effects: [
      { type: 'segment_ref_price_pct', segmentId: 'SEG-CSUV', modelId: 'MDL-KORA', pct: 0.06 },
      { type: 'model_cost', modelId: 'MDL-KORA', deltaCents: eur(650) },
      { type: 'model_quality', modelId: 'MDL-KORA', delta: 2 },
    ],
    risks: [{ text: 'Premium buyers may not accept the Asterion badge', likelihood: 'medium', impact: 'medium' }],
    acceptanceCriteria: ['Clinic appeal supports +6% net price'],
    tradeoffs: 'Raises appeal enough to support ~6% higher prices; adds €650 unit cost. Pays off only if prices are actually raised.',
  },
  {
    key: 'lyon_cost_down',
    name: 'Lyon automation & cost-down programme',
    kind: 'industrial',
    strategy: 'Operational restructuring',
    objective: 'Automate body-in-white and logistics at Lyon; cut fixed cost and crew requirement.',
    scope: 'Robotics, AGVs, energy retrofit, line balancing.',
    sponsorId: 'CHR-MARCHETTI',
    managerId: 'CHR-MARCHETTI',
    departmentId: 'DEP-LTC',
    fte: 90,
    budgetCents: mEur(120),
    capitalize: true,
    priority: 'medium',
    linkedModelId: null,
    durationDays: 360,
    milestones: [
      { name: 'Engineering & orders', description: 'Specifications and equipment orders.', work: 8_000, externalCents: mEur(30) },
      { name: 'Installation (summer shutdown)', description: 'Install robotics during the shutdown.', work: 10_000, externalCents: mEur(75) },
      { name: 'Ramp & savings validation', description: 'Validate cycle times and savings.', work: 4_000, externalCents: mEur(15) },
    ],
    effects: [
      { type: 'factory_overhead_pct', factoryId: 'FAC-LYON', pct: -0.15 },
      { type: 'factory_crew_pct', factoryId: 'FAC-LYON', pct: -0.12 },
      { type: 'model_cost', modelId: 'MDL-VELA', deltaCents: -eur(260) },
    ],
    risks: [{ text: 'Union opposition to automation-related job losses', likelihood: 'high', impact: 'medium' }],
    acceptanceCriteria: ['Crew per vehicle −12%', 'Overhead −15%'],
    tradeoffs: 'Saves ~€8m/year overhead and ~700 jobs’ worth of crew requirement — which only turns into savings if headcount is actually reduced.',
  },
  {
    key: 'second_battery_source',
    name: 'Second battery source qualification (engineering)',
    kind: 'supplier',
    strategy: 'EV leadership / supply resilience',
    objective: 'Engineer and validate an alternative Eon pack (Hanseatic) to reduce dependence on Voltaris.',
    scope: 'Pack interface adaptation, BMS integration, validation. The commercial supply contract is negotiated separately with Hanseatic.',
    sponsorId: 'CHR-LINDQVIST',
    managerId: 'CHR-WIERZBICKI',
    departmentId: 'DEP-BEC',
    fte: 80,
    budgetCents: mEur(28),
    capitalize: true,
    priority: 'high',
    linkedModelId: 'MDL-EON',
    durationDays: 240,
    milestones: [
      { name: 'Interface adaptation', description: 'Mechanical/electrical integration.', work: 7_000, externalCents: mEur(10) },
      { name: 'Validation', description: 'Abuse and durability tests of the alternative pack.', work: 9_000, externalCents: mEur(18) },
    ],
    effects: [],
    risks: [{ text: 'Engineering capacity diverted from the main Eon programme', likelihood: 'medium', impact: 'medium' }],
    acceptanceCriteria: ['Alternative pack validated'],
    tradeoffs: 'Gives leverage in the Voltaris talks and resilience; needs ~80 engineers the Eon programme also wants.',
  },
  {
    key: 'brno_eon_expansion',
    name: 'Brno Eon line capacity +100/day',
    kind: 'industrial',
    strategy: 'EV leadership',
    objective: 'Add a third shift module and battery-hall capacity to lift the Eon line from 300 to 400/day.',
    scope: 'Battery hall extension, additional stations, logistics.',
    sponsorId: 'CHR-MARCHETTI',
    managerId: 'CHR-MARCHETTI',
    departmentId: 'DEP-LTC',
    fte: 60,
    budgetCents: mEur(110),
    capitalize: true,
    priority: 'medium',
    linkedModelId: 'MDL-EON',
    durationDays: 300,
    milestones: [
      { name: 'Engineering & permits', description: 'Plant engineering and permits.', work: 5_000, externalCents: mEur(20) },
      { name: 'Construction & installation', description: 'Hall extension and stations.', work: 9_000, externalCents: mEur(80) },
      { name: 'Commissioning', description: 'Rate demonstration.', work: 3_000, externalCents: mEur(10) },
    ],
    effects: [{ type: 'line_capacity', lineId: 'LINE-BRNO-EON', delta: 100 }],
    risks: [{ text: 'Battery supply must grow in step', likelihood: 'high', impact: 'medium' }],
    acceptanceCriteria: ['Line rate 400/day demonstrated'],
    tradeoffs: 'Only valuable if Eon demand and battery supply both exceed 300/day.',
  },
  {
    key: 'quality_programme',
    name: 'Group quality & warranty programme',
    kind: 'quality',
    strategy: 'Profitability over volume',
    objective: 'Raise built-in quality and cut warranty cost across all models.',
    scope: 'Supplier quality audits, end-of-line testing, field-data analytics.',
    sponsorId: 'CHR-MARCHETTI',
    managerId: 'CHR-MARCHETTI',
    departmentId: 'DEP-LTC',
    fte: 70,
    budgetCents: mEur(32),
    capitalize: false,
    priority: 'medium',
    linkedModelId: null,
    durationDays: 210,
    milestones: [
      { name: 'Diagnostics & audits', description: 'Top-20 defect analysis.', work: 6_000, externalCents: mEur(12) },
      { name: 'Countermeasures', description: 'Process and supplier fixes.', work: 7_000, externalCents: mEur(20) },
    ],
    effects: [
      { type: 'model_quality', modelId: '*', delta: 4 },
      { type: 'warranty_pct', pct: -0.12 },
    ],
    risks: [],
    acceptanceCriteria: ['Quality +4 on all models', 'Warranty cost −12%'],
    tradeoffs: 'Cheap and low-risk; benefits accrue slowly.',
  },
  {
    key: 'direct_sales',
    name: 'Direct online sales channel',
    kind: 'commercial',
    strategy: 'Mass-market reach',
    objective: 'Online configurator and direct ordering with dealer delivery (agency model pilot).',
    scope: 'E-commerce platform, logistics integration, dealer agency contracts.',
    sponsorId: 'CHR-GARNIER',
    managerId: 'CHR-GARNIER',
    departmentId: 'DEP-LTC',
    fte: 40,
    budgetCents: mEur(40),
    capitalize: false,
    priority: 'low',
    linkedModelId: null,
    durationDays: 240,
    milestones: [
      { name: 'Platform build', description: 'Configurator and order management.', work: 5_000, externalCents: mEur(25) },
      { name: 'Pilot markets', description: 'France and Spain launch.', work: 3_000, externalCents: mEur(15) },
    ],
    effects: [{ type: 'distribution', delta: 0.08 }],
    risks: [{ text: 'Dealer council resistance', likelihood: 'high', impact: 'medium' }],
    acceptanceCriteria: ['Online share ≥ 8% of orders in pilot markets'],
    tradeoffs: 'Improves reach (demand) but antagonises dealers.',
  },
  {
    key: 'compact_ev',
    name: 'Compact EV (Vela successor “Nova”)',
    kind: 'vehicle_program',
    strategy: 'Mass-market electrification',
    objective: 'Develop a €25k compact BEV on a cost-optimised E-Flex derivative for Lyon.',
    scope: 'Full vehicle programme incl. LFP pack sourcing and Lyon retooling.',
    sponsorId: 'CHR-WIERZBICKI',
    managerId: 'CHR-FERRER',
    departmentId: 'DEP-LTC',
    fte: 600,
    budgetCents: mEur(1_250),
    capitalize: true,
    priority: 'high',
    linkedModelId: null,
    durationDays: 1_150,
    milestones: [
      { name: 'Concept & platform decisions', description: 'Architecture and sourcing.', work: 80_000, externalCents: mEur(120) },
      { name: 'Design freeze', description: 'Exterior/interior freeze.', work: 120_000, externalCents: mEur(180) },
      { name: 'Prototypes & validation', description: 'VP build and validation.', work: 180_000, externalCents: mEur(350) },
      { name: 'Lyon retooling', description: 'Line conversion.', work: 90_000, externalCents: mEur(450) },
      { name: 'SOP', description: 'Start of production.', work: 40_000, externalCents: mEur(150) },
    ],
    effects: [],
    risks: [{ text: 'Long, cash-intensive; competes for engineers with the Eon', likelihood: 'high', impact: 'high' }],
    acceptanceCriteria: ['Unit cost ≤ €21,000', 'SOP within 40 months'],
    tradeoffs: 'The long-term answer for Lyon, but consumes €1.25bn and 600 engineers over 3+ years — requires financing.',
  },
];

export function templateByKey(key: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((t) => t.key === key);
}

export function buildProject(t: ProjectTemplate, id: string, start: SimDate, milestoneIds: string[]): { project: Project; milestones: Milestone[] } {
  const target = addDays(start, t.durationDays);
  const totalWork = t.milestones.reduce((a, m) => a + m.work, 0);
  let cum = 0;
  const milestones: Milestone[] = t.milestones.map((m, i) => {
    cum += m.work;
    const planned = addDays(start, Math.round((t.durationDays * cum) / totalWork));
    return { id: milestoneIds[i], projectId: id, seq: i + 1, name: m.name, description: m.description, workTotal: m.work, workDone: 0, status: i === 0 ? 'in_progress' : 'pending', plannedDate: planned, originalPlannedDate: planned, completedDate: null, gates: [], externalCostCents: m.externalCents, lateFlagged: 0 };
  });
  const project: Project = {
    id,
    code: t.key.toUpperCase().slice(0, 8),
    name: t.name,
    kind: t.kind,
    objective: t.objective,
    scope: t.scope,
    sponsorId: t.sponsorId,
    managerId: t.managerId,
    departmentId: t.departmentId,
    status: 'active',
    priority: t.priority,
    startDate: start,
    originalTargetDate: target,
    targetDate: target,
    forecastDate: null,
    forecastP80Date: null,
    budgetCents: t.budgetCents,
    originalBudgetCents: t.budgetCents,
    spentCents: 0,
    externalSpentCents: 0,
    internalCostCents: 0,
    committedCents: 0,
    staffingFte: t.fte,
    baseFte: t.fte,
    productivity: 1,
    capitalizeExternal: t.capitalize ? 1 : 0,
    externalAccrualCents: 0,
    acceptanceCriteria: t.acceptanceCriteria,
    dependencies: [],
    linkedModelId: t.linkedModelId,
    templateKey: t.key,
    completionEffects: t.effects,
    risks: t.risks,
    lastDecision: `Started ${start}.`,
    completedDate: null,
    description: t.tradeoffs,
  };
  return { project, milestones };
}
