/**
 * The Asterion Automotive starting scenario (1 January 2027).
 *
 * Everything here is hand-authored and internally consistent: unit economics
 * reproduce FY2026 revenue of ≈€7.5bn and an operating margin of ≈3.2%; the
 * opening balance sheet balances by construction (retained earnings is the
 * balancing figure and is reported as such); payables/receivables are seeded
 * from the same daily volumes the engine will simulate.
 */
import type { Difficulty } from '../../shared/domain';
import { scenarioOf, type ScenarioBuildContext } from './scenarios';
import type {
  Character,
  Commitment,
  Competitor,
  CompetitorProduct,
  ComponentSupply,
  Contract,
  Covenant,
  DebtInstrument,
  Department,
  Factory,
  FinancialSnapshot,
  GameMeta,
  Issue,
  MacroState,
  Milestone,
  Negotiation,
  Payable,
  ProductionLine,
  Project,
  Receivable,
  Regulation,
  Relationship,
  Segment,
  Supplier,
  VehicleModel,
} from '../../shared/domain';
import { eur, mEur, mulDiv, type Cents } from '../../shared/money';
import { addDays, diffDays, fourthThursday, type SimDate } from '../../shared/dates';
import { emptyOutput, type World } from '../engine/world';
import { post } from '../engine/ledger';
import { calibrateOtherUtility } from '../engine/demand';
import { NEGOTIATION_TEMPLATES } from '../engine/negotiation';

export const START_DATE: SimDate = '2027-01-01';
export const OPENING_DATE: SimDate = '2026-12-31';
export const DEFAULT_SEED = 20270101;

/** FY2026 reported figures (pre-game history, used for comparatives and LTM metrics). */
export const FY2026 = {
  revenueCents: mEur(7_512),
  vehicleRevenueCents: mEur(7_082),
  aftersalesRevenueCents: mEur(430),
  ebitdaCents: mEur(541),
  daCents: mEur(300),
  ebitCents: mEur(241),
  interestCents: mEur(108),
  taxCents: mEur(33),
  netIncomeCents: mEur(100),
  unitsProduced: 310_000,
  unitsWholesale: 296_000,
  unitsRetail: 295_000,
  headcount: 18_000,
};

const C = (m: number) => mEur(m);

function segments(): Segment[] {
  return [
    {
      id: 'SEG-CHATCH',
      name: 'C-segment hatchback',
      baseMonthlyUnits: 190_000,
      refPriceCents: eur(21_500),
      priceElasticity: 3.2,
      seasonality: [0.82, 0.92, 1.18, 1.02, 1.0, 1.08, 0.98, 0.8, 1.12, 1.0, 0.98, 1.1],
      growthPerYear: -0.015,
      powertrainPref: { ice: 0.6, hev: 0.22, phev: 0.06, bev: 0.12 },
      prefDriftPerYear: { ice: -0.06, hev: 0.02, phev: 0, bev: 0.04 },
      otherUtility: 0,
      description: 'European compact hatchbacks. Shrinking slowly as buyers move to crossovers; price-sensitive.',
    },
    {
      id: 'SEG-CSUV',
      name: 'C-SUV / compact crossover',
      baseMonthlyUnits: 270_000,
      refPriceCents: eur(30_500),
      priceElasticity: 3.0,
      seasonality: [0.84, 0.94, 1.16, 1.02, 1.0, 1.08, 0.98, 0.82, 1.1, 1.0, 0.98, 1.08],
      growthPerYear: 0.02,
      powertrainPref: { ice: 0.36, hev: 0.32, phev: 0.1, bev: 0.22 },
      prefDriftPerYear: { ice: -0.05, hev: 0.01, phev: 0, bev: 0.04 },
      otherUtility: 0,
      description: "Europe's largest and most contested segment. Electrified powertrains are taking share every year.",
    },
  ];
}

function models(): VehicleModel[] {
  const base = {
    retailMtd: 0,
    wholesaleMtd: 0,
    productionMtd: 0,
    lostSalesMtd: 0,
    fgUnitDaysMtd: 0,
    demandModifier: 1,
    demandModifierUntil: null,
    inTransit: 0,
    backlog: 0,
  };
  return [
    {
      ...base,
      id: 'MDL-VELA',
      name: 'Asterion Vela',
      segmentId: 'SEG-CHATCH',
      powertrain: 'ice',
      status: 'in_production',
      lifecycle: 'decline',
      launchDate: '2019-03-01',
      netPriceCents: eur(18_900),
      listPriceCents: eur(26_490),
      baseAppeal: 62,
      appealDecayPerYear: 2.5,
      quality: 71,
      satisfaction: 68,
      co2Gkm: 124,
      otherMaterialCostCents: eur(11_650),
      logisticsPerUnitCents: eur(350),
      warrantyPerUnitCents: eur(260),
      fgUnits: 14_000,
      fgValueCents: 0, // set below from unit cost
      dealerStock: 21_000,
      retailLastMonth: 10_400,
      wholesaleLastMonth: 11_100,
      productionLastMonth: 9_800,
      cumulativeRetail: 0,
      euro7Compliant: 0,
      projectId: null,
      description: '1.2-litre petrol compact hatchback built in Lyon since 2019. Profitable per unit but ageing, CO₂-heavy and not Euro 7 compliant.',
    },
    {
      ...base,
      id: 'MDL-KORA',
      name: 'Asterion Kora',
      segmentId: 'SEG-CSUV',
      powertrain: 'hev',
      status: 'in_production',
      lifecycle: 'mature',
      launchDate: '2022-09-01',
      netPriceCents: eur(28_400),
      listPriceCents: eur(38_900),
      baseAppeal: 70,
      appealDecayPerYear: 2.5,
      quality: 74,
      satisfaction: 76,
      co2Gkm: 98,
      otherMaterialCostCents: eur(15_610),
      logisticsPerUnitCents: eur(420),
      warrantyPerUnitCents: eur(380),
      fgUnits: 7_500,
      fgValueCents: 0,
      dealerStock: 19_000,
      retailLastMonth: 13_100,
      wholesaleLastMonth: 13_600,
      productionLastMonth: 12_600,
      cumulativeRetail: 0,
      euro7Compliant: 0,
      projectId: 'PRJ-KORA-MY28',
      description: "Full-hybrid compact SUV built in Seville and Brno. Asterion's profit engine. Euro 7 compliance comes with the MY2028 update.",
    },
    {
      ...base,
      id: 'MDL-EON',
      name: 'Asterion Eon',
      segmentId: 'SEG-CSUV',
      powertrain: 'bev',
      status: 'development',
      lifecycle: 'development',
      launchDate: null,
      netPriceCents: eur(36_500),
      listPriceCents: eur(44_900),
      baseAppeal: 78,
      appealDecayPerYear: 2,
      quality: 72,
      satisfaction: 75,
      co2Gkm: 0,
      otherMaterialCostCents: eur(17_090),
      logisticsPerUnitCents: eur(450),
      warrantyPerUnitCents: eur(600),
      fgUnits: 0,
      fgValueCents: 0,
      dealerStock: 0,
      retailLastMonth: 0,
      wholesaleLastMonth: 0,
      productionLastMonth: 0,
      cumulativeRetail: 0,
      euro7Compliant: 1,
      projectId: 'PRJ-EON',
      description: '77 kWh electric crossover on the new E-Flex platform, to be built in Brno. Behind schedule; battery supply and thermal validation unresolved.',
    },
  ];
}

function competitors(): { competitors: Competitor[]; products: CompetitorProduct[] } {
  const competitors: Competitor[] = [
    { id: 'CMP-VOLKNER', name: 'Volkner Group', origin: 'Germany', strategy: 'Scale incumbent; broad portfolio, defending share with hybrids while ramping BEVs.', financialHealth: 78, evCapability: 70, aggressiveness: 0.5, description: "Europe's largest manufacturer. Slow but formidable; matches price moves in core segments." },
    { id: 'CMP-MARIVAUX', name: 'Marivaux Automobiles', origin: 'France', strategy: 'Cost leadership and early BEV volume in compact segments.', financialHealth: 64, evCapability: 66, aggressiveness: 0.6, description: 'Direct domestic rival in France; aggressive on fleet pricing.' },
    { id: 'CMP-HANWA', name: 'Hanwa Motors', origin: 'South Korea', strategy: 'Quality and value; strong hybrids and a competitive BEV line-up.', financialHealth: 82, evCapability: 78, aggressiveness: 0.35, description: 'Benchmark for quality and warranty; steadily gaining share.' },
    { id: 'CMP-SHENLONG', name: 'Shenlong Auto', origin: 'China', strategy: 'Price-led BEV market entry; vertically integrated batteries.', financialHealth: 70, evCapability: 85, aggressiveness: 0.8, description: 'Entering Europe aggressively; battery cost advantage of ~20%. Exposed to EU tariff decisions.' },
    { id: 'CMP-NORDVIK', name: 'Nordvik Electric', origin: 'Sweden', strategy: 'Premium BEV niche.', financialHealth: 38, evCapability: 80, aggressiveness: 0.2, description: 'Premium EV start-up burning cash; rumoured to be seeking a partner.' },
  ];
  const p = (x: Omit<CompetitorProduct, 'lastPriceChange'>): CompetitorProduct => ({ ...x, lastPriceChange: null });
  const products: CompetitorProduct[] = [
    p({ id: 'CPR-ARDEN', competitorId: 'CMP-VOLKNER', segmentId: 'SEG-CHATCH', name: 'Volkner Arden', powertrain: 'ice', priceCents: eur(21_800), appeal: 68, quality: 78, status: 'on_sale', launchDate: '2023-05-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-ARDEN-H', competitorId: 'CMP-VOLKNER', segmentId: 'SEG-CHATCH', name: 'Volkner Arden Hybrid', powertrain: 'hev', priceCents: eur(24_300), appeal: 69, quality: 78, status: 'on_sale', launchDate: '2024-03-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-SILLAGE', competitorId: 'CMP-MARIVAUX', segmentId: 'SEG-CHATCH', name: 'Marivaux Sillage', powertrain: 'ice', priceCents: eur(20_400), appeal: 64, quality: 72, status: 'on_sale', launchDate: '2021-09-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-SILLAGE-E', competitorId: 'CMP-MARIVAUX', segmentId: 'SEG-CHATCH', name: 'Marivaux Sillage E-Tech', powertrain: 'bev', priceCents: eur(29_500), appeal: 66, quality: 71, status: 'on_sale', launchDate: '2025-02-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-DAO', competitorId: 'CMP-SHENLONG', segmentId: 'SEG-CHATCH', name: 'Shenlong Dao', powertrain: 'bev', priceCents: eur(24_900), appeal: 63, quality: 68, status: 'on_sale', launchDate: '2026-04-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-TERRAN', competitorId: 'CMP-VOLKNER', segmentId: 'SEG-CSUV', name: 'Volkner Terran Hybrid', powertrain: 'hev', priceCents: eur(31_200), appeal: 70, quality: 77, status: 'on_sale', launchDate: '2023-09-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-ETERRAN', competitorId: 'CMP-VOLKNER', segmentId: 'SEG-CSUV', name: 'Volkner e-Terran', powertrain: 'bev', priceCents: eur(38_900), appeal: 76, quality: 77, status: 'development', launchDate: '2028-03-01', devProgress: 0.62, devRatePerDay: 0.0008 }),
    p({ id: 'CPR-ALTIS', competitorId: 'CMP-MARIVAUX', segmentId: 'SEG-CSUV', name: 'Marivaux Altis PHEV', powertrain: 'phev', priceCents: eur(32_900), appeal: 67, quality: 73, status: 'on_sale', launchDate: '2024-06-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-KESTREL', competitorId: 'CMP-HANWA', segmentId: 'SEG-CSUV', name: 'Hanwa Kestrel Hybrid', powertrain: 'hev', priceCents: eur(29_900), appeal: 69, quality: 80, status: 'on_sale', launchDate: '2024-01-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-KESTREL-EV', competitorId: 'CMP-HANWA', segmentId: 'SEG-CSUV', name: 'Hanwa Kestrel EV', powertrain: 'bev', priceCents: eur(37_500), appeal: 71, quality: 79, status: 'on_sale', launchDate: '2025-05-01', devProgress: 1, devRatePerDay: 0 }),
    p({ id: 'CPR-AURORA', competitorId: 'CMP-SHENLONG', segmentId: 'SEG-CSUV', name: 'Shenlong Aurora', powertrain: 'bev', priceCents: eur(31_900), appeal: 70, quality: 70, status: 'development', launchDate: '2027-06-15', devProgress: 0.86, devRatePerDay: 0.0009 }),
    p({ id: 'CPR-N3', competitorId: 'CMP-NORDVIK', segmentId: 'SEG-CSUV', name: 'Nordvik N3', powertrain: 'bev', priceCents: eur(45_900), appeal: 79, quality: 75, status: 'on_sale', launchDate: '2025-10-01', devProgress: 1, devRatePerDay: 0 }),
  ];
  return { competitors, products };
}

