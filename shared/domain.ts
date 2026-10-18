/**
 * Authoritative domain model. Every interface here maps 1:1 to a SQLite table
 * (camelCase field <-> snake_case column). Fields typed as objects/arrays are
 * stored as JSON columns. Money is always integer cents.
 */
import type { Cents } from './money';
import type { SimDate } from './dates';

export type Id = string;

export interface EntityRef {
  type: EntityType;
  id: Id;
}

export type EntityType =
  | 'company'
  | 'model'
  | 'segment'
  | 'competitor'
  | 'competitor_product'
  | 'factory'
  | 'line'
  | 'supplier'
  | 'supply'
  | 'department'
  | 'character'
  | 'project'
  | 'milestone'
  | 'issue'
  | 'commitment'
  | 'debt'
  | 'covenant'
  | 'contract'
  | 'negotiation'
  | 'financing'
  | 'board_proposal'
  | 'regulation'
  | 'action'
  | 'conversation';

// ---------------------------------------------------------------- meta / macro

export type GameStatus = 'active' | 'insolvent' | 'dismissed';

export interface BoardPlan {
  /** Eon start of production communicated to the board. */
  eonSopDate: SimDate;
  /** FY operating profit (EBIT) target in the approved budget. */
  ebitTargetCents: Cents;
  /** Minimum liquidity (cash + undrawn RCF) the board expects. */
  minLiquidityCents: Cents;
  fiscalYear: number;
}

export interface GameMeta {
  id: string; // always 'game'
  companyName: string;
  ceoName: string;
  currentDate: SimDate;
  startDate: SimDate;
  seed: number;
  seq: number; // deterministic id counter
  status: GameStatus;
  terminalReason: string | null;
  boardConfidence: number; // 0..100
  lowConfidenceMeetings: number;
  ceoPersonalLiquidCents: Cents;
  ceoPersonalNetWorthCents: Cents;
  sharesOutstanding: number;
  sharePriceCents: Cents;
  creditRating: string;
  ratingOutlook: 'stable' | 'negative' | 'positive' | 'watch_negative';
  marketingMonthlyCents: Cents;
  gaMonthlyCents: Cents;
  sustainingCapexMonthlyCents: Cents;
  taxLossCarryforwardCents: Cents;
  taxAccruedYtdCents: Cents;
  co2ProvisionYtdCents: Cents;
  co2UnitsYtd: number;
  co2GramsYtd: number; // sum of g/km over units
  aftersalesParc: number;
  wageIndex: number; // multiplier on base personnel cost
  /** Movement per GL account in the current month / year (rebuilt from the ledger on load). */
  mtdByAccount: Record<string, Cents>;
  ytdByAccount: Record<string, Cents>;
  /** Cash movements by cash-flow category in the current month. */
  cfMtd: Record<string, Cents>;
  boardPlan: BoardPlan;
  nextBoardMeeting: SimDate;
  extraordinaryMeeting: SimDate | null;
  lastForecastSummary: ForecastSummary | null;
  liquidityStressDays: number;
  missedPaymentDays: number;
  /** Monthly depreciation of the legacy (pre-2027) asset base. */
  legacyDepMonthlyCents: Cents;
  /** Gross PP&E added since game start (depreciated straight-line). */
  newPpeGrossCents: Cents;
  /** Capitalised development cost being amortised (programmes past SOP). */
  amortizingDevCents: Cents;
  forecastStale: number;
  /** Utility penalty/bonus of Asterion's distribution network vs incumbents. */
  distributionUtility: number;
  /** Operating lease cost from sale-and-leaseback transactions (per month). */
  leaseMonthlyCents: Cents;
  /** One-off assets already disposed of (e.g. 'HQ_CAMPUS'). */
  assetsSold: string[];
  version: number;
}

export interface MacroShock {
  key: string;
  label: string;
  start: SimDate;
  until: SimDate;
  demandEffect: number; // multiplicative delta, e.g. -0.06
  energyEffect: number;
  chipEffect: number;
}

