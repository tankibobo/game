/**
 * Documented, configurable simulation parameters. Every formula in the engine
 * refers back to these names; the README's "Simulation model" section
 * describes them in prose.
 */
import { eur, mEur } from '../../shared/money';

export const PARAMS = {
  // ---------------------------------------------------------------- demand
  /** Utility weight of product appeal: +1 utility per 20 appeal points. */
  appealWeight: 1 / 20,
  /** Utility weight of quality: +1 per 40 points above/below 70. */
  qualityWeight: 1 / 40,
  /** Utility weight of customer satisfaction. */
  satisfactionWeight: 1 / 50,
  /** Brand/distribution penalty for Asterion vs incumbents (smaller dealer network). */
  asterionDistributionUtility: -0.15,
  /** Marketing response: utility = k * ln(spend / baseline). */
  marketingElasticity: 0.12,
  marketingBaselineMonthlyCents: mEur(8),
  /** Day-to-day retail noise (sd as share of expected daily retail). */
  retailNoiseSd: 0.12,
  /** Share of unmet retail demand that waits as backlog (rest is lost). */
  backlogShareOfUnmet: 0.55,
  /** Daily cancellation rate of open backlog orders. */
  backlogDailyCancellation: 0.015,
  /** Dealer target stock in days of retail sales. */
  dealerTargetStockDays: 45,
  /** Dealers correct the gap to target stock over this many days. */
  dealerStockAdjustmentDays: 25,
  /** Dealers cap their orders when stock exceeds this many days. */
  dealerMaxStockDays: 95,
  /** Dealer payment terms (days). */
  dealerPaymentDays: 30,

  // ---------------------------------------------------------------- production
  /** Absenteeism above which line output is limited (share of crew). */
  rampCurveStart: 0.25,
  /** Storage & carrying cost of company finished-goods stock per unit-day. */
  storageCostPerUnitDayCents: eur(2.5),

  // ---------------------------------------------------------------- aftersales
  aftersalesRevenuePerParcVehicleMonthCents: eur(16.5),
  aftersalesCostShare: 0.48,
  /** Monthly scrappage of the vehicle parc. */
  parcMonthlyDecay: 0.006,

  // ---------------------------------------------------------------- warranty
  /** Share of the warranty provision consumed by claims each month. */
  warrantyMonthlyClaimShare: 0.032,

  // ---------------------------------------------------------------- tax & regulation
  taxRate: 0.25,
  /** Quarterly tax payment due on this day of the month after quarter end. */
  taxPaymentDay: 15,
  co2PenaltyPerGramPerVehicleCents: eur(95),

  // ---------------------------------------------------------------- finance
  daysPerYear: 365,
  /** Treasury keeps at least this much cash; below it, the RCF is drawn automatically. */
  minOperatingCashCents: mEur(150),
  /** Surplus cash above this level repays drawn RCF automatically at month end. */
  rcfAutoRepayAboveCents: mEur(600),
  /** Days of missed payments that trigger insolvency proceedings. */
  insolvencyMissedPaymentDays: 10,
  /** Overdue amount above which missed payments count toward insolvency. */
  insolvencyOverdueThresholdCents: mEur(25),
  sustainingCapexDepreciationYears: 10,
  developmentAmortisationYears: 6,

  // ---------------------------------------------------------------- people
  severanceDefaultPerHeadCents: eur(65_000),
  recruitingCostPerHeadCents: eur(9_000),
  hiringLeadDays: { plant: 45, engineering: 90, sales: 60, corporate: 60 } as Record<string, number>,
  /** Notice/consultation period before announced job cuts take effect. */
  consultationDays: 60,

  // ---------------------------------------------------------------- projects
  /** Brooks's law: effective FTE = base * (fte/base)^exponent. */
  staffingExponent: 0.72,
  /** Max FTE added per change (onboarding limit). */
  maxStaffingChange: 400,

  // ---------------------------------------------------------------- board
  confidenceDismissalThreshold: 20,
  confidenceDismissalMeetings: 2,
} as const;

/** Board approval thresholds (institutional rules). */
export const RULES = {
  ceoSpendLimitCents: mEur(50),
  ceoFinancingLimitCents: mEur(100),
  boardRestructuringHeadcount: 300,
  ceoHiringLimit: 500,
  extraordinaryMeetingNoticeDays: 7,
} as const;