function departments(): Department[] {
  const d = (x: Omit<Department, 'headcountDays' | 'hiring' | 'leaving'>): Department => ({ ...x, headcountDays: 0, hiring: [], leaving: [] });
  return [
    d({ id: 'DEP-LYON', name: 'Lyon-Vénissieux plant workforce', kind: 'plant', factoryId: 'FAC-LYON', headId: 'CHR-MARCHETTI', headcount: 5_600, annualCostPerHeadCents: eur(56_000), morale: 52, attritionPctYear: 4, expenseAccount: '6000', description: 'Two-shift assembly workforce for the Vela. Older workforce; night-shift absenteeism rising.' }),
    d({ id: 'DEP-SEV', name: 'Sevilla plant workforce', kind: 'plant', factoryId: 'FAC-SEV', headId: 'CHR-MARCHETTI', headcount: 4_400, annualCostPerHeadCents: eur(48_000), morale: 64, attritionPctYear: 5, expenseAccount: '6000', description: 'Kora main plant. Productive, good labour relations.' }),
    d({ id: 'DEP-BRNO', name: 'Brno plant workforce', kind: 'plant', factoryId: 'FAC-BRNO', headId: 'CHR-MARCHETTI', headcount: 2_900, annualCostPerHeadCents: eur(38_000), morale: 60, attritionPctYear: 7, expenseAccount: '6000', description: 'Kora second line; designated Eon plant. Needs roughly 1,600–1,900 additional operators for the Eon line at full rate.' }),
    d({ id: 'DEP-LTC', name: 'Lyon Technical Centre (engineering)', kind: 'engineering', factoryId: null, headId: 'CHR-WIERZBICKI', headcount: 2_100, annualCostPerHeadCents: eur(88_000), morale: 55, attritionPctYear: 8, expenseAccount: '6010', description: 'Vehicle engineering, testing and sustaining engineering for current models (~1,450 FTE tied to sustaining work).' }),
    d({ id: 'DEP-BEC', name: 'Brno Electrification Centre (engineering)', kind: 'engineering', factoryId: null, headId: 'CHR-WIERZBICKI', headcount: 900, annualCostPerHeadCents: eur(72_000), morale: 50, attritionPctYear: 11, expenseAccount: '6010', description: 'Battery, e-drive and software engineering. Fully committed to the Eon programme; stretched.' }),
    d({ id: 'DEP-SALES', name: 'Sales & Marketing', kind: 'sales', factoryId: null, headId: 'CHR-GARNIER', headcount: 900, annualCostPerHeadCents: eur(74_000), morale: 66, attritionPctYear: 9, expenseAccount: '6020', description: 'National sales companies, dealer development, marketing and pricing.' }),
    d({ id: 'DEP-CORP', name: 'Corporate functions & HQ', kind: 'corporate', factoryId: null, headId: 'CHR-HOLM', headcount: 1_200, annualCostPerHeadCents: eur(84_000), morale: 58, attritionPctYear: 7, expenseAccount: '6030', description: 'Finance, HR, legal, IT, procurement and executive office.' }),
  ];
}

function factories(): { factories: Factory[]; lines: ProductionLine[] } {
  const summer = (y: number) => ({ start: `${y}-08-02`, end: `${y}-08-20`, reason: 'Summer shutdown', kind: 'planned' as const });
  const xmas = (y: number) => ({ start: `${y}-12-24`, end: `${y}-12-31`, reason: 'Year-end shutdown', kind: 'planned' as const });
  const factories: Factory[] = [
    { id: 'FAC-LYON', name: 'Lyon-Vénissieux Assembly', location: 'Vénissieux (Lyon)', country: 'France', departmentId: 'DEP-LYON', status: 'operating', fixedOverheadMonthlyCents: C(4.5), absenteeismPct: 6.5, fixedCrew: 1_400, crewPerDailyUnit: 6.2, downtime: [summer(2027), xmas(2027), summer(2028), xmas(2028)], description: 'Oldest plant (1974, modernised 2018). Single Vela line, capacity 680 jobs/day on two shifts.' },
    { id: 'FAC-SEV', name: 'Sevilla Assembly', location: 'Sevilla', country: 'Spain', departmentId: 'DEP-SEV', status: 'operating', fixedOverheadMonthlyCents: C(3.8), absenteeismPct: 5.0, fixedCrew: 1_100, crewPerDailyUnit: 5.6, downtime: [summer(2027), xmas(2027), summer(2028), xmas(2028)], description: 'Main Kora plant; best productivity in the group.' },
    { id: 'FAC-BRNO', name: 'Brno Assembly', location: 'Brno', country: 'Czechia', departmentId: 'DEP-BRNO', status: 'operating', fixedOverheadMonthlyCents: C(2.7), absenteeismPct: 4.5, fixedCrew: 900, crewPerDailyUnit: 6.0, downtime: [summer(2027), xmas(2027), summer(2028), xmas(2028)], description: 'Second Kora line plus the Eon line under conversion (body shop and battery assembly hall).' },
  ];
  const lines: ProductionLine[] = [
    { id: 'LINE-LYON-VELA', factoryId: 'FAC-LYON', modelId: 'MDL-VELA', name: 'Lyon Line 1 (Vela)', maxDailyRate: 680, plannedDailyRate: 575, status: 'running', rampStartDate: null, rampDays: 0 },
    { id: 'LINE-SEV-KORA', factoryId: 'FAC-SEV', modelId: 'MDL-KORA', name: 'Sevilla Line 1 (Kora)', maxDailyRate: 560, plannedDailyRate: 520, status: 'running', rampStartDate: null, rampDays: 0 },
    { id: 'LINE-BRNO-KORA', factoryId: 'FAC-BRNO', modelId: 'MDL-KORA', name: 'Brno Line 1 (Kora)', maxDailyRate: 280, plannedDailyRate: 195, status: 'running', rampStartDate: null, rampDays: 0 },
    { id: 'LINE-BRNO-EON', factoryId: 'FAC-BRNO', modelId: 'MDL-EON', name: 'Brno Line 2 (Eon)', maxDailyRate: 300, plannedDailyRate: 260, status: 'not_ready', rampStartDate: null, rampDays: 70 },
  ];
  return { factories, lines };
}

function suppliers(): { suppliers: Supplier[]; supplies: ComponentSupply[] } {
  const suppliers: Supplier[] = [
    { id: 'SUP-KESSLER', name: 'Kessler Antriebstechnik', country: 'Germany', category: 'Transmissions & e-drives', reliability: 88, qualityScore: 84, financialHealth: 72, relationship: 70, paymentTermsDays: 60, contactId: null, description: 'Supplies Vela transmissions and the Eon e-drive unit (EDU-150).' },
    { id: 'SUP-HANSEATIC', name: 'Hanseatic Power Systems', country: 'Germany', category: 'Hybrid batteries & inverters', reliability: 80, qualityScore: 70, financialHealth: 65, relationship: 62, paymentTermsDays: 45, contactId: 'CHR-HARTMANN', description: 'Sole source of the Kora hybrid battery and inverter module. Also building an EV cell-module business.' },
    { id: 'SUP-VOLTARIS', name: 'Voltaris Cells', country: 'Sweden', category: 'EV battery packs', reliability: 68, qualityScore: 76, financialHealth: 46, relationship: 55, paymentTermsDays: 30, contactId: 'CHR-SUND', description: 'Nominated Eon battery-pack supplier. Contracted for 140 packs/day; expansion to 300/day requires a new agreement.' },
    { id: 'SUP-CORVIAN', name: 'Corvian Microsystems', country: 'Netherlands', category: 'Electronic control units', reliability: 82, qualityScore: 86, financialHealth: 80, relationship: 66, paymentTermsDays: 60, contactId: null, description: 'ECUs and power electronics for all three models. Exposed to semiconductor allocation.' },
    { id: 'SUP-VALMONT', name: 'Valmont Interiors', country: 'France / Portugal', category: 'Seats & interiors', reliability: 90, qualityScore: 82, financialHealth: 75, relationship: 72, paymentTermsDays: 60, contactId: null, description: 'Seats for all models from plants near each assembly site.' },
    { id: 'SUP-TIER2', name: 'Other tier-1/2 suppliers & raw materials (aggregate)', country: 'Europe', category: 'Bill of materials (non-critical)', reliability: 92, qualityScore: 80, financialHealth: 70, relationship: 65, paymentTermsDays: 60, contactId: null, description: 'Aggregate of ~600 suppliers of steel, glass, plastics and minor parts. Not individually supply-constrained in this model.' },
    { id: 'SUP-LOGISTICS', name: 'Outbound logistics providers (aggregate)', country: 'Europe', category: 'Logistics', reliability: 90, qualityScore: 80, financialHealth: 70, relationship: 65, paymentTermsDays: 30, contactId: null, description: 'Vehicle transport to dealers.' },
  ];
  const s = (x: Omit<ComponentSupply, 'disruptionFactor' | 'disruptionUntil' | 'pendingCapacity' | 'isAlternative'> & { isAlternative?: number }): ComponentSupply => ({
    disruptionFactor: 0,
    disruptionUntil: null,
    pendingCapacity: [],
    ...x,
    isAlternative: x.isAlternative ?? 0,
  });
  const supplies: ComponentSupply[] = [
    s({ id: 'SPL-KES-TRANS', supplierId: 'SUP-KESSLER', component: 'Transmission', modelIds: ['MDL-VELA'], unitPriceCents: eur(1_150), dailyCapacity: 800, stockUnits: 1_800, targetStockDays: 3, contractId: 'CON-KESSLER' }),
    s({ id: 'SPL-KES-EDU', supplierId: 'SUP-KESSLER', component: 'E-drive unit', modelIds: ['MDL-EON'], unitPriceCents: eur(1_650), dailyCapacity: 320, stockUnits: 0, targetStockDays: 3, contractId: 'CON-KESSLER' }),
    s({ id: 'SPL-HAN-HYB', supplierId: 'SUP-HANSEATIC', component: 'Hybrid battery & inverter', modelIds: ['MDL-KORA'], unitPriceCents: eur(3_100), dailyCapacity: 780, stockUnits: 2_100, targetStockDays: 3, contractId: 'CON-HANSEATIC' }),
    s({ id: 'SPL-VOL-PACK', supplierId: 'SUP-VOLTARIS', component: 'Battery pack', modelIds: ['MDL-EON'], unitPriceCents: eur(9_200), dailyCapacity: 140, stockUnits: 0, targetStockDays: 4, contractId: 'CON-VOLTARIS' }),
    s({ id: 'SPL-COR-ICE', supplierId: 'SUP-CORVIAN', component: 'ECU set', modelIds: ['MDL-VELA'], unitPriceCents: eur(420), dailyCapacity: 750, stockUnits: 1_500, targetStockDays: 3, contractId: 'CON-CORVIAN' }),
    s({ id: 'SPL-COR-HEV', supplierId: 'SUP-CORVIAN', component: 'ECU set', modelIds: ['MDL-KORA'], unitPriceCents: eur(610), dailyCapacity: 800, stockUnits: 2_000, targetStockDays: 3, contractId: 'CON-CORVIAN' }),
    s({ id: 'SPL-COR-BEV', supplierId: 'SUP-CORVIAN', component: 'ECU set', modelIds: ['MDL-EON'], unitPriceCents: eur(880), dailyCapacity: 320, stockUnits: 0, targetStockDays: 3, contractId: 'CON-CORVIAN' }),
    s({ id: 'SPL-VAL-C', supplierId: 'SUP-VALMONT', component: 'Seat set', modelIds: ['MDL-VELA'], unitPriceCents: eur(780), dailyCapacity: 760, stockUnits: 1_400, targetStockDays: 2, contractId: 'CON-VALMONT' }),
    s({ id: 'SPL-VAL-SUV', supplierId: 'SUP-VALMONT', component: 'Seat set', modelIds: ['MDL-KORA', 'MDL-EON'], unitPriceCents: eur(980), dailyCapacity: 1_150, stockUnits: 1_600, targetStockDays: 2, contractId: 'CON-VALMONT' }),
  ];
  return { suppliers, supplies };
}