export interface MacroState {
  id: string; // 'macro'
  gdpGrowthPct: number;
  consumerConfidence: number; // index, 100 = neutral
  ecbRatePct: number;
  energyIndex: number; // 1.0 = baseline
  batteryCostIndex: number; // 1.0 = baseline
  creditSpreadBps: number; // market spread for BB issuers
  shocks: MacroShock[];
}

export interface ForecastSummary {
  createdDate: SimDate;
  fyEbitCents: Cents;
  fyRevenueCents: Cents;
  minLiquidityCents: Cents;
  minLiquidityDate: SimDate;
  /** Minimum liquidity within the next 12 months (what the board judges). */
  minLiquidity12mCents: Cents;
  minLiquidity12mDate: SimDate;
  eonSopForecast: SimDate | null;
  /** SOP forecast assuming battery supply is secured (when the unconditional forecast is blocked). */
  eonSopConditional: SimDate | null;
  co2PenaltyFyCents: Cents;
  maxLeverage: number;
}

// ---------------------------------------------------------------- market

export type Powertrain = 'ice' | 'hev' | 'phev' | 'bev';

export interface PowertrainPref {
  ice: number;
  hev: number;
  phev: number;
  bev: number;
}

export interface Segment {
  id: Id;
  name: string;
  baseMonthlyUnits: number; // European market, units per month at index 1.0
  refPriceCents: Cents; // reference net price for the segment
  priceElasticity: number;
  seasonality: number[]; // 12 multipliers
  growthPerYear: number;
  powertrainPref: PowertrainPref; // preference weights at startDate
  prefDriftPerYear: PowertrainPref; // additive drift per year
  otherUtility: number; // calibrated utility of the long tail of other brands
  description: string;
}

export type ModelStatus = 'development' | 'in_production' | 'discontinued';
export type Lifecycle = 'development' | 'launch' | 'growth' | 'mature' | 'decline' | 'run_out';

export interface VehicleModel {
  id: Id;
  name: string;
  segmentId: Id;
  powertrain: Powertrain;
  status: ModelStatus;
  lifecycle: Lifecycle;
  launchDate: SimDate | null;
  netPriceCents: Cents; // revenue per unit invoiced to dealers
  listPriceCents: Cents; // public list price incl. VAT (display only)
  baseAppeal: number; // 0..100 at launch
  appealDecayPerYear: number;
  quality: number; // 0..100
  satisfaction: number; // 0..100
  co2Gkm: number;
  otherMaterialCostCents: Cents; // non-critical bill of materials
  logisticsPerUnitCents: Cents;
  warrantyPerUnitCents: Cents;
  fgUnits: number; // company finished-goods stock
  fgValueCents: Cents;
  dealerStock: number;
  backlog: number; // open customer orders not yet served by dealers
  inTransit: number;
  retailMtd: number;
  wholesaleMtd: number;
  productionMtd: number;
  retailLastMonth: number;
  wholesaleLastMonth: number;
  productionLastMonth: number;
  lostSalesMtd: number;
  cumulativeRetail: number;
  fgUnitDaysMtd: number; // finished-goods unit-days this month (carrying cost base)
  euro7Compliant: number; // 1 = may be registered after Euro 7 applies to all new cars
  demandModifier: number; // temporary multiplier from events (1.0 = none)
  demandModifierUntil: SimDate | null;
  projectId: Id | null;
  description: string;
}

export interface Competitor {
  id: Id;
  name: string;
  origin: string;
  strategy: string;
  financialHealth: number; // 0..100
  evCapability: number;
  aggressiveness: number; // 0..1 likelihood of responding to price moves
  description: string;
}

export interface CompetitorProduct {
  id: Id;
  competitorId: Id;
  segmentId: Id;
  name: string;
  powertrain: Powertrain;
  priceCents: Cents;
  appeal: number;
  quality: number;
  status: 'on_sale' | 'development' | 'withdrawn';
  launchDate: SimDate | null; // planned / actual launch
  devProgress: number; // 0..1
  devRatePerDay: number;
  lastPriceChange: SimDate | null;
}

