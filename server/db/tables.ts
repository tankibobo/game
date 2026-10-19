/**
 * Table specifications for the authoritative world state. Each spec lists the
 * domain fields (camelCase) with their SQL type; columns are snake_case.
 * `JSON` columns hold arrays/objects. The SQL migrations in ./migrations were
 * generated from these specs (scripts/gen-migration.ts) and a test verifies
 * that the migrated schema still matches them.
 */

export type ColType = 'TEXT' | 'INTEGER' | 'REAL' | 'JSON';

export interface TableSpec {
  table: string;
  /** Key in the World object. */
  worldKey: string;
  single?: boolean;
  /** Rows filtered on load (e.g. only open payables). */
  loadWhere?: string;
  columns: [field: string, type: ColType, nullable?: boolean][];
}

const T = (s: string): TableSpec['columns'] =>
  s
    .trim()
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((c) => {
      const [f, t] = c.split(':');
      const nullable = t.endsWith('?');
      const type = t.replace('?', '').toUpperCase() as ColType;
      return [f, type, nullable];
    });

export const WORLD_TABLES: TableSpec[] = [
  {
    table: 'game_meta',
    worldKey: 'meta',
    single: true,
    columns: T(`id:text, companyName:text, ceoName:text, currentDate:text, startDate:text, seed:integer, seq:integer, status:text, terminalReason:text?,
      boardConfidence:real, lowConfidenceMeetings:integer, ceoPersonalLiquidCents:integer, ceoPersonalNetWorthCents:integer, sharesOutstanding:integer, sharePriceCents:integer,
      creditRating:text, ratingOutlook:text, marketingMonthlyCents:integer, gaMonthlyCents:integer, sustainingCapexMonthlyCents:integer, taxLossCarryforwardCents:integer,
      taxAccruedYtdCents:integer, co2ProvisionYtdCents:integer, co2UnitsYtd:integer, co2GramsYtd:real, aftersalesParc:integer, wageIndex:real,
      mtdByAccount:json, ytdByAccount:json, cfMtd:json, boardPlan:json, nextBoardMeeting:text, extraordinaryMeeting:text?, lastForecastSummary:json?,
      liquidityStressDays:integer, missedPaymentDays:integer, legacyDepMonthlyCents:integer, newPpeGrossCents:integer, amortizingDevCents:integer,
      forecastStale:integer, distributionUtility:real, leaseMonthlyCents:integer, assetsSold:json, version:integer,
      scenarioKey:text, difficulty:text, termEndDate:text, mandate:json?`),
  },
  {
    table: 'macro_state',
    worldKey: 'macro',
    single: true,
    columns: T(`id:text, gdpGrowthPct:real, consumerConfidence:real, ecbRatePct:real, energyIndex:real, batteryCostIndex:real, creditSpreadBps:real, shocks:json`),
  },
  {
    table: 'segments',
    worldKey: 'segments',
    columns: T(`id:text, name:text, baseMonthlyUnits:real, refPriceCents:integer, priceElasticity:real, seasonality:json, growthPerYear:real, powertrainPref:json, prefDriftPerYear:json, otherUtility:real, description:text`),
  },
  {
    table: 'vehicle_models',
    worldKey: 'models',
    columns: T(`id:text, name:text, segmentId:text, powertrain:text, status:text, lifecycle:text, launchDate:text?, netPriceCents:integer, listPriceCents:integer,
      baseAppeal:real, appealDecayPerYear:real, quality:real, satisfaction:real, co2Gkm:real, otherMaterialCostCents:integer, logisticsPerUnitCents:integer, warrantyPerUnitCents:integer,
      fgUnits:integer, fgValueCents:integer, dealerStock:integer, backlog:integer, inTransit:integer, retailMtd:integer, wholesaleMtd:integer, productionMtd:integer,
      retailLastMonth:integer, wholesaleLastMonth:integer, productionLastMonth:integer, lostSalesMtd:integer, cumulativeRetail:integer, fgUnitDaysMtd:integer, euro7Compliant:integer,
      demandModifier:real, demandModifierUntil:text?, projectId:text?, description:text`),
  },
  {
    table: 'competitors',
    worldKey: 'competitors',
    columns: T(`id:text, name:text, origin:text, strategy:text, financialHealth:real, evCapability:real, aggressiveness:real, description:text`),
  },
  {
    table: 'competitor_products',
    worldKey: 'competitorProducts',
    columns: T(`id:text, competitorId:text, segmentId:text, name:text, powertrain:text, priceCents:integer, appeal:real, quality:real, status:text, launchDate:text?, devProgress:real, devRatePerDay:real, lastPriceChange:text?`),
  },
  {
    table: 'factories',
    worldKey: 'factories',
    columns: T(`id:text, name:text, location:text, country:text, departmentId:text, status:text, fixedOverheadMonthlyCents:integer, absenteeismPct:real, fixedCrew:real, crewPerDailyUnit:real, downtime:json, description:text`),
  },
  {
    table: 'production_lines',
    worldKey: 'lines',
    columns: T(`id:text, factoryId:text, modelId:text, name:text, maxDailyRate:integer, plannedDailyRate:integer, status:text, rampStartDate:text?, rampDays:integer`),
  },
  {
    table: 'suppliers',
    worldKey: 'suppliers',
    columns: T(`id:text, name:text, country:text, category:text, reliability:real, qualityScore:real, financialHealth:real, relationship:real, paymentTermsDays:integer, contactId:text?, description:text`),
  },
  {
    table: 'component_supplies',
    worldKey: 'supplies',
    columns: T(`id:text, supplierId:text, component:text, modelIds:json, unitPriceCents:integer, dailyCapacity:integer, stockUnits:integer, targetStockDays:real, disruptionFactor:real, disruptionUntil:text?, pendingCapacity:json, contractId:text?, isAlternative:integer`),
  },
  {
    table: 'departments',
    worldKey: 'departments',
    columns: T(`id:text, name:text, kind:text, factoryId:text?, headId:text?, headcount:integer, annualCostPerHeadCents:integer, headcountDays:integer, morale:real, attritionPctYear:real, hiring:json, leaving:json, expenseAccount:text, description:text`),
  },
  {
    table: 'characters',
    worldKey: 'characters',
    columns: T(`id:text, name:text, title:text, org:text, orgName:text, departmentId:text?, reportsTo:text?, isBoardMember:integer, skills:json, expertise:json, objectives:json, incentives:text,
      riskTolerance:real, personality:text, communicationStyle:text, trustInCeo:real, stress:real, authority:json, privateInfo:json, knowledgeScope:json, boardPrefs:json?, active:integer, bio:text`),
  },
  {
    table: 'relationships',
    worldKey: 'relationships',
    columns: T(`id:text, fromId:text, toId:text, kind:text, strength:real, note:text`),
  },
  {
    table: 'projects',
    worldKey: 'projects',
    columns: T(`id:text, code:text, name:text, kind:text, objective:text, scope:text, sponsorId:text, managerId:text, departmentId:text, status:text, priority:text, startDate:text,
      originalTargetDate:text, targetDate:text, forecastDate:text?, forecastP80Date:text?, budgetCents:integer, originalBudgetCents:integer, spentCents:integer, externalSpentCents:integer,
      internalCostCents:integer, committedCents:integer, staffingFte:real, baseFte:real, productivity:real, capitalizeExternal:integer, externalAccrualCents:integer, acceptanceCriteria:json,
      dependencies:json, linkedModelId:text?, templateKey:text?, completionEffects:json, risks:json, lastDecision:text?, completedDate:text?, description:text`),
  },
  {
    table: 'milestones',
    worldKey: 'milestones',
    columns: T(`id:text, projectId:text, seq:integer, name:text, description:text, workTotal:real, workDone:real, status:text, plannedDate:text, originalPlannedDate:text, completedDate:text?, gates:json, externalCostCents:integer, lateFlagged:integer`),
  },
  {
    table: 'issues',
    worldKey: 'issues',
    columns: T(`id:text, kind:text, title:text, description:text, severity:text, ownerId:text?, discoveredDate:text, status:text, nextAction:text, deadline:text?, linked:json, projectId:text?, drag:real,
      resolutionWorkTotal:real, resolutionWorkDone:real, options:json, chosenOptions:json, resolvedDate:text?, resolutionNote:text?, data:json`),
  },
  {
    table: 'commitments',
    worldKey: 'commitments',
    columns: T(`id:text, promisorId:text, promiseeId:text, description:text, dueDate:text?, conditions:text, status:text, createdDate:text, source:text, sourceId:text?, check:json, resolvedDate:text?, notifiedUpcoming:integer, importance:integer`),
  },
  {
    table: 'debt_instruments',
    worldKey: 'debts',
    columns: T(`id:text, name:text, kind:text, lender:text, lenderCharacterId:text?, principalCents:integer, limitCents:integer, rateBps:integer, commitmentFeeBps:integer, startDate:text, maturityDate:text,
      interestMonths:json, paymentDay:integer, amortization:json, principalDays:integer, undrawnDays:integer, interestPayableCents:integer, status:text, secured:integer, conditions:json`),
  },
  {
    table: 'covenants',
    worldKey: 'covenants',
    columns: T(`id:text, name:text, instrumentIds:json, metric:text, comparator:text, threshold:real, lastTestDate:text?, lastValue:real?, status:text, waiverUntil:text?, description:text`),
  },
  {
    table: 'receivables',
    worldKey: 'receivables',
    loadWhere: "status = 'open'",
    columns: T(`id:text, counterparty:text, amountCents:integer, issueDate:text, dueDate:text, status:text, settledDate:text?, source:text`),
  },
  {
    table: 'payables',
    worldKey: 'payables',
    loadWhere: "status IN ('open','overdue')",
    columns: T(`id:text, counterpartyId:text, category:text, amountCents:integer, issueDate:text, dueDate:text, status:text, paidDate:text?, sourceId:text?, liabilityAccount:text`),
  },
  {
    table: 'contracts',
    worldKey: 'contracts',
    columns: T(`id:text, kind:text, title:text, counterpartyId:text?, counterpartyName:text, status:text, terms:json, startDate:text?, endDate:text?, signedDate:text?, valueCents:integer, amendmentOf:text?, negotiationId:text?, templateKey:text?, obligations:json, summary:text`),
  },
  {
    table: 'negotiations',
    worldKey: 'negotiations',
    columns: T(`id:text, templateKey:text, title:text, counterpartyId:text, status:text, terms:json, reservation:json, ideal:json, weights:json, baseThreshold:real, concessionPerRound:real, maxRounds:integer,
      rounds:json, deadline:text?, createdDate:text, agreedTerms:json?, contractId:text?, linkedIssueId:text?, context:text, pendingDecision:json?`),
  },
  {
    table: 'financing_requests',
    worldKey: 'financing',
    columns: T(`id:text, kind:text, counterparty:text, counterpartyId:text?, requestedCents:integer, tenorYears:real, status:text, submittedDate:text, decisionDate:text?, offer:json?, decisionReason:text?, rationale:text, executedDate:text?, instrumentId:text?, actionId:text?, analysis:json`),
  },
  {
    table: 'board_proposals',
    worldKey: 'boardProposals',
    columns: T(`id:text, title:text, kind:text, actionId:text?, summary:text, rationale:text, analysis:json, submittedDate:text, meetingDate:text, status:text, votes:json, decidedDate:text?, outcomeNote:text?, actionIds:json`),
  },
  {
    table: 'regulations',
    worldKey: 'regulations',
    columns: T(`id:text, name:text, jurisdiction:text, kind:text, status:text, effectiveDate:text, description:text, params:json`),
  },
  {
    table: 'event_states',
    worldKey: 'eventStates',
    columns: T(`key:text, lastFired:text?, count:integer, activeUntil:text?, data:json`),
  },
];

export function snake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function primaryKey(spec: TableSpec): string {
  return spec.columns[0][0];
}

export function createTableSql(spec: TableSpec): string {
  const cols = spec.columns.map(([f, t, nullable], i) => {
    const sqlType = t === 'JSON' ? 'TEXT' : t;
    const pk = i === 0 ? ' PRIMARY KEY' : '';
    const nn = !nullable && i !== 0 ? ' NOT NULL' : '';
    return `  "${snake(f)}" ${sqlType}${pk}${nn}`;
  });
  return `CREATE TABLE "${spec.table}" (\n${cols.join(',\n')}\n);`;
}