function characters(): { characters: Character[]; relationships: Relationship[] } {
  const auth = (spendM: number, finM: number, canApprove: string[], notes: string) => ({ spendLimitCents: mEur(spendM), financingLimitCents: mEur(finM), canApprove, notes });
  const exec = (x: Omit<Character, 'org' | 'orgName' | 'isBoardMember' | 'boardPrefs' | 'active' | 'stress'> & { stress?: number }): Character => ({
    org: 'asterion',
    orgName: 'Asterion Automotive',
    isBoardMember: 0,
    boardPrefs: null,
    active: 1,
    stress: x.stress ?? 45,
    ...x,
  });
  const board = (x: Omit<Character, 'org' | 'orgName' | 'isBoardMember' | 'active' | 'departmentId' | 'reportsTo' | 'stress'>): Character => ({
    org: 'board',
    orgName: 'Asterion Board of Directors',
    isBoardMember: 1,
    active: 1,
    departmentId: null,
    reportsTo: null,
    stress: 30,
    ...x,
  });
  const ext = (x: Omit<Character, 'isBoardMember' | 'boardPrefs' | 'active' | 'departmentId' | 'reportsTo' | 'stress'>): Character => ({
    isBoardMember: 0,
    boardPrefs: null,
    active: 1,
    departmentId: null,
    reportsTo: null,
    stress: 40,
    ...x,
  });
  const characters: Character[] = [
    exec({
      id: 'CHR-HOLM', name: 'Margarethe Holm', title: 'Chief Financial Officer', departmentId: 'DEP-CORP', reportsTo: 'ceo',
      skills: ['treasury', 'capital markets', 'controlling', 'covenant management'], expertise: ['finance', 'debt', 'liquidity', 'investors'],
      objectives: ['Protect liquidity above €900m', 'Refinance the 2028 bond before markets price in risk', 'Keep net leverage below 3.0x'],
      incentives: 'Annual bonus tied to free cash flow and covenant headroom.', riskTolerance: 25,
      personality: 'Precise, sceptical, unflappable. Respects numbers over enthusiasm. Will say no to the CEO in private but never undermines in public.',
      communicationStyle: 'Short sentences, exact figures, often answers a question with a question about cash.',
      trustInCeo: 55, authority: auth(10, 100, ['propose_budget', 'request_financing', 'approve_budget'], 'May approve budgets up to €10m and draw the RCF up to €100m.'),
      privateInfo: [
        { id: 'PI-HOLM-1', fact: 'She believes the Q3 2027 leverage test gets uncomfortably tight if the Eon slips past year-end and Vela inventory is not cut.', revealAtTrust: 45 },
        { id: 'PI-HOLM-2', fact: 'She has been approached by a headhunter for a CFO role at a larger supplier and is undecided.', revealAtTrust: 75 },
      ],
      knowledgeScope: ['finance', 'debt', 'board', 'projects_budget', 'company'], bio: 'Ex-treasurer of a Swedish truck maker; joined Asterion in 2021 to fix the balance sheet.',
    }),
    exec({
      id: 'CHR-WIERZBICKI', name: 'Dr. Tomasz Wierzbicki', title: 'Chief Technical Officer', departmentId: 'DEP-LTC', reportsTo: 'ceo',
      skills: ['vehicle engineering', 'battery systems', 'validation', 'programme management'], expertise: ['engineering', 'eon', 'quality', 'homologation'],
      objectives: ['Launch Eon without a safety-critical defect', 'Retain battery engineers', 'Avoid committing to dates the test data does not support'],
      incentives: 'Bonus tied to programme milestones and warranty cost.', riskTolerance: 20,
      personality: 'Methodical, blunt about technical risk, dislikes being pressured on dates. Loyal to his engineers. Distrusts deadlines set by sales.',
      communicationStyle: 'Engineering vocabulary, probabilities rather than promises, occasionally dry humour.',
      trustInCeo: 50, authority: auth(5, 0, ['change_project_scope'], 'May reallocate up to 100 FTE within engineering and approve spend up to €5m.'),
      privateInfo: [
        { id: 'PI-WIE-1', fact: "The thermal-propagation test on the Voltaris pack failed twice in November; the official status 'incomplete' understates the problem.", revealAtTrust: 55 },
        { id: 'PI-WIE-2', fact: 'He thinks Voltaris cell chemistry is fine but their module-assembly quality control is weak.', revealAtTrust: 40 },
      ],
      knowledgeScope: ['engineering', 'projects', 'quality', 'products', 'suppliers_technical'], bio: 'Former head of battery validation at a German OEM; CTO since 2022.',
    }),
    exec({
      id: 'CHR-MARCHETTI', name: 'Elena Marchetti', title: 'Chief Operating Officer', departmentId: 'DEP-SEV', reportsTo: 'ceo',
      skills: ['lean manufacturing', 'industrial engineering', 'quality systems', 'labour relations'], expertise: ['operations', 'factories', 'quality', 'supply chain'],
      objectives: ['Keep plants running without disruption', 'Fill Brno for the Eon ramp-up', 'Avoid a recall on the Kora'],
      incentives: 'Bonus on cost per vehicle and quality (PPM).', riskTolerance: 45,
      personality: 'Pragmatic, protective of her plants and people, impatient with PowerPoint. Trusted on the shop floor.',
      communicationStyle: 'Direct and concrete, talks in jobs per hour, shifts and parts.',
      trustInCeo: 60, authority: auth(5, 0, ['adjust_production', 'schedule_downtime'], 'Runs production plans within approved budgets; spend up to €5m.'),
      privateInfo: [
        { id: 'PI-MAR-1', fact: 'Night-shift absenteeism at Lyon is close to 11%, masked by overtime.', revealAtTrust: 45 },
        { id: 'PI-MAR-2', fact: 'Hanseatic has quietly changed a capacitor sub-supplier in 2025; she suspects that is the inverter root cause.', revealAtTrust: 60 },
      ],
      knowledgeScope: ['operations', 'factories', 'suppliers', 'quality', 'workforce'], bio: 'Ran the Sevilla plant for six years; COO since 2024.',
    }),
    exec({
      id: 'CHR-GARNIER', name: 'Julien Garnier', title: 'Chief Sales & Marketing Officer', departmentId: 'DEP-SALES', reportsTo: 'ceo',
      skills: ['retail sales', 'pricing', 'dealer networks', 'brand'], expertise: ['sales', 'marketing', 'dealers', 'pricing', 'competitors'],
      objectives: ['Hit volume and market-share targets', 'Clear Vela stock without hurting residual values too visibly', 'Launch Eon with a big order bank'],
      incentives: 'Bonus on registrations and market share — not on margin.', riskTolerance: 70,
      personality: 'Charismatic, optimistic, competitive. Instinctively reaches for discounts and marketing. Rivalry with the CFO.',
      communicationStyle: 'Energetic, anecdotal, quotes dealer conversations; tends to round numbers in his favour.',
      trustInCeo: 65, authority: auth(3, 0, ['change_price'], 'Sets tactical incentives within ±3% of approved prices; spend up to €3m.'),
      privateInfo: [{ id: 'PI-GAR-1', fact: 'French dealers are sitting on ~70 days of Vela stock; he has been pushing registrations through demo cars to flatter the numbers.', revealAtTrust: 55 }],
      knowledgeScope: ['sales', 'market', 'dealers', 'products', 'competitors'], bio: 'Built Asterion’s French retail network; previously at a premium German brand.',
    }),
    exec({
      id: 'CHR-OKAFOR', name: 'Amara Okafor', title: 'Chief People Officer', departmentId: 'DEP-CORP', reportsTo: 'ceo',
      skills: ['labour law', 'collective bargaining', 'organisation design'], expertise: ['people', 'unions', 'workforce', 'restructuring'],
      objectives: ['Close the 2027 wage agreement without a strike', 'Staff the Brno Eon ramp-up', 'Stop engineering attrition at Brno'],
      incentives: 'Bonus on engagement and avoided labour disruption.', riskTolerance: 40,
      personality: 'Diplomatic, patient, reads people well. Will warn the CEO bluntly if a promise to the union cannot be kept.',
      communicationStyle: 'Calm, structured, frames issues in terms of trust and process.',
      trustInCeo: 58, authority: auth(2, 0, ['hire_staff'], 'Manages hiring within approved headcount; spend up to €2m.'),
      privateInfo: [{ id: 'PI-OKA-1', fact: 'Union leadership faces an internal election in June; Novak needs a visible win and would value a job guarantee more than headline pay.', revealAtTrust: 50 }],
      knowledgeScope: ['people', 'workforce', 'union', 'company'], bio: 'Former head of employee relations at a European rail operator.',
    }),
    exec({
      id: 'CHR-LINDQVIST', name: 'Henrik Lindqvist', title: 'Chief Procurement Officer', departmentId: 'DEP-CORP', reportsTo: 'ceo',
      skills: ['supplier negotiation', 'cost engineering', 'supply risk'], expertise: ['suppliers', 'purchasing', 'contracts', 'batteries'],
      objectives: ['Secure Eon battery volume without overpaying', 'Qualify a second battery source', 'Reduce material cost by 2%'],
      incentives: 'Bonus on purchase-price variance.', riskTolerance: 50,
      personality: 'Hard-nosed, transactional, enjoys a negotiation. Former Voltaris executive — knows their weak spots and has a personal friction with Sund.',
      communicationStyle: 'Dry, tactical, talks about leverage and alternatives.',
      trustInCeo: 52, authority: auth(5, 0, ['negotiate_contract'], 'Negotiates supply contracts; signature above €5m requires CEO.'),
      privateInfo: [{ id: 'PI-LIN-1', fact: "Voltaris's lenders gave them until mid-2027 to show committed volumes; their claim of 'other customers' for the capacity is weak.", revealAtTrust: 50 }],
      knowledgeScope: ['suppliers', 'contracts', 'operations', 'negotiations'], bio: 'Spent eight years at Voltaris before joining Asterion in 2023.',
    }),
    exec({
      id: 'CHR-FERRER', name: 'Lucía Ferrer', title: 'Eon Programme Director', departmentId: 'DEP-BEC', reportsTo: 'CHR-WIERZBICKI',
      skills: ['programme management', 'vehicle launch', 'supplier integration'], expertise: ['eon', 'projects', 'engineering'],
      objectives: ['Deliver Eon SOP as close to 1 October 2027 as possible', 'Get more engineers', 'Keep the team motivated'],
      incentives: 'Bonus on SOP date.', riskTolerance: 65, stress: 70,
      personality: 'Energetic, optimistic under pressure, tends to say yes to dates and then fight for resources. Respected by her team.',
      communicationStyle: 'Fast, upbeat, lists what she needs; becomes defensive if her team is blamed.',
      trustInCeo: 62, authority: auth(1, 0, [], 'Manages the programme within approved budget and staffing.'),
      privateInfo: [{ id: 'PI-FER-1', fact: "Her team's internal P50 for SOP is late November 2027; the official 1 October date has roughly 20% confidence.", revealAtTrust: 50 }],
      knowledgeScope: ['eon', 'projects', 'engineering'], bio: 'Launched two vehicles at a Spanish OEM before joining Asterion.',
    }),
    exec({
      id: 'CHR-LAURENT', name: 'Sophie Laurent', title: 'General Counsel', departmentId: 'DEP-CORP', reportsTo: 'ceo',
      skills: ['corporate law', 'contracts', 'regulatory', 'governance'], expertise: ['legal', 'contracts', 'regulation', 'governance'],
      objectives: ['Keep the company compliant (Euro 7, CO₂, type approval)', 'No contractual surprises in refinancing', 'Board governance'],
      incentives: 'Fixed pay; reputation for no surprises.', riskTolerance: 15,
      personality: 'Careful, exact, quietly influential with the chair.', communicationStyle: 'Formal, enumerates conditions and approvals.',
      trustInCeo: 60, authority: auth(1, 0, [], 'Advises; no spending authority beyond legal fees.'),
      privateInfo: [{ id: 'PI-LAU-1', fact: 'The EIB loan agreement allows the lender to demand prepayment if Eon production at Brno has not started by 31 March 2028.', revealAtTrust: 0 }],
      knowledgeScope: ['legal', 'contracts', 'regulation', 'board', 'debt'], bio: 'Former partner at a Paris law firm.',
    }),
    board({
      id: 'CHR-DUBREUIL', name: 'Charlotte Dubreuil', title: 'Chair of the Board (independent)',
      skills: ['governance', 'turnarounds', 'telecoms'], expertise: ['board', 'strategy', 'governance'],
      objectives: ['A credible turnaround plan', 'No surprises', 'Protect the company’s independence'],
      incentives: 'Reputation; was instrumental in hiring the CEO.', riskTolerance: 40,
      personality: 'Measured, demanding, values candour and early warnings above good news.', communicationStyle: 'Polite, probing, expects written plans.',
      trustInCeo: 55, authority: auth(0, 0, [], 'Chairs the board; casting vote in ties.'),
      privateInfo: [{ id: 'PI-DUB-1', fact: 'Two directors privately question whether the Eon can be saved without an equity raise.', revealAtTrust: 60 }],
      knowledgeScope: ['board', 'finance', 'company'], boardPrefs: { liquidity: 0.3, profitability: 0.25, growth: 0.1, ev: 0.15, jobs: 0.05, dilution: 0.05, risk: 0.2 }, bio: 'Former CEO of a European telecoms group; chair since 2024.',
    }),
    board({
      id: 'CHR-HALVORSEN', name: 'Erik Halvorsen', title: 'Director — Halvorsen Family Holdings (28%)',
      skills: ['long-term investing', 'industrial holdings'], expertise: ['shareholders', 'strategy'],
      objectives: ['Avoid dilution of the family stake', 'Long-term value through electrification'],
      incentives: 'Family wealth concentrated in Asterion shares.', riskTolerance: 55,
      personality: 'Patient, proud, allergic to dilution, sentimental about the Lyon plant his grandfather opened.', communicationStyle: 'Courteous, speaks in decades, not quarters.',
      trustInCeo: 50, authority: auth(0, 0, [], 'Board vote; family holding controls 28% of shares.'),
      privateInfo: [{ id: 'PI-HAL-1', fact: 'The family could provide a shareholder loan of up to €150m on commercial terms, but would refuse a deeply discounted rights issue.', revealAtTrust: 60 }],
      knowledgeScope: ['board', 'company', 'shareholders'], boardPrefs: { liquidity: 0.15, profitability: 0.2, growth: 0.1, ev: 0.2, jobs: 0.1, dilution: 0.35, risk: 0.05 }, bio: 'Third-generation head of the founding family’s holding company.',
    }),
    board({
      id: 'CHR-VOGEL', name: 'Dr. Ingrid Vogel', title: 'Independent Director, Audit Committee Chair',
      skills: ['accounting', 'risk', 'auditing'], expertise: ['finance', 'audit', 'risk'],
      objectives: ['Covenant compliance', 'Conservative forecasts'], incentives: 'Personal liability as audit chair.', riskTolerance: 15,
      personality: 'Rigorous, conservative, distrusts optimistic forecasts.', communicationStyle: 'Asks for sensitivities and downside cases.',
      trustInCeo: 48, authority: auth(0, 0, [], 'Board vote; chairs audit committee.'), privateInfo: [],
      knowledgeScope: ['board', 'finance'], boardPrefs: { liquidity: 0.35, profitability: 0.25, growth: 0.05, ev: 0.05, jobs: 0.05, dilution: 0.05, risk: 0.3 }, bio: 'Former CFO of a listed chemicals company.',
    }),
    board({
      id: 'CHR-ROSSI', name: 'Paolo Rossi', title: 'Independent Director',
      skills: ['manufacturing', 'automotive'], expertise: ['operations', 'product'],
      objectives: ['A competitive product line-up', 'Operational excellence'], incentives: 'Reputation in the industry.', riskTolerance: 55,
      personality: 'Car guy. Supports bold product moves if engineering backs them.', communicationStyle: 'Warm, technical, impatient with finance-only arguments.',
      trustInCeo: 56, authority: auth(0, 0, [], 'Board vote.'), privateInfo: [],
      knowledgeScope: ['board', 'products', 'operations'], boardPrefs: { liquidity: 0.15, profitability: 0.15, growth: 0.25, ev: 0.25, jobs: 0.1, dilution: 0.05, risk: 0.05 }, bio: 'Former head of manufacturing at an Italian OEM.',
    }),
    board({
      id: 'CHR-DUVAL', name: 'Jean-Marc Duval', title: 'Director — Fonds Stratégique Européen (12%)',
      skills: ['public investment', 'industrial policy'], expertise: ['government', 'jobs', 'electrification'],
      objectives: ['Keep manufacturing jobs in Europe', 'Accelerate electrification'], incentives: 'Political accountability for the fund’s investment.', riskTolerance: 45,
      personality: 'Political, cautious about layoffs, supportive of EV investment.', communicationStyle: 'Diplomatic; references ministers and public opinion.',
      trustInCeo: 52, authority: auth(0, 0, [], 'Board vote; state-linked fund holds 12%.'), privateInfo: [],
      knowledgeScope: ['board', 'company', 'government'], boardPrefs: { liquidity: 0.1, profitability: 0.1, growth: 0.15, ev: 0.25, jobs: 0.35, dilution: 0.0, risk: 0.05 }, bio: 'Senior official seconded from the economy ministry to the fund.',
    }),
    board({
      id: 'CHR-PETIT', name: 'Claire Petit', title: 'Employee Representative Director',
      skills: ['labour relations', 'shop-floor knowledge'], expertise: ['workforce', 'jobs'],
      objectives: ['Protect jobs and working conditions'], incentives: 'Elected by employees.', riskTolerance: 35,
      personality: 'Principled, close to the works council, but pragmatic about the company’s survival.', communicationStyle: 'Plain-spoken.',
      trustInCeo: 46, authority: auth(0, 0, [], 'Board vote.'), privateInfo: [],
      knowledgeScope: ['board', 'workforce', 'union'], boardPrefs: { liquidity: 0.1, profitability: 0.05, growth: 0.1, ev: 0.1, jobs: 0.6, dilution: 0.0, risk: 0.05 }, bio: 'Quality technician at Lyon for 18 years.',
    }),
    ext({
      id: 'CHR-NOVAK', name: 'Dragan Novak', title: 'Secretary-General, United Metalworkers’ Confederation (European Works Council lead)', org: 'union', orgName: 'United Metalworkers’ Confederation',
      skills: ['collective bargaining', 'mobilisation'], expertise: ['union', 'workforce', 'wages'],
      objectives: ['Real wage increase above inflation', 'Job guarantees for Lyon', 'Win the June union election'],
      incentives: 'Re-election; credibility with members.', riskTolerance: 60,
      personality: 'Tough, theatrical in public, pragmatic in private. Remembers every broken promise.', communicationStyle: 'Rhetorical, appeals to fairness and history.',
      trustInCeo: 40, authority: auth(0, 0, [], 'Can sign the collective agreement after a members’ ballot.'),
      privateInfo: [{ id: 'PI-NOV-1', fact: 'He would accept around 3.8% plus a job guarantee for Lyon to 2030, but cannot say so publicly before the ballot.', revealAtTrust: 60 }],
      knowledgeScope: ['union', 'workforce', 'public'], bio: 'Former welder at Brno; union official for 20 years.',
    }),
    ext({
      id: 'CHR-FONTAINE', name: 'Isabelle Fontaine', title: 'Managing Director, Corporate Banking — Banque Continentale', org: 'bank', orgName: 'Banque Continentale',
      skills: ['leveraged finance', 'syndication'], expertise: ['debt', 'refinancing', 'covenants'],
      objectives: ['Protect the bank’s exposure', 'Win the refinancing mandate on good terms'], incentives: 'Fees and credit quality of her book.', riskTolerance: 35,
      personality: 'Professional, friendly, unsentimental about credit metrics.', communicationStyle: 'Polished; talks in leverage multiples and term sheets.',
      trustInCeo: 55, authority: auth(0, 0, [], 'Can propose terms; credit committee approves.'),
      privateInfo: [{ id: 'PI-FON-1', fact: 'The bank would support up to ~1.0x EBITDA of new senior debt if leverage stays below 3.25x and the Eon has a credible SOP.', revealAtTrust: 45 }],
      knowledgeScope: ['debt', 'public', 'finance_public'], bio: 'Agent bank lead on Asterion’s term loan and RCF.',
    }),
    ext({
      id: 'CHR-SUND', name: 'Mikael Sund', title: 'CEO, Voltaris Cells', org: 'supplier', orgName: 'Voltaris Cells',
      skills: ['battery manufacturing', 'deal-making'], expertise: ['batteries', 'voltaris'],
      objectives: ['Fund a second module line', 'Lock in a take-or-pay commitment', 'Raise prices'], incentives: 'Company survival; equity stake.', riskTolerance: 70,
      personality: 'Confident, persuasive, prone to bluffing about alternative customers.', communicationStyle: 'Visionary sales pitch, then hard numbers.',
      trustInCeo: 50, authority: auth(0, 0, [], 'Signs for Voltaris.'),
      privateInfo: [{ id: 'PI-SUN-1', fact: 'Without Asterion’s prepayment Voltaris cannot finance the expansion; his walk-away prepayment is around €40m.', revealAtTrust: 80 }],
      knowledgeScope: ['voltaris', 'batteries', 'public'], bio: 'Co-founder of Voltaris.',
    }),
    ext({
      id: 'CHR-HARTMANN', name: 'Dieter Hartmann', title: 'Sales Director, Hanseatic Power Systems', org: 'supplier', orgName: 'Hanseatic Power Systems',
      skills: ['key account management'], expertise: ['hybrid systems', 'battery modules'],
      objectives: ['Protect the Kora business', 'Win Eon second-source business'], incentives: 'Sales bonus.', riskTolerance: 45,
      personality: 'Courteous, defensive about quality issues.', communicationStyle: 'Formal German business style.',
      trustInCeo: 55, authority: auth(0, 0, [], 'Signs commercial terms up to framework limits.'),
      privateInfo: [{ id: 'PI-HAR-1', fact: 'Hanseatic changed capacitor sub-supplier in 2025 and its own engineers suspect that batch.', revealAtTrust: 70 }],
      knowledgeScope: ['hanseatic', 'public'], bio: 'Account lead for Asterion since 2019.',
    }),
    ext({
      id: 'CHR-VERBEEK', name: 'Dr. Annelies Verbeek', title: 'Head of Type Approval, European Vehicle Certification Agency', org: 'regulator', orgName: 'European Vehicle Certification Agency',
      skills: ['homologation', 'regulation'], expertise: ['type approval', 'euro 7', 'co2'],
      objectives: ['Rigorous, impartial certification'], incentives: 'Institutional integrity.', riskTolerance: 10,
      personality: 'Courteous, strictly by the book; cannot be persuaded to cut corners, but values early, transparent engagement.', communicationStyle: 'Formal, procedural.',
      trustInCeo: 50, authority: auth(0, 0, [], 'Allocates certification slots; grants type approval.'),
      privateInfo: [], knowledgeScope: ['regulation', 'public'], bio: 'Career regulator.',
    }),
    ext({
      id: 'CHR-BELLINI', name: 'Marco Bellini', title: 'President, Asterion European Dealer Council', org: 'dealer', orgName: 'Asterion Dealer Council',
      skills: ['retail', 'dealer economics'], expertise: ['dealers', 'retail', 'stock'],
      objectives: ['Reduce Vela stock in the network', 'Higher dealer margin on Eon', 'Support for demo-car costs'], incentives: 'Owns six dealerships.', riskTolerance: 50,
      personality: 'Gregarious, loud, a good ally if listened to.', communicationStyle: 'Emotional, anecdotal, threatens to go public.',
      trustInCeo: 45, authority: auth(0, 0, [], 'Represents dealers; no authority over Asterion.'),
      privateInfo: [], knowledgeScope: ['dealers', 'public'], bio: 'Dealer principal in northern Italy; council president since 2023.',
    }),
    ext({
      id: 'CHR-WESTBROOK', name: 'Olivia Westbrook', title: 'Lead Analyst, Meridian Ratings', org: 'investor', orgName: 'Meridian Ratings',
      skills: ['credit analysis'], expertise: ['ratings', 'credit'], objectives: ['An accurate rating'], incentives: 'Analytical reputation.', riskTolerance: 30,
      personality: 'Neutral, analytical.', communicationStyle: 'Asks about leverage, liquidity and refinancing plans.',
      trustInCeo: 50, authority: auth(0, 0, [], 'Rating committee member.'), privateInfo: [],
      knowledgeScope: ['public', 'finance_public'], bio: 'Covers European autos at Meridian Ratings (Asterion: BB, outlook negative).',
    }),
  ];
  const r = (id: string, fromId: string, toId: string, kind: Relationship['kind'], strength: number, note: string): Relationship => ({ id, fromId, toId, kind, strength, note });
  const relationships: Relationship[] = [
    r('REL-01', 'CHR-HOLM', 'CHR-GARNIER', 'rival', -35, 'Long-running dispute over discounting and marketing budgets.'),
    r('REL-02', 'CHR-FERRER', 'CHR-WIERZBICKI', 'reports_to', 40, 'Respect, but he worries she over-promises dates.'),
    r('REL-03', 'CHR-OKAFOR', 'CHR-NOVAK', 'professional', 35, 'Constructive working relationship built over two wage rounds.'),
    r('REL-04', 'CHR-LINDQVIST', 'CHR-SUND', 'distrust', -25, 'Former colleagues; parted badly in 2023.'),
    r('REL-05', 'CHR-DUBREUIL', 'CHR-HALVORSEN', 'ally', 30, 'The chair needs the family’s support for any capital decision.'),
    r('REL-06', 'CHR-HOLM', 'CHR-VOGEL', 'ally', 40, 'Holm briefs the audit chair directly.'),
    r('REL-07', 'CHR-GARNIER', 'CHR-BELLINI', 'ally', 35, 'Garnier built the dealer council.'),
    r('REL-08', 'CHR-HALVORSEN', 'CHR-DUVAL', 'rival', -15, 'Family and state fund disagree on dilution and jobs.'),
    r('REL-09', 'CHR-PETIT', 'CHR-NOVAK', 'ally', 50, 'Both from the works council.'),
    r('REL-10', 'CHR-MARCHETTI', 'CHR-WIERZBICKI', 'professional', 20, 'Friction over late engineering changes hitting the plants.'),
    r('REL-11', 'CHR-WIERZBICKI', 'CHR-GARNIER', 'distrust', -20, 'Garnier keeps promising dealers Eon dates engineering has not confirmed.'),
    r('REL-12', 'CHR-FONTAINE', 'CHR-HOLM', 'professional', 45, 'Holm is the bank’s main point of contact.'),
  ];
  return { characters, relationships };
}