// ---------------------------------------------------------------- operations

export interface Downtime {
  start: SimDate;
  end: SimDate;
  reason: string;
  kind: 'planned' | 'strike' | 'disruption' | 'retooling';
}

export interface Factory {
  id: Id;
  name: string;
  location: string;
  country: string;
  departmentId: Id;
  status: 'operating' | 'idle' | 'closed';
  fixedOverheadMonthlyCents: Cents;
  absenteeismPct: number;
  fixedCrew: number;
  crewPerDailyUnit: number;
  downtime: Downtime[];
  description: string;
}

export type LineStatus = 'running' | 'idle' | 'not_ready' | 'ramp_up';

export interface ProductionLine {
  id: Id;
  factoryId: Id;
  modelId: Id;
  name: string;
  maxDailyRate: number;
  plannedDailyRate: number;
  status: LineStatus;
  rampStartDate: SimDate | null;
  rampDays: number;
}

export interface Supplier {
  id: Id;
  name: string;
  country: string;
  category: string;
  reliability: number; // 0..100
  qualityScore: number;
  financialHealth: number;
  relationship: number; // 0..100
  paymentTermsDays: number;
  contactId: Id | null;
  description: string;
}

export interface ComponentSupply {
  id: Id;
  supplierId: Id;
  component: string;
  modelIds: Id[];
  unitPriceCents: Cents;
  dailyCapacity: number; // vehicle sets per day the supplier can deliver
  stockUnits: number; // consignment stock at our plants (vehicle sets)
  targetStockDays: number;
  disruptionFactor: number; // 0 = none, 1 = total outage
  disruptionUntil: SimDate | null;
  pendingCapacity: { date: SimDate; dailyCapacity: number; reason: string }[];
  contractId: Id | null;
  isAlternative: number; // 1 = second source
}

// ---------------------------------------------------------------- people

export type DeptKind = 'plant' | 'engineering' | 'sales' | 'corporate';

export interface Department {
  id: Id;
  name: string;
  kind: DeptKind;
  factoryId: Id | null;
  headId: Id | null;
  headcount: number;
  annualCostPerHeadCents: Cents;
  headcountDays: number; // accumulated headcount-days in the current month
  morale: number; // 0..100
  attritionPctYear: number;
  hiring: { count: number; arrivalDate: SimDate; actionId: Id | null }[];
  leaving: { count: number; date: SimDate; reason: string; severancePerHeadCents: Cents; actionId: Id | null }[];
  expenseAccount: string;
  description: string;
}

export type CharacterOrg = 'asterion' | 'board' | 'union' | 'bank' | 'supplier' | 'regulator' | 'dealer' | 'investor' | 'competitor';

export interface Authority {
  spendLimitCents: Cents;
  financingLimitCents: Cents;
  canApprove: string[]; // action types this character may approve within limits
  notes: string;
}

export interface PrivateFact {
  id: string;
  fact: string;
  revealAtTrust: number;
}

export interface BoardPrefs {
  liquidity: number;
  profitability: number;
  growth: number;
  ev: number;
  jobs: number;
  dilution: number;
  risk: number;
}

export interface Character {
  id: Id;
  name: string;
  title: string;
  org: CharacterOrg;
  orgName: string;
  departmentId: Id | null;
  reportsTo: Id | null;
  isBoardMember: number;
  skills: string[];
  expertise: string[];
  objectives: string[];
  incentives: string;
  riskTolerance: number; // 0..100
  personality: string;
  communicationStyle: string;
  trustInCeo: number; // 0..100
  stress: number; // 0..100
  authority: Authority;
  privateInfo: PrivateFact[];
  knowledgeScope: string[]; // domains this character has authoritative visibility into
  boardPrefs: BoardPrefs | null;
  active: number;
  bio: string;
}