function projects(): { projects: Project[]; milestones: Milestone[] } {
  const projects: Project[] = [
    {
      id: 'PRJ-EON', code: 'EON', name: 'Eon electric crossover programme', kind: 'vehicle_program',
      objective: 'Launch the Asterion Eon BEV crossover from Brno at 300 vehicles/day.',
      scope: 'E-Flex platform derivative, 77 kWh Voltaris pack, Kessler e-drive, Brno line 2 conversion, EU type approval.',
      sponsorId: 'CHR-WIERZBICKI', managerId: 'CHR-FERRER', departmentId: 'DEP-BEC', status: 'delayed', priority: 'critical',
      startDate: '2023-04-01', originalTargetDate: '2027-03-01', targetDate: '2027-10-01', forecastDate: null, forecastP80Date: null,
      budgetCents: C(1_150), originalBudgetCents: C(950), spentCents: C(795), externalSpentCents: C(640), internalCostCents: C(155), committedCents: C(120),
      staffingFte: 1_150, baseFte: 1_150, productivity: 1, capitalizeExternal: 1, externalAccrualCents: 0,
      acceptanceCriteria: ['EU type approval granted', 'PPAP passed for all critical parts incl. battery pack', 'Pre-series quality audit ≥ 92%', 'Battery supply secured for ≥ 250 packs/day'],
      dependencies: ['Voltaris volume agreement or second battery source', 'Brno line conversion (tooling delivery from June 2027)', 'EVCA homologation slot (from 12 July 2027)'],
      linkedModelId: 'MDL-EON', templateKey: null, completionEffects: [{ type: 'model_launch', modelId: 'MDL-EON' }],
      risks: [
        { text: 'Thermal-propagation validation may require pack redesign', likelihood: 'medium', impact: 'high' },
        { text: 'Voltaris cannot fund capacity expansion without commitments', likelihood: 'high', impact: 'high' },
        { text: 'Brno cannot recruit enough operators for two-shift ramp-up', likelihood: 'medium', impact: 'medium' },
      ],
      lastDecision: 'Oct 2026: board accepted slip of SOP from 1 March to 1 October 2027 and a €200m budget increase.', completedDate: null,
      description: "Asterion's first dedicated BEV and the core of the turnaround plan. Already €200m over its original budget and seven months late.",
    },
    {
      id: 'PRJ-KORA-MY28', code: 'KMY28', name: 'Kora model-year 2028 update', kind: 'vehicle_program',
      objective: 'Refresh Kora infotainment, ADAS and exterior; certify to Euro 7.', scope: 'Software and trim update, Euro 7 emissions calibration, new wheels/lights.',
      sponsorId: 'CHR-GARNIER', managerId: 'CHR-WIERZBICKI', departmentId: 'DEP-LTC', status: 'active', priority: 'high',
      startDate: '2026-06-01', originalTargetDate: '2027-08-31', targetDate: '2027-08-31', forecastDate: null, forecastP80Date: null,
      budgetCents: C(60), originalBudgetCents: C(60), spentCents: C(19), externalSpentCents: C(12), internalCostCents: C(7), committedCents: C(10),
      staffingFte: 180, baseFte: 180, productivity: 1, capitalizeExternal: 1, externalAccrualCents: 0,
      acceptanceCriteria: ['Euro 7 type approval for Kora', 'Appeal uplift validated in customer clinics'], dependencies: [],
      linkedModelId: 'MDL-KORA', templateKey: null,
      completionEffects: [{ type: 'model_appeal', modelId: 'MDL-KORA', delta: 4 }, { type: 'model_quality', modelId: 'MDL-KORA', delta: 2 }, { type: 'model_euro7', modelId: 'MDL-KORA' }],
      risks: [{ text: 'Engineering resources pulled to Eon', likelihood: 'medium', impact: 'medium' }],
      lastDecision: null, completedDate: null, description: 'Keeps the Kora competitive and registrable after Euro 7 applies to all new cars (29 Nov 2027).',
    },
    {
      id: 'PRJ-VELA-E7', code: 'VE7', name: 'Vela Euro 7 compliance', kind: 'vehicle_program',
      objective: 'Make the Vela registrable after 29 November 2027 (Euro 7 for all new cars).', scope: 'Exhaust after-treatment upgrade, OBM software, brake-particle compliance, re-homologation.',
      sponsorId: 'CHR-WIERZBICKI', managerId: 'CHR-MARCHETTI', departmentId: 'DEP-LTC', status: 'proposed', priority: 'high',
      startDate: START_DATE, originalTargetDate: '2027-10-29', targetDate: '2027-10-29', forecastDate: null, forecastP80Date: null,
      budgetCents: C(42), originalBudgetCents: C(42), spentCents: 0, externalSpentCents: 0, internalCostCents: 0, committedCents: 0,
      staffingFte: 160, baseFte: 160, productivity: 1, capitalizeExternal: 1, externalAccrualCents: 0,
      acceptanceCriteria: ['Euro 7 type approval for Vela'], dependencies: ['160 FTE from the Lyon Technical Centre'],
      linkedModelId: 'MDL-VELA', templateKey: 'vela_euro7', completionEffects: [{ type: 'model_euro7', modelId: 'MDL-VELA' }, { type: 'model_cost', modelId: 'MDL-VELA', deltaCents: eur(240) }],
      risks: [{ text: 'If not approved by ~March the Vela cannot be certified in time and sales must stop on 29 Nov 2027', likelihood: 'medium', impact: 'high' }],
      lastDecision: 'Awaiting CEO approval (budget €42m — within CEO authority).', completedDate: null,
      description: 'Without it, Vela sales must end on 29 November 2027. Alternatively, plan a Vela run-out and redeploy Lyon.',
    },
  ];
  const m = (x: Omit<Milestone, 'originalPlannedDate' | 'lateFlagged'> & { originalPlannedDate?: SimDate }): Milestone => ({ ...x, originalPlannedDate: x.originalPlannedDate ?? x.plannedDate, lateFlagged: 0 });
  const milestones: Milestone[] = [
    m({ id: 'MS-EON-1', projectId: 'PRJ-EON', seq: 1, name: 'Design freeze', description: 'Exterior, interior and platform design frozen.', workTotal: 1, workDone: 1, status: 'completed', plannedDate: '2025-05-31', completedDate: '2025-06-30', gates: [], externalCostCents: 0 }),
    m({ id: 'MS-EON-2', projectId: 'PRJ-EON', seq: 2, name: 'Validation prototypes (VP) built', description: '120 validation prototypes built and in test.', workTotal: 1, workDone: 1, status: 'completed', plannedDate: '2026-06-30', completedDate: '2026-09-18', gates: [], externalCostCents: 0 }),
    m({ id: 'MS-EON-3', projectId: 'PRJ-EON', seq: 3, name: 'Battery system validation', description: 'Pack abuse, thermal-propagation, crash and durability validation signed off.', workTotal: 70_000, workDone: 35_000, status: 'in_progress', plannedDate: '2027-03-15', originalPlannedDate: '2026-11-30', completedDate: null, gates: [{ type: 'issue_resolved', issueId: 'ISS-THERMAL' }], externalCostCents: C(40) }),
    m({ id: 'MS-EON-4', projectId: 'PRJ-EON', seq: 4, name: 'Supplier PPAP & volume readiness', description: 'Production part approval for all critical parts; battery supply secured for ≥250 packs/day.', workTotal: 32_000, workDone: 0, status: 'pending', plannedDate: '2027-05-31', originalPlannedDate: '2027-01-15', completedDate: null, gates: [{ type: 'supply_capacity', supplyIds: ['SPL-VOL-PACK'], minDaily: 250 }], externalCostCents: C(35) }),
    m({ id: 'MS-EON-5', projectId: 'PRJ-EON', seq: 5, name: 'Brno line conversion & tooling', description: 'Body shop, battery hall and final assembly tooling installed and commissioned.', workTotal: 50_000, workDone: 0, status: 'pending', plannedDate: '2027-07-30', originalPlannedDate: '2026-12-15', completedDate: null, gates: [{ type: 'not_before', date: '2027-06-01', reason: 'Tooling delivery from the press-line supplier' }], externalCostCents: C(180) }),
    m({ id: 'MS-EON-6', projectId: 'PRJ-EON', seq: 6, name: 'EU type approval', description: 'Homologation tests at the EVCA and certificate of conformity.', workTotal: 24_000, workDone: 0, status: 'pending', plannedDate: '2027-08-20', originalPlannedDate: '2027-01-31', completedDate: null, gates: [{ type: 'not_before', date: '2027-07-12', reason: 'Booked EVCA homologation test slot' }], externalCostCents: C(12) }),
    m({ id: 'MS-EON-7', projectId: 'PRJ-EON', seq: 7, name: 'Pre-series build & quality audit', description: '400 pre-series vehicles; quality audit ≥ 92%.', workTotal: 42_000, workDone: 0, status: 'pending', plannedDate: '2027-09-15', originalPlannedDate: '2027-02-15', completedDate: null, gates: [], externalCostCents: C(45) }),
    m({ id: 'MS-EON-8', projectId: 'PRJ-EON', seq: 8, name: 'Start of production (SOP)', description: 'Series production starts; ramp-up to 300/day over ~10 weeks.', workTotal: 16_000, workDone: 0, status: 'pending', plannedDate: '2027-10-01', originalPlannedDate: '2027-03-01', completedDate: null, gates: [], externalCostCents: C(25) }),
    m({ id: 'MS-KMY-1', projectId: 'PRJ-KORA-MY28', seq: 1, name: 'Software & ADAS release', description: 'Infotainment and ADAS software release candidate.', workTotal: 14_000, workDone: 9_500, status: 'in_progress', plannedDate: '2027-02-26', completedDate: null, gates: [], externalCostCents: C(12) }),
    m({ id: 'MS-KMY-2', projectId: 'PRJ-KORA-MY28', seq: 2, name: 'Euro 7 calibration & homologation', description: 'Emissions calibration and Euro 7 type approval.', workTotal: 16_000, workDone: 0, status: 'pending', plannedDate: '2027-06-15', completedDate: null, gates: [], externalCostCents: C(14) }),
    m({ id: 'MS-KMY-3', projectId: 'PRJ-KORA-MY28', seq: 3, name: 'MY28 production start', description: 'Running change in Sevilla and Brno.', workTotal: 8_000, workDone: 0, status: 'pending', plannedDate: '2027-08-31', completedDate: null, gates: [], externalCostCents: C(10) }),
    m({ id: 'MS-VE7-1', projectId: 'PRJ-VELA-E7', seq: 1, name: 'After-treatment & OBM engineering', description: 'Hardware and software changes for Euro 7.', workTotal: 14_000, workDone: 0, status: 'pending', plannedDate: '2027-06-30', completedDate: null, gates: [], externalCostCents: C(22) }),
    m({ id: 'MS-VE7-2', projectId: 'PRJ-VELA-E7', seq: 2, name: 'Euro 7 homologation', description: 'Re-certification of all Vela variants.', workTotal: 9_000, workDone: 0, status: 'pending', plannedDate: '2027-09-30', completedDate: null, gates: [], externalCostCents: C(9) }),
    m({ id: 'MS-VE7-3', projectId: 'PRJ-VELA-E7', seq: 3, name: 'Production running change', description: 'Lyon implements the Euro 7 Vela.', workTotal: 3_000, workDone: 0, status: 'pending', plannedDate: '2027-10-29', completedDate: null, gates: [], externalCostCents: C(3) }),
  ];
  return { projects, milestones };
}