export interface Relationship {
  id: Id;
  fromId: Id;
  toId: Id;
  kind: 'ally' | 'rival' | 'reports_to' | 'mentor' | 'distrust' | 'professional' | 'counterparty';
  strength: number; // -100..100
  note: string;
}

export type MemoryKind = 'conversation' | 'promise' | 'grievance' | 'praise' | 'observation' | 'decision' | 'negotiation';

export interface CharacterMemory {
  id: Id;
  characterId: Id;
  date: SimDate;
  kind: MemoryKind;
  summary: string;
  importance: number; // 1..5
  sentiment: number; // -2..2
  sourceType: string;
  sourceId: string | null;
  entityRefs: EntityRef[];
}

// ---------------------------------------------------------------- projects

export type ProjectStatus = 'proposed' | 'under_review' | 'approved' | 'active' | 'blocked' | 'delayed' | 'completed' | 'cancelled' | 'on_hold';

export type ProjectEffect =
  | { type: 'model_appeal'; modelId: Id; delta: number }
  | { type: 'model_quality'; modelId: Id | '*'; delta: number }
  | { type: 'model_cost'; modelId: Id; deltaCents: Cents }
  | { type: 'model_co2'; modelId: Id; gkm: number }
  | { type: 'model_launch'; modelId: Id }
  | { type: 'factory_overhead_pct'; factoryId: Id; pct: number }
  | { type: 'factory_crew_pct'; factoryId: Id; pct: number }
  | { type: 'line_capacity'; lineId: Id; delta: number }
  | { type: 'supply_capacity'; supplyId: Id; dailyCapacity: number }
  | { type: 'segment_ref_price_pct'; segmentId: Id; modelId: Id; pct: number }
  | { type: 'warranty_pct'; pct: number }
  | { type: 'model_euro7'; modelId: Id }
  | { type: 'distribution'; delta: number };

export interface ProjectRisk {
  text: string;
  likelihood: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
}

export interface Project {
  id: Id;
  code: string;
  name: string;
  kind: 'vehicle_program' | 'industrial' | 'cost' | 'commercial' | 'supplier' | 'quality' | 'restructuring';
  objective: string;
  scope: string;
  sponsorId: Id;
  managerId: Id;
  departmentId: Id; // engineering pool that staffs the project
  status: ProjectStatus;
  priority: 'critical' | 'high' | 'medium' | 'low';
  startDate: SimDate;
  originalTargetDate: SimDate;
  targetDate: SimDate;
  forecastDate: SimDate | null;
  forecastP80Date: SimDate | null;
  budgetCents: Cents;
  originalBudgetCents: Cents;
  spentCents: Cents; // external + internal cost to date
  externalSpentCents: Cents;
  internalCostCents: Cents;
  committedCents: Cents;
  staffingFte: number;
  baseFte: number;
  productivity: number; // work units per effective FTE per working day
  capitalizeExternal: number; // 1 = external spend capitalised (development asset / tooling)
  externalAccrualCents: Cents; // external spend incurred this month, not yet invoiced
  acceptanceCriteria: string[];
  dependencies: string[];
  linkedModelId: Id | null;
  templateKey: string | null;
  completionEffects: ProjectEffect[];
  risks: ProjectRisk[];
  lastDecision: string | null;
  completedDate: SimDate | null;
  description: string;
}

export type Gate =
  | { type: 'issue_resolved'; issueId: Id }
  | { type: 'supply_capacity'; supplyIds: Id[]; minDaily: number }
  | { type: 'not_before'; date: SimDate; reason: string };

export type MilestoneStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'skipped';

export interface Milestone {
  id: Id;
  projectId: Id;
  seq: number;
  name: string;
  description: string;
  workTotal: number;
  workDone: number;
  status: MilestoneStatus;
  plannedDate: SimDate;
  originalPlannedDate: SimDate;
  completedDate: SimDate | null;
  gates: Gate[];
  externalCostCents: Cents; // external spend for the milestone, incurred pro rata with work
  lateFlagged: number;
}

export interface ProjectHistory {
  id: Id;
  projectId: Id;
  date: SimDate;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
  actionId: Id | null;
}

// ---------------------------------------------------------------- issues & commitments

export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'investigating' | 'mitigating' | 'resolved' | 'closed';

export type IssueEffect =
  | { type: 'spend'; amountCents: Cents; account: string; capitalize?: boolean }
  | { type: 'reduce_work'; pct: number }
  | { type: 'add_fte'; fte: number }
  | { type: 'quality'; modelId: Id; delta: number }
  | { type: 'provision'; amountCents: Cents; account: string; label: string }
  | { type: 'demand'; modelId: Id; factor: number; days: number }
  | { type: 'resolve' }
  | { type: 'set_status'; status: IssueStatus }
  | { type: 'trust'; characterId: Id; delta: number }
  | { type: 'absenteeism'; factoryId: Id; delta: number }
  | { type: 'risk_factor'; factor: number }
  | { type: 'model_cost'; modelId: Id; deltaCents: Cents }
  | { type: 'investigate'; workPerDay: number };

export interface IssueOption {
  key: string;
  label: string;
  description: string;
  costCents: Cents;
  effects: IssueEffect[];
  tradeoffs: string;
}

export interface Issue {
  id: Id;
  kind: string;
  title: string;
  description: string;
  severity: IssueSeverity;
  ownerId: Id | null;
  discoveredDate: SimDate;
  status: IssueStatus;
  nextAction: string;
  deadline: SimDate | null;
  linked: EntityRef[];
  projectId: Id | null;
  drag: number; // share of project capacity absorbed while unresolved
  resolutionWorkTotal: number;
  resolutionWorkDone: number;
  options: IssueOption[];
  chosenOptions: string[];
  resolvedDate: SimDate | null;
  resolutionNote: string | null;
  data: Record<string, number | string | null>;
}

export type CommitmentCheck =
  | { type: 'freeform' }
  | { type: 'milestone_completed_by'; milestoneId: Id }
  | { type: 'project_completed_by'; projectId: Id }
  | { type: 'no_headcount_reduction'; departmentIds: Id[] }
  | { type: 'min_liquidity'; amountCents: Cents }
  | { type: 'price_floor'; modelId: Id; minNetPriceCents: Cents }
  | { type: 'deliver_plan'; topic: string };

export type CommitmentStatus = 'open' | 'due' | 'fulfilled' | 'broken' | 'cancelled';

export interface Commitment {
  id: Id;
  promisorId: Id; // 'ceo' or character id
  promiseeId: Id;
  description: string;
  dueDate: SimDate | null;
  conditions: string;
  status: CommitmentStatus;
  createdDate: SimDate;
  source: string; // 'conversation' | 'action' | 'negotiation' | 'board' | 'scenario'
  sourceId: string | null;
  check: CommitmentCheck;
  resolvedDate: SimDate | null;
  notifiedUpcoming: number;
  importance: number; // 1..5
}

// ---------------------------------------------------------------- finance

export type DebtKind = 'bond' | 'term_loan' | 'rcf' | 'private_placement' | 'green_loan' | 'bridge' | 'shareholder_loan';

export interface Amortization {
  date: SimDate;
  amountCents: Cents;
}

export interface DebtInstrument {
  id: Id;
  name: string;
  kind: DebtKind;
  lender: string;
  lenderCharacterId: Id | null;
  principalCents: Cents;
  limitCents: Cents; // facility size (RCF); equals original principal otherwise
  rateBps: number;
  commitmentFeeBps: number;
  startDate: SimDate;
  maturityDate: SimDate;
  interestMonths: number[]; // months in which accrued interest is paid
  paymentDay: number;
  amortization: Amortization[];
  principalDays: number; // accumulated principal-cent-days in the current month (interest accrual base)
  undrawnDays: number; // accumulated undrawn-cent-days (commitment fee base)
  interestPayableCents: Cents;
  status: 'active' | 'repaid' | 'defaulted' | 'cancelled';
  secured: number;
  conditions: string[];
}