function issues(): Issue[] {
  const base = { chosenOptions: [] as string[], resolvedDate: null, resolutionNote: null };
  return [
    {
      ...base, id: 'ISS-THERMAL', kind: 'eon_thermal', title: 'Eon battery thermal-propagation validation incomplete',
      description: 'Thermal-propagation tests on the Voltaris pack have not passed. Until they do, battery system validation cannot be signed off. Part of the Eon team is tied up on root-cause work.',
      severity: 'high', ownerId: 'CHR-WIERZBICKI', discoveredDate: '2026-11-20', status: 'open', nextAction: 'Decide whether to buy external test capacity or redesign the module barrier.', deadline: '2027-03-15',
      linked: [{ type: 'project', id: 'PRJ-EON' }, { type: 'supplier', id: 'SUP-VOLTARIS' }, { type: 'model', id: 'MDL-EON' }], projectId: 'PRJ-EON', drag: 0.25, resolutionWorkTotal: 26_000, resolutionWorkDone: 0,
      options: [
        { key: 'external_lab', label: 'Book external abuse-test capacity', description: 'Rent two additional thermal chambers at an accredited lab for 4 months.', costCents: C(6), effects: [{ type: 'spend', amountCents: C(6), account: '6400' }, { type: 'reduce_work', pct: 0.3 }], tradeoffs: 'Faster test throughput; does not fix a design weakness if one exists.' },
        { key: 'barrier_redesign', label: 'Redesign inter-module thermal barrier', description: 'Add mica barriers and a revised venting path; re-test.', costCents: C(14), effects: [{ type: 'spend', amountCents: C(14), account: '1600', capitalize: true }, { type: 'reduce_work', pct: 0.15 }, { type: 'risk_factor', factor: 0.3 }, { type: 'model_cost', modelId: 'MDL-EON', deltaCents: eur(85) }], tradeoffs: 'Removes most of the risk of further test failures; adds €85 per pack.' },
        { key: 'conditional_signoff', label: 'Accept conditional sign-off', description: 'Sign off with documented residual risk and a field-monitoring plan.', costCents: 0, effects: [{ type: 'resolve' }, { type: 'quality', modelId: 'MDL-EON', delta: -6 }, { type: 'trust', characterId: 'CHR-WIERZBICKI', delta: -10 }], tradeoffs: 'Unblocks the milestone immediately; lowers launch quality and raises recall exposure. The CTO will object strongly.' },
      ],
      data: { riskFactor: 1 },
    },
    {
      ...base, id: 'ISS-EON-BMS', kind: 'eon_software', title: 'Battery-management software validation backlog',
      description: '1,900 open test cases on the BMS software; the Brno software team is short of 40 engineers.',
      severity: 'medium', ownerId: 'CHR-FERRER', discoveredDate: '2026-12-01', status: 'open', nextAction: 'Add capacity or accept a slower burn-down.', deadline: '2027-04-30',
      linked: [{ type: 'project', id: 'PRJ-EON' }], projectId: 'PRJ-EON', drag: 0.1, resolutionWorkTotal: 11_000, resolutionWorkDone: 0,
      options: [{ key: 'software_house', label: 'Contract an external software house', description: '60 contractors for 5 months.', costCents: C(4.5), effects: [{ type: 'spend', amountCents: C(4.5), account: '6400' }, { type: 'reduce_work', pct: 0.45 }], tradeoffs: 'Faster; knowledge leaves with the contractors.' }],
      data: {},
    },
    {
      ...base, id: 'ISS-VOLTARIS', kind: 'supply_volume', title: 'Voltaris cannot guarantee Eon volumes beyond 140 packs/day',
      description: 'The framework contract covers 140 packs/day. The Eon business case needs 250–300/day. Voltaris asks for a prepayment and a take-or-pay commitment to fund a second module line (lead time ~4 months after signature).',
      severity: 'critical', ownerId: 'CHR-LINDQVIST', discoveredDate: '2026-10-05', status: 'open', nextAction: 'Negotiate a volume amendment with Voltaris or qualify a second battery source.', deadline: '2027-03-31',
      linked: [{ type: 'supplier', id: 'SUP-VOLTARIS' }, { type: 'project', id: 'PRJ-EON' }, { type: 'negotiation', id: 'NEG-VOLTARIS' }, { type: 'supply', id: 'SPL-VOL-PACK' }], projectId: null, drag: 0, resolutionWorkTotal: 0, resolutionWorkDone: 0,
      options: [], data: {},
    },
    {
      ...base, id: 'ISS-KORA-INV', kind: 'kora_inverter', title: 'Kora hybrid inverter overheating — field reports',
      description: '37 field reports of inverter over-temperature shutdowns on 2025–2026 Kora. No injuries. Root cause not confirmed; Hanseatic denies a systematic defect.',
      severity: 'medium', ownerId: 'CHR-MARCHETTI', discoveredDate: '2026-12-10', status: 'open', nextAction: 'Investigate with Hanseatic, launch a service campaign, or monitor.', deadline: '2027-02-28',
      linked: [{ type: 'model', id: 'MDL-KORA' }, { type: 'supplier', id: 'SUP-HANSEATIC' }], projectId: null, drag: 0, resolutionWorkTotal: 0, resolutionWorkDone: 0,
      options: [
        { key: 'investigate', label: 'Root-cause investigation with Hanseatic', description: 'Joint task force, teardown of returned units, 6–8 weeks.', costCents: C(2.5), effects: [{ type: 'spend', amountCents: C(2.5), account: '6300' }, { type: 'investigate', workPerDay: 150 }, { type: 'set_status', status: 'investigating' }], tradeoffs: 'Establishes facts before committing to a costly campaign; incidents continue meanwhile.' },
        { key: 'service_campaign', label: 'Proactive service campaign (~62,000 vehicles)', description: 'Software update and inverter inspection at dealers.', costCents: C(38), effects: [{ type: 'provision', amountCents: C(38), account: '2450', label: 'Kora inverter service campaign' }, { type: 'quality', modelId: 'MDL-KORA', delta: 2 }, { type: 'trust', characterId: 'CHR-BELLINI', delta: 5 }, { type: 'resolve' }], tradeoffs: 'Expensive, but removes recall risk and protects the brand.' },
        { key: 'monitor', label: 'Monitor field data', description: 'No action beyond normal warranty handling.', costCents: 0, effects: [{ type: 'set_status', status: 'open' }], tradeoffs: 'Free now. If incidents keep rising, a regulator-mandated recall becomes likely.' },
      ],
      data: { incidents: 37, monitoredSince: START_DATE },
    },
    {
      ...base, id: 'ISS-DEALER-VELA', kind: 'dealer_stock', title: 'Vela dealer stock above target',
      description: 'Dealers hold ~58 days of Vela stock against a 45-day target, while Lyon builds faster than retail demand. Company stock is also building.',
      severity: 'medium', ownerId: 'CHR-GARNIER', discoveredDate: '2026-12-15', status: 'open', nextAction: 'Align the Lyon production rate with retail demand, or stimulate demand with pricing.', deadline: null,
      linked: [{ type: 'model', id: 'MDL-VELA' }, { type: 'line', id: 'LINE-LYON-VELA' }, { type: 'character', id: 'CHR-BELLINI' }], projectId: null, drag: 0, resolutionWorkTotal: 0, resolutionWorkDone: 0,
      options: [], data: { modelId: 'MDL-VELA' },
    },
    {
      ...base, id: 'ISS-REFI', kind: 'refinancing', title: '2028 bond (€900m) refinancing not started',
      description: 'The 4.25% senior notes mature on 15 November 2028. Cash and RCF alone cannot repay them while funding the Eon. Rating outlook is negative. The issue is resolved once at least €700m of new financing is secured.',
      severity: 'high', ownerId: 'CHR-HOLM', discoveredDate: '2026-09-30', status: 'open', nextAction: 'Prepare a refinancing plan for the April board (bank loan, bond, equity or asset sales).', deadline: '2027-04-22',
      linked: [{ type: 'debt', id: 'DEBT-BOND28' }, { type: 'character', id: 'CHR-FONTAINE' }], projectId: null, drag: 0, resolutionWorkTotal: 0, resolutionWorkDone: 0,
      options: [], data: { securedCents: 0 },
    },
    {
      ...base, id: 'ISS-LABOR', kind: 'labor_agreement', title: 'Collective wage agreement expires 31 March 2027',
      description: 'The union demands 6.0% plus job guarantees. The budget assumes 2.5%. Without an agreement, industrial action becomes likely from April.',
      severity: 'high', ownerId: 'CHR-OKAFOR', discoveredDate: '2026-11-01', status: 'open', nextAction: 'Negotiate with the union (Dragan Novak).', deadline: '2027-03-31',
      linked: [{ type: 'negotiation', id: 'NEG-UNION' }, { type: 'character', id: 'CHR-NOVAK' }, { type: 'contract', id: 'CON-LABOR-2025' }], projectId: null, drag: 0, resolutionWorkTotal: 0, resolutionWorkDone: 0,
      options: [], data: {},
    },
  ];
}