export interface Covenant {
  id: Id;
  name: string;
  instrumentIds: Id[];
  metric: 'net_leverage' | 'interest_cover' | 'min_liquidity';
  comparator: 'max' | 'min';
  threshold: number; // ratio, or cents for liquidity
  lastTestDate: SimDate | null;
  lastValue: number | null;
  status: 'compliant' | 'breached' | 'waived';
  waiverUntil: SimDate | null;
  description: string;
}

export interface Receivable {
  id: Id;
  counterparty: string;
  amountCents: Cents;
  issueDate: SimDate;
  dueDate: SimDate;
  status: 'open' | 'settled';
  settledDate: SimDate | null;
  source: string;
}

export type PayableCategory = 'materials' | 'overhead' | 'project' | 'capex' | 'marketing' | 'ga' | 'tax' | 'co2' | 'restructuring' | 'warranty' | 'other' | 'prepayment' | 'fees' | 'payroll';

export interface Payable {
  id: Id;
  counterpartyId: string;
  category: PayableCategory;
  amountCents: Cents;
  issueDate: SimDate;
  dueDate: SimDate;
  status: 'open' | 'paid' | 'overdue';
  paidDate: SimDate | null;
  sourceId: string | null;
  /** Ledger account credited when the obligation was recognised (2000 AP by default). */
  liabilityAccount: string;
}

export interface JournalLine {
  account: string;
  amountCents: Cents; // debit positive, credit negative
  memo?: string;
}

export type CashFlowCategory = 'operating' | 'investing' | 'financing' | 'opening';

export interface JournalEntry {
  id: Id;
  date: SimDate;
  description: string;
  sourceType: string;
  sourceId: string | null;
  cfCategory: CashFlowCategory | null;
  cfLine: string | null;
  lines: JournalLine[];
}

export interface Account {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  statementLine: string;
}

// ---------------------------------------------------------------- contracts, negotiations, financing

export type ContractStatus = 'draft' | 'agreed' | 'pending_approval' | 'active' | 'expired' | 'terminated' | 'superseded';

export interface Contract {
  id: Id;
  kind: 'supply' | 'labor' | 'debt' | 'dealer' | 'lease' | 'pooling' | 'acquisition' | 'service' | 'equity';
  title: string;
  counterpartyId: Id | null;
  counterpartyName: string;
  status: ContractStatus;
  terms: Record<string, number | string | boolean | null>;
  startDate: SimDate | null;
  endDate: SimDate | null;
  signedDate: SimDate | null;
  valueCents: Cents;
  amendmentOf: Id | null;
  negotiationId: Id | null;
  templateKey: string | null;
  obligations: { text: string; dueDate: SimDate | null; status: 'open' | 'met' | 'breached' }[];
  summary: string;
}

export interface NegotiationTerm {
  key: string;
  label: string;
  unit: 'eur' | 'eur_m' | 'pct' | 'units_per_day' | 'months' | 'days' | 'bps' | 'years' | 'count';
  min: number;
  max: number;
  step: number;
  /** Which direction is better for Asterion. */
  ceoPrefers: 'low' | 'high';
  description: string;
}

export interface NegotiationRound {
  n: number;
  date: SimDate;
  by: 'ceo' | 'counterparty';
  terms: Record<string, number>;
  message: string;
  evaluation: {
    utility: number;
    threshold: number;
    accepted: boolean;
    violations: string[];
    argumentQuality: number;
    notes: string[];
  } | null;
}

export type NegotiationStatus = 'open' | 'agreed' | 'failed' | 'expired' | 'withdrawn';