function debts(): { debts: DebtInstrument[]; covenants: Covenant[] } {
  const d = (x: Omit<DebtInstrument, 'principalDays' | 'undrawnDays' | 'interestPayableCents' | 'status'>): DebtInstrument => ({ ...x, principalDays: 0, undrawnDays: 0, interestPayableCents: 0, status: 'active' });
  const tlaAmort = ['2027-06-15', '2027-12-15', '2028-06-15', '2028-12-15', '2029-06-15', '2029-12-15', '2030-06-15'].map((date) => ({ date, amountCents: C(50) }));
  const eibAmort = ['2029-06-15', '2029-12-15', '2030-06-15', '2030-12-15'].map((date) => ({ date, amountCents: C(40) }));
  const debts: DebtInstrument[] = [
    d({ id: 'DEBT-BOND28', name: '4.25% Senior Notes due Nov 2028', kind: 'bond', lender: 'Bondholders', lenderCharacterId: null, principalCents: C(900), limitCents: C(900), rateBps: 425, commitmentFeeBps: 0, startDate: '2021-11-15', maturityDate: '2028-11-15', interestMonths: [5, 11], paymentDay: 15, amortization: [], secured: 0, conditions: ['Bullet repayment at maturity', 'Change-of-control put at 101%'] }),
    d({ id: 'DEBT-TLA', name: 'Term Loan A (bank syndicate)', kind: 'term_loan', lender: 'Banque Continentale (agent) & syndicate', lenderCharacterId: 'CHR-FONTAINE', principalCents: C(800), limitCents: C(800), rateBps: 500, commitmentFeeBps: 0, startDate: '2023-12-15', maturityDate: '2030-12-15', interestMonths: [3, 6, 9, 12], paymentDay: 15, amortization: tlaAmort, secured: 0, conditions: ['Net leverage ≤ 3.50x (quarterly)', 'Interest cover ≥ 3.0x (quarterly)', '€50m semi-annual amortisation'] }),
    d({ id: 'DEBT-SSD29', name: 'Schuldschein loan 2029', kind: 'private_placement', lender: 'Schuldschein investors', lenderCharacterId: null, principalCents: C(300), limitCents: C(300), rateBps: 480, commitmentFeeBps: 0, startDate: '2022-06-30', maturityDate: '2029-06-30', interestMonths: [6], paymentDay: 30, amortization: [], secured: 0, conditions: ['Bullet repayment'] }),
    d({ id: 'DEBT-EIB', name: 'EIB green loan (Eon programme)', kind: 'green_loan', lender: 'European Investment Bank', lenderCharacterId: null, principalCents: C(400), limitCents: C(400), rateBps: 310, commitmentFeeBps: 0, startDate: '2024-06-15', maturityDate: '2033-06-15', interestMonths: [6, 12], paymentDay: 15, amortization: eibAmort, secured: 0, conditions: ['Eon series production at Brno by 31 March 2028, otherwise the lender may demand prepayment', 'Minimum liquidity €400m'] }),
    d({ id: 'DEBT-RCF', name: '€500m Revolving Credit Facility', kind: 'rcf', lender: 'Banque Continentale (agent) & syndicate', lenderCharacterId: 'CHR-FONTAINE', principalCents: 0, limitCents: C(500), rateBps: 450, commitmentFeeBps: 55, startDate: '2024-03-31', maturityDate: '2029-03-31', interestMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], paymentDay: 28, amortization: [], secured: 0, conditions: ['Same covenants as Term Loan A', 'Drawdown not available while a covenant is in breach'] }),
  ];
  const covenants: Covenant[] = [
    { id: 'COV-LEV', name: 'Net leverage', instrumentIds: ['DEBT-TLA', 'DEBT-RCF'], metric: 'net_leverage', comparator: 'max', threshold: 3.5, lastTestDate: null, lastValue: null, status: 'compliant', waiverUntil: null, description: 'Net debt / LTM EBITDA ≤ 3.50x, tested at each quarter end.' },
    { id: 'COV-ICR', name: 'Interest cover', instrumentIds: ['DEBT-TLA', 'DEBT-RCF'], metric: 'interest_cover', comparator: 'min', threshold: 3.0, lastTestDate: null, lastValue: null, status: 'compliant', waiverUntil: null, description: 'LTM EBITDA / LTM net interest ≥ 3.0x, tested at each quarter end.' },
    { id: 'COV-LIQ', name: 'Minimum liquidity', instrumentIds: ['DEBT-EIB'], metric: 'min_liquidity', comparator: 'min', threshold: C(400), lastTestDate: null, lastValue: null, status: 'compliant', waiverUntil: null, description: 'Cash plus undrawn committed facilities ≥ €400m, tested at each quarter end.' },
  ];
  return { debts, covenants };
}