export interface Negotiation {
  id: Id;
  templateKey: string;
  title: string;
  counterpartyId: Id;
  status: NegotiationStatus;
  terms: NegotiationTerm[];
  reservation: Record<string, number>; // private: counterparty walk-away values
  ideal: Record<string, number>; // counterparty opening position
  weights: Record<string, number>;
  baseThreshold: number;
  concessionPerRound: number;
  maxRounds: number;
  rounds: NegotiationRound[];
  deadline: SimDate | null;
  createdDate: SimDate;
  agreedTerms: Record<string, number> | null;
  contractId: Id | null;
  linkedIssueId: Id | null;
  context: string;
  /** Counterparty has said "yes, subject to internal approval" — resolved by the engine on `date`. */
  pendingDecision: { date: SimDate; terms: Record<string, number>; approver: string } | null;
}

export type FinancingKind =
  | 'rcf_draw'
  | 'rcf_repay'
  | 'bank_term_loan'
  | 'bond'
  | 'rights_issue'
  | 'shareholder_loan'
  | 'ceo_contribution'
  | 'sale_leaseback'
  | 'covenant_waiver';

export type FinancingStatus = 'draft' | 'under_review' | 'offered' | 'accepted' | 'pending_approval' | 'executed' | 'rejected' | 'withdrawn' | 'expired';

export interface FinancingOffer {
  amountCents: Cents;
  rateBps: number;
  tenorYears: number;
  feesCents: Cents;
  conditions: string[];
  pricePerShareCents?: Cents;
  newShares?: number;
  leaseAnnualCents?: Cents;
  validUntil: SimDate;
}

export interface FinancingRequest {
  id: Id;
  kind: FinancingKind;
  counterparty: string;
  counterpartyId: Id | null;
  requestedCents: Cents;
  tenorYears: number;
  status: FinancingStatus;
  submittedDate: SimDate;
  decisionDate: SimDate | null;
  offer: FinancingOffer | null;
  decisionReason: string | null;
  rationale: string;
  executedDate: SimDate | null;
  instrumentId: Id | null;
  actionId: Id | null;
  analysis: Record<string, number | string | null>;
}

// ---------------------------------------------------------------- board

export interface BoardVote {
  memberId: Id;
  vote: 'for' | 'against' | 'abstain';
  score: number;
  reason: string;
}

export interface BoardProposal {
  id: Id;
  title: string;
  kind: string;
  /** The single decision this proposal asks the board to approve (legacy/primary). */
  actionId: Id | null;
  /** Every concrete decision carried out if the board approves (empty = endorsement only). */
  actionIds: Id[];
  summary: string;
  rationale: string;
  analysis: Record<string, number | string | null>;
  submittedDate: SimDate;
  meetingDate: SimDate;
  status: 'scheduled' | 'approved' | 'rejected' | 'withdrawn';
  votes: BoardVote[];
  decidedDate: SimDate | null;
  outcomeNote: string | null;
}

// ---------------------------------------------------------------- regulation / events

export interface Regulation {
  id: Id;
  name: string;
  jurisdiction: string;
  kind: 'co2_fleet' | 'type_approval' | 'labour' | 'trade' | 'subsidy' | 'other';
  status: 'in_force' | 'announced' | 'proposed' | 'expired';
  effectiveDate: SimDate;
  description: string;
  params: Record<string, number | string | null>;
}

export interface EventState {
  key: string; // event key or key:entity
  lastFired: SimDate | null;
  count: number;
  activeUntil: SimDate | null;
  data: Record<string, number | string | null>;
}

export type EventSeverity = 'info' | 'notice' | 'warning' | 'critical';
export type EventCauseKind = 'causal' | 'random_shock' | 'player_action' | 'scheduled' | 'system';

export interface GameEvent {
  id: Id;
  date: SimDate;
  type: string;
  category: 'finance' | 'operations' | 'product' | 'people' | 'market' | 'regulatory' | 'board' | 'project' | 'negotiation' | 'system' | 'supply';
  severity: EventSeverity;
  title: string;
  description: string;
  causeKind: EventCauseKind;
  cause: { text: string; refs: EntityRef[]; preconditions?: string[] };
  entities: EntityRef[];
  consequences: { text: string; amountCents?: Cents }[];
  followUps: string[];
  source: 'engine' | 'action' | 'llm_proposal' | 'scenario';
  actionId: Id | null;
}