function contracts(): Contract[] {
  const c = (x: Omit<Contract, 'amendmentOf' | 'negotiationId' | 'obligations'> & { obligations?: Contract['obligations'] }): Contract => ({ amendmentOf: null, negotiationId: null, obligations: [], ...x });
  return [
    c({ id: 'CON-VOLTARIS', kind: 'supply', title: 'Voltaris battery-pack framework agreement', counterpartyId: 'CHR-SUND', counterpartyName: 'Voltaris Cells', status: 'active', terms: { dailyVolume: 140, priceEur: 9_200, prepaymentEur: 0, takeOrPayPct: 0, paymentTermsDays: 30 }, startDate: '2024-09-01', endDate: '2031-12-31', signedDate: '2024-09-01', valueCents: C(1_900), templateKey: 'voltaris_supply', summary: 'Up to 140 packs/day at €9,200. Volumes above 140/day "subject to a separate agreement". Asterion to confirm 2028 volume forecast by 31 March 2027.', obligations: [{ text: 'Confirm 2028 volume forecast to Voltaris', dueDate: '2027-03-31', status: 'open' }] }),
    c({ id: 'CON-HANSEATIC', kind: 'supply', title: 'Hanseatic hybrid module supply agreement', counterpartyId: 'CHR-HARTMANN', counterpartyName: 'Hanseatic Power Systems', status: 'active', terms: { priceEur: 3_100, paymentTermsDays: 45 }, startDate: '2022-01-01', endDate: '2028-12-31', signedDate: '2021-11-30', valueCents: C(2_600), templateKey: null, summary: 'Sole-source supply of Kora hybrid battery/inverter modules. Warranty recovery clause for systematic defects (cost-sharing up to 50%).' }),
    c({ id: 'CON-KESSLER', kind: 'supply', title: 'Kessler drivetrain supply agreement', counterpartyId: null, counterpartyName: 'Kessler Antriebstechnik', status: 'active', terms: { paymentTermsDays: 60 }, startDate: '2019-01-01', endDate: '2029-12-31', signedDate: '2018-10-01', valueCents: C(900), templateKey: null, summary: 'Vela transmissions and Eon e-drive units.' }),
    c({ id: 'CON-CORVIAN', kind: 'supply', title: 'Corvian ECU supply agreement', counterpartyId: null, counterpartyName: 'Corvian Microsystems', status: 'active', terms: { paymentTermsDays: 60 }, startDate: '2021-01-01', endDate: '2028-12-31', signedDate: '2020-11-15', valueCents: C(500), templateKey: null, summary: 'Electronic control units for all models; allocation clause in case of semiconductor shortage.' }),
    c({ id: 'CON-VALMONT', kind: 'supply', title: 'Valmont seating supply agreement', counterpartyId: null, counterpartyName: 'Valmont Interiors', status: 'active', terms: { paymentTermsDays: 60 }, startDate: '2020-01-01', endDate: '2029-12-31', signedDate: '2019-10-01', valueCents: C(700), templateKey: null, summary: 'Seats for all models.' }),
    c({ id: 'CON-LABOR-2025', kind: 'labor', title: 'Collective wage agreement 2025–2027', counterpartyId: 'CHR-NOVAK', counterpartyName: 'United Metalworkers’ Confederation', status: 'active', terms: { wageIncreasePct: 3.1 }, startDate: '2025-04-01', endDate: '2027-03-31', signedDate: '2025-03-20', valueCents: 0, templateKey: 'labor_agreement', summary: 'Expires 31 March 2027. Peace obligation (no strikes) while in force.' }),
    c({ id: 'CON-DEALER', kind: 'dealer', title: 'European dealer agreement', counterpartyId: 'CHR-BELLINI', counterpartyName: 'Asterion Dealer Council', status: 'active', terms: { dealerMarginPct: 9.5 }, startDate: '2023-01-01', endDate: '2028-12-31', signedDate: '2022-11-01', valueCents: 0, templateKey: null, summary: 'Dealer margin 9.5% of list price; Asterion supports demo cars.' }),
  ];
}

function regulations(): Regulation[] {
  return [
    { id: 'REG-CO2', name: 'EU fleet CO₂ standards for new cars', jurisdiction: 'EU', kind: 'co2_fleet', status: 'in_force', effectiveDate: '2025-01-01', description: 'Manufacturer-specific fleet average target (mass-adjusted, after averaging flexibilities). Excess emissions premium €95 per g/km per registered vehicle, payable the following April.', params: { target2027: 107, target2028: 103, target2029: 99, target2030: 72 } },
    { id: 'REG-EURO7', name: 'Euro 7 emissions standard', jurisdiction: 'EU', kind: 'type_approval', status: 'in_force', effectiveDate: '2026-11-29', description: 'Applies to new types from 29 Nov 2026 and to all newly registered cars from 29 Nov 2027. Non-compliant models can no longer be registered after that date.', params: { allNewCarsDate: '2027-11-29' } },
    { id: 'REG-EV-LEASE', name: 'Social leasing scheme for EVs (Germany, France)', jurisdiction: 'DE/FR', kind: 'subsidy', status: 'announced', effectiveDate: '2027-07-01', description: 'Subsidised EV leasing for lower-income households from 1 July 2027; expected to lift BEV demand in compact segments.', params: { bevPrefDelta: 0.03 } },
    { id: 'REG-TARIFF', name: 'EU countervailing duties review — Chinese BEVs', jurisdiction: 'EU', kind: 'trade', status: 'proposed', effectiveDate: '2027-11-15', description: 'The Commission decides on 15 Nov 2027 whether to raise duties on Chinese-built BEVs. Outcome uncertain (estimated ~60% likely).', params: { probability: 0.6, priceEffectPct: 0.08 } },
  ];
}

function commitments(): Commitment[] {
  return [
    { id: 'COM-001', promisorId: 'ceo', promiseeId: 'CHR-DUBREUIL', description: 'Present a refinancing plan for the 2028 bond to the board by the April meeting (a submitted bank-loan, bond or equity financing request counts).', dueDate: '2027-04-22', conditions: 'Inherited commitment made to the board in December 2026.', status: 'open', createdDate: '2026-12-10', source: 'scenario', sourceId: null, check: { type: 'deliver_plan', topic: 'refinancing' }, resolvedDate: null, notifiedUpcoming: 0, importance: 5 },
    { id: 'COM-002', promisorId: 'ceo', promiseeId: 'CHR-SUND', description: 'Confirm Asterion’s 2028 Eon volume forecast to Voltaris (contractual obligation).', dueDate: '2027-03-31', conditions: 'Framework agreement clause 7.2. Fulfilled by agreeing a volume amendment with Voltaris.', status: 'open', createdDate: '2024-09-01', source: 'scenario', sourceId: 'CON-VOLTARIS', check: { type: 'deliver_plan', topic: 'voltaris_volume' }, resolvedDate: null, notifiedUpcoming: 0, importance: 3 },
    { id: 'COM-003', promisorId: 'ceo', promiseeId: 'EIB', description: 'Start Eon series production at Brno by 31 March 2028 (EIB green-loan condition).', dueDate: '2028-03-31', conditions: 'Otherwise the EIB may demand prepayment of €400m.', status: 'open', createdDate: '2024-06-15', source: 'scenario', sourceId: 'DEBT-EIB', check: { type: 'project_completed_by', projectId: 'PRJ-EON' }, resolvedDate: null, notifiedUpcoming: 0, importance: 5 },
  ];
}

function negotiations(): Negotiation[] {
  const vt = NEGOTIATION_TEMPLATES.voltaris_supply;
  const ut = NEGOTIATION_TEMPLATES.labor_agreement;
  return [
    {
      id: 'NEG-VOLTARIS', templateKey: 'voltaris_supply', title: 'Voltaris volume & capacity amendment', counterpartyId: 'CHR-SUND', status: 'open',
      terms: vt.terms, reservation: { ...vt.defaultReservation }, ideal: { ...vt.defaultIdeal }, weights: { ...vt.weights }, baseThreshold: vt.baseThreshold, concessionPerRound: vt.concessionPerRound, maxRounds: vt.maxRounds,
      rounds: [{ n: 0, date: '2026-12-14', by: 'counterparty', terms: { ...vt.defaultIdeal }, message: 'Voltaris opening position (December 2026): 300 packs/day from four months after signature, at €9,650 per pack, with an €80m prepayment and 85% take-or-pay.', evaluation: null }],
      deadline: '2027-06-30', createdDate: '2026-12-14', agreedTerms: null, contractId: null, linkedIssueId: 'ISS-VOLTARIS', pendingDecision: null,
      context: 'Amendment to the framework agreement (CON-VOLTARIS) to raise Eon battery capacity. Voltaris needs funding for a second module line (lead time ~120 days after signature).',
    },
    {
      id: 'NEG-UNION', templateKey: 'labor_agreement', title: 'Collective wage agreement 2027–2029', counterpartyId: 'CHR-NOVAK', status: 'open',
      terms: ut.terms, reservation: { ...ut.defaultReservation }, ideal: { ...ut.defaultIdeal }, weights: { ...ut.weights }, baseThreshold: ut.baseThreshold, concessionPerRound: ut.concessionPerRound, maxRounds: ut.maxRounds,
      rounds: [{ n: 0, date: '2026-11-15', by: 'counterparty', terms: { ...ut.defaultIdeal }, message: 'Union claim (November 2026): 6.0% wage increase, €1,200 one-off payment, 48-month job guarantee for all plants.', evaluation: null }],
      deadline: '2027-04-30', createdDate: '2026-11-15', agreedTerms: null, contractId: null, linkedIssueId: 'ISS-LABOR', pendingDecision: null,
      context: 'Two-year wage agreement covering ~18,000 employees. The current agreement expires 31 March 2027; the peace obligation ends with it.',
    },
  ];
}