export interface InboxItem {
  id: Id;
  date: SimDate;
  kind: 'briefing' | 'report' | 'request' | 'warning' | 'invitation' | 'board' | 'letter';
  fromId: Id | null;
  subject: string;
  body: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  read: number;
  linked: EntityRef[];
}

export interface FinancialSnapshot {
  id: string; // e.g. "M:2027-01" or "Q:2027-Q1"
  kind: 'month' | 'quarter' | 'year';
  period: string;
  date: SimDate;
  data: SnapshotData;
}

export interface SnapshotData {
  revenueCents: Cents;
  vehicleRevenueCents: Cents;
  aftersalesRevenueCents: Cents;
  cogsCents: Cents;
  grossProfitCents: Cents;
  personnelCents: Cents;
  otherOpexCents: Cents;
  ebitdaCents: Cents;
  daCents: Cents;
  ebitCents: Cents;
  interestCents: Cents;
  taxCents: Cents;
  netIncomeCents: Cents;
  cashCents: Cents;
  debtCents: Cents;
  liquidityCents: Cents;
  operatingCfCents: Cents;
  investingCfCents: Cents;
  financingCfCents: Cents;
  unitsProduced: number;
  unitsWholesale: number;
  unitsRetail: number;
  headcount: number;
}

export interface Forecast {
  id: Id;
  createdDate: SimDate;
  trigger: string;
  data: ForecastData;
}

export interface ForecastMonth {
  month: string;
  revenueCents: Cents;
  ebitdaCents: Cents;
  ebitCents: Cents;
  netIncomeCents: Cents;
  cashCents: Cents;
  liquidityCents: Cents;
  debtCents: Cents;
  netLeverage: number;
  production: number;
  retail: number;
}

export interface ForecastScenario {
  key: 'base' | 'downside' | 'upside';
  label: string;
  assumptions: string[];
  months: ForecastMonth[];
  summary: ForecastSummary;
  projectDates: Record<Id, SimDate | null>;
}

export interface ForecastData {
  horizonMonths: number;
  scenarios: ForecastScenario[];
  notes: string[];
}

// ---------------------------------------------------------------- actions & conversations

export type ActionStatus =
  | 'pending_confirmation'
  | 'pending_approval'
  | 'scheduled'
  | 'committed'
  | 'rejected'
  | 'invalid'
  | 'failed'
  | 'superseded'
  | 'cancelled'
  /** Approved by the board but not yet executable (retried automatically; can also be executed by hand). */
  | 'approved'
  | 'expired';

export interface Consequence {
  label: string;
  amountCents?: Cents;
  timing?: string;
  kind: 'cash' | 'pnl' | 'operational' | 'people' | 'risk' | 'approval' | 'info';
}

export interface ActionRecord {
  id: Id;
  idempotencyKey: string;
  type: string;
  actorId: Id;
  source: 'player' | 'llm_proposal' | 'system';
  payload: Record<string, unknown>;
  status: ActionStatus;
  simDate: SimDate;
  createdAt: string;
  updatedAt: string;
  summary: string;
  errors: string[];
  warnings: string[];
  consequences: Consequence[];
  approvals: { approver: string; kind: string; status: 'required' | 'granted' | 'denied'; ref: string | null; note: string | null }[];
  result: Record<string, unknown> | null;
  conversationId: Id | null;
  rationale: string | null;
  supersededBy: Id | null;
}

export interface Conversation {
  id: Id;
  characterId: Id;
  title: string;
  startedDate: SimDate;
  lastDate: SimDate;
  status: 'open' | 'closed';
  summary: string;
  negotiationId: Id | null;
  createdAt: string;
}

export interface ConversationMessage {
  id: Id;
  conversationId: Id;
  role: 'player' | 'character' | 'system';
  content: string;
  simDate: SimDate;
  createdAt: string;
  structured: Record<string, unknown> | null;
}