/** Build the FY2026 monthly history snapshots (pre-game, used for LTM covenant metrics). */
function history2026(): FinancialSnapshot[] {
  const out: FinancialSnapshot[] = [];
  const f = FY2026;
  for (let mth = 1; mth <= 12; mth++) {
    const period = `2026-${String(mth).padStart(2, '0')}`;
    const div = (x: Cents) => mulDiv(x, 1, 12);
    out.push({
      id: `M:${period}`, kind: 'month', period, date: `${period}-28`,
      data: {
        revenueCents: div(f.revenueCents), vehicleRevenueCents: div(f.vehicleRevenueCents), aftersalesRevenueCents: div(f.aftersalesRevenueCents),
        cogsCents: 0, grossProfitCents: 0, personnelCents: 0, otherOpexCents: 0,
        ebitdaCents: div(f.ebitdaCents), daCents: div(f.daCents), ebitCents: div(f.ebitCents), interestCents: div(f.interestCents), taxCents: div(f.taxCents), netIncomeCents: div(f.netIncomeCents),
        cashCents: C(1_200), debtCents: C(2_400), liquidityCents: C(1_700), operatingCfCents: 0, investingCfCents: 0, financingCfCents: 0,
        unitsProduced: Math.round(f.unitsProduced / 12), unitsWholesale: Math.round(f.unitsWholesale / 12), unitsRetail: Math.round(f.unitsRetail / 12), headcount: f.headcount,
      },
    });
  }
  return out;
}

export function unitMaterialCost(w: Pick<World, 'supplies'>, m: VehicleModel): Cents {
  const seen = new Set<string>();
  let c = m.otherMaterialCostCents;
  for (const s of w.supplies) {
    if (!s.modelIds.includes(m.id) || s.isAlternative) continue;
    if (seen.has(s.component)) continue;
    seen.add(s.component);
    c += s.unitPriceCents;
  }
  return c;
}

/**
 * Build the complete initial world, including the opening balance journal
 * entry. Does not touch the database.
 */
export function buildInitialWorld(seed = DEFAULT_SEED, scenarioKey = 'turnaround', difficulty: Difficulty = 'standard'): World {
  const scenario = scenarioOf(scenarioKey);
  const ctx: ScenarioBuildContext = { openingCashCents: C(1_200) };
  const { competitors: comps, products } = competitors();
  const { factories: facs, lines } = factories();
  const { suppliers: sups, supplies } = suppliers();
  const { characters: chars, relationships } = characters();
  const { projects: projs, milestones } = projects();
  const { debts: dbts, covenants } = debts();
  const macro: MacroState = { id: 'macro', gdpGrowthPct: 1.1, consumerConfidence: 98.5, ecbRatePct: 2.25, energyIndex: 1.0, batteryCostIndex: 1.0, creditSpreadBps: 310, shocks: [] };
  const meta: GameMeta = {
    id: 'game', companyName: 'Asterion Automotive', ceoName: 'You (CEO)', currentDate: START_DATE, startDate: START_DATE, seed, seq: 0, status: 'active', terminalReason: null,
    boardConfidence: 55, lowConfidenceMeetings: 0, ceoPersonalLiquidCents: C(2.8), ceoPersonalNetWorthCents: C(6.4), sharesOutstanding: 210_000_000, sharePriceCents: eur(11.2),
    creditRating: 'BB', ratingOutlook: 'negative', marketingMonthlyCents: C(8), gaMonthlyCents: C(6), sustainingCapexMonthlyCents: C(20), taxLossCarryforwardCents: 0, taxAccruedYtdCents: 0,
    co2ProvisionYtdCents: 0, co2UnitsYtd: 0, co2GramsYtd: 0, aftersalesParc: 2_200_000, wageIndex: 1, mtdByAccount: {}, ytdByAccount: {}, cfMtd: {},
    boardPlan: { eonSopDate: '2027-10-01', ebitTargetCents: C(210), minLiquidityCents: C(700), fiscalYear: 2027 },
    nextBoardMeeting: fourthThursday(2027, 1), extraordinaryMeeting: null, lastForecastSummary: null, liquidityStressDays: 0, missedPaymentDays: 0,
    legacyDepMonthlyCents: C(25), newPpeGrossCents: 0, amortizingDevCents: 0, forecastStale: 1, distributionUtility: -0.15, leaseMonthlyCents: 0, assetsSold: [], version: 1,
    scenarioKey: scenario.key, difficulty, termEndDate: '2029-12-31', mandate: null,
  };
  const w: World = {
    meta, macro, segments: segments(), models: models(), competitors: comps, competitorProducts: products, factories: facs, lines, suppliers: sups, supplies,
    departments: departments(), characters: chars, relationships, projects: projs, milestones, issues: issues(), commitments: commitments(),
    debts: dbts, covenants, receivables: [], payables: [], contracts: contracts(), negotiations: negotiations(), financing: [], boardProposals: [],
    regulations: regulations(), eventStates: [], balances: {}, snapshots: history2026(), out: emptyOutput(), mode: 'live', scenarioDemandFactor: 1,
  };

  // --- the starting scenario (before calibration and the opening balance sheet)
  scenario.apply?.(w, ctx);

  // --- calibrate demand so that starting retail volumes match FY2026 run-rates
  const calDate = '2027-06-01';
  const season = (segId: string) => w.segments.find((s) => s.id === segId)!.seasonality[5];
  const mf = 1 + (macro.consumerConfidence - 100) * 0.004;
  const chatch = w.segments.find((s) => s.id === 'SEG-CHATCH')!;
  const csuv = w.segments.find((s) => s.id === 'SEG-CSUV')!;
  const growthAt = (seg: Segment) => Math.pow(1 + seg.growthPerYear, diffDays(calDate, START_DATE) / 365.25);
  calibrateOtherUtility(w, 'SEG-CHATCH', 'MDL-VELA', 130_000 / 12 / (chatch.baseMonthlyUnits * season('SEG-CHATCH') * mf * growthAt(chatch)) * season('SEG-CHATCH'), calDate);
  calibrateOtherUtility(w, 'SEG-CSUV', 'MDL-KORA', 165_000 / 12 / (csuv.baseMonthlyUnits * season('SEG-CSUV') * mf * growthAt(csuv)) * season('SEG-CSUV'), calDate);

  scenario.afterCalibration?.(w);

  // --- inventory valuation at standard material cost
  for (const m of w.models) m.fgValueCents = m.fgUnits * unitMaterialCost(w, m);

  // --- opening receivables: last 30 days of dealer invoices + December aftersales
  const dailyWholesale = Math.round((130_000 * eur(18_900) + 165_000 * eur(28_400)) / 365);
  for (let i = 0; i < 30; i++) {
    const issue = addDays(OPENING_DATE, -29 + i);
    w.receivables.push({ id: `AR-OPEN-${String(i + 1).padStart(2, '0')}`, counterparty: 'Dealer network', amountCents: dailyWholesale, issueDate: issue, dueDate: addDays(issue, 30), status: 'open', settledDate: null, source: 'opening' });
  }
  const decAftersales = Math.round(2_200_000 * eur(16.5));
  w.receivables.push({ id: 'AR-OPEN-AS', counterparty: 'Dealer network (parts)', amountCents: decAftersales, issueDate: OPENING_DATE, dueDate: '2027-01-30', status: 'open', settledDate: null, source: 'opening' });

  // --- opening payables: trailing supplier invoices at each supplier's terms
  const perDay = { vela: 384, kora: 466 };
  const vela = w.models.find((m) => m.id === 'MDL-VELA')!;
  const kora = w.models.find((m) => m.id === 'MDL-KORA')!;
  const supplierDaily: Record<string, Cents> = {};
  for (const s of w.supplies) {
    if (s.modelIds.includes('MDL-VELA')) supplierDaily[s.supplierId] = (supplierDaily[s.supplierId] ?? 0) + perDay.vela * s.unitPriceCents;
    if (s.modelIds.includes('MDL-KORA')) supplierDaily[s.supplierId] = (supplierDaily[s.supplierId] ?? 0) + perDay.kora * s.unitPriceCents;
  }
  supplierDaily['SUP-TIER2'] = perDay.vela * vela.otherMaterialCostCents + perDay.kora * kora.otherMaterialCostCents;
  supplierDaily['SUP-LOGISTICS'] = perDay.vela * vela.logisticsPerUnitCents + perDay.kora * kora.logisticsPerUnitCents;
  let pseq = 0;
  const pushPayable = (p: Omit<Payable, 'id' | 'status' | 'paidDate'>) => {
    pseq += 1;
    w.payables.push({ id: `AP-OPEN-${String(pseq).padStart(4, '0')}`, status: 'open', paidDate: null, ...p });
  };
  for (const [supplierId, amt] of Object.entries(supplierDaily)) {
    const terms = w.suppliers.find((s) => s.id === supplierId)!.paymentTermsDays;
    for (let i = 0; i < terms; i++) {
      const issue = addDays(OPENING_DATE, -terms + 1 + i);
      pushPayable({ counterpartyId: supplierId, category: supplierId === 'SUP-LOGISTICS' ? 'other' : 'materials', amountCents: amt, issueDate: issue, dueDate: addDays(issue, terms), sourceId: 'opening', liabilityAccount: '2000' });
    }
  }
  const decInvoices: [string, Payable['category'], Cents][] = [
    ['VARIOUS', 'overhead', C(11)],
    ['VARIOUS', 'marketing', C(8)],
    ['VARIOUS', 'ga', C(6)],
    ['VARIOUS', 'capex', C(20)],
  ];
  for (const [cp, cat, amt] of decInvoices) pushPayable({ counterpartyId: cp, category: cat, amountCents: amt, issueDate: OPENING_DATE, dueDate: '2027-01-30', sourceId: 'opening', liabilityAccount: '2000' });
  pushPayable({ counterpartyId: 'TAX', category: 'tax', amountCents: C(9), issueDate: OPENING_DATE, dueDate: '2027-01-15', sourceId: 'opening', liabilityAccount: '2500' });

  // --- opening accrued interest per instrument (since last payment date)
  const lastPayment: Record<string, SimDate> = { 'DEBT-BOND28': '2026-11-15', 'DEBT-TLA': '2026-12-15', 'DEBT-SSD29': '2026-06-30', 'DEBT-EIB': '2026-12-15', 'DEBT-RCF': OPENING_DATE };
  let accrued = 0;
  for (const d of w.debts) {
    const days = diffDays(OPENING_DATE, lastPayment[d.id]);
    d.interestPayableCents = mulDiv(d.principalCents * days, d.rateBps, 10_000 * 365);
    accrued += d.interestPayableCents;
  }

  // --- opening balance sheet
  const ar = w.receivables.reduce((a, r) => a + r.amountCents, 0);
  const ap = w.payables.filter((p) => p.liabilityAccount === '2000').reduce((a, p) => a + p.amountCents, 0);
  const tax = w.payables.filter((p) => p.liabilityAccount === '2500').reduce((a, p) => a + p.amountCents, 0);
  const inv = w.models.reduce((a, m) => a + m.fgValueCents, 0);
  const debt = w.debts.reduce((a, d) => a + d.principalCents, 0);
  const obLines = [
    { account: '1000', amountCents: ctx.openingCashCents },
    { account: '1100', amountCents: ar },
    { account: '1200', amountCents: inv },
    { account: '1500', amountCents: C(6_200) },
    { account: '1510', amountCents: -C(3_300) },
    { account: '1600', amountCents: C(640) },
    { account: '2000', amountCents: -ap },
    { account: '2200', amountCents: -C(260) },
    { account: '2500', amountCents: -tax },
    { account: '2600', amountCents: -accrued },
    { account: '2700', amountCents: -debt },
    { account: '3000', amountCents: -C(1_450) },
  ];
  const plug = -obLines.reduce((a, l) => a + l.amountCents, 0);
  obLines.push({ account: '3100', amountCents: plug });
  post(w, { date: OPENING_DATE, description: 'Opening balance sheet at 31 December 2026', sourceType: 'opening', cf: { category: 'opening', line: 'opening_balance' }, lines: obLines });
  // Opening entry must not count as current-period P&L (it has no P&L lines anyway).
  w.meta.mtdByAccount = {};
  w.meta.ytdByAccount = {};
  w.meta.cfMtd = {};
  return w;
}

/** Brief of the default scenario (kept for compatibility; see scenarios.ts for all briefs). */
export const SCENARIO_BRIEF = `You are the new CEO of Asterion Automotive (Lyon), appointed with effect from 1 January 2027.
FY2026: revenue ≈ €7.5bn, operating margin ≈ 3.2%, 310,000 vehicles built, 18,000 employees.
Cash €1.2bn, gross debt €2.4bn (incl. a €900m bond due Nov 2028), undrawn €500m RCF.
The ageing Vela is losing ground and must be made Euro 7 compliant or run out by 29 Nov 2027; the Kora hybrid carries the company; the Eon electric crossover is late, over budget, short of battery supply and stuck in thermal validation.
The wage agreement expires on 31 March. The board meets on 28 January and expects a credible turnaround.`;
