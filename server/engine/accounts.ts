import type { Account } from '../../shared/domain';

/**
 * Chart of accounts. Debits are positive, credits negative. Asset and expense
 * accounts carry debit (positive) balances; liability, equity and revenue
 * accounts carry credit (negative) balances.
 */
export const ACCOUNTS: Account[] = [
  { code: '1000', name: 'Cash and cash equivalents', type: 'asset', statementLine: 'cash' },
  { code: '1100', name: 'Trade receivables (dealers)', type: 'asset', statementLine: 'receivables' },
  { code: '1150', name: 'Supplier prepayments', type: 'asset', statementLine: 'other_current_assets' },
  { code: '1200', name: 'Inventory — finished vehicles', type: 'asset', statementLine: 'inventory' },
  { code: '1500', name: 'Property, plant & equipment (gross)', type: 'asset', statementLine: 'ppe' },
  { code: '1510', name: 'Accumulated depreciation', type: 'asset', statementLine: 'ppe' },
  { code: '1600', name: 'Capitalised development costs', type: 'asset', statementLine: 'intangibles' },
  { code: '1610', name: 'Accumulated amortisation', type: 'asset', statementLine: 'intangibles' },
  { code: '2000', name: 'Trade payables', type: 'liability', statementLine: 'payables' },
  { code: '2200', name: 'Warranty provision', type: 'liability', statementLine: 'provisions' },
  { code: '2300', name: 'CO₂ compliance provision', type: 'liability', statementLine: 'provisions' },
  { code: '2400', name: 'Restructuring provision', type: 'liability', statementLine: 'provisions' },
  { code: '2450', name: 'Recall & field-action provision', type: 'liability', statementLine: 'provisions' },
  { code: '2500', name: 'Income tax payable', type: 'liability', statementLine: 'tax_payable' },
  { code: '2600', name: 'Accrued interest', type: 'liability', statementLine: 'accrued_interest' },
  { code: '2700', name: 'Borrowings', type: 'liability', statementLine: 'debt' },
  { code: '2800', name: 'Lease liabilities', type: 'liability', statementLine: 'debt_like' },
  { code: '3000', name: 'Share capital & premium', type: 'equity', statementLine: 'equity' },
  { code: '3100', name: 'Retained earnings (opening)', type: 'equity', statementLine: 'equity' },
  { code: '4000', name: 'Vehicle revenue', type: 'revenue', statementLine: 'revenue' },
  { code: '4100', name: 'Parts & aftersales revenue', type: 'revenue', statementLine: 'revenue' },
  { code: '4900', name: 'Other operating income', type: 'revenue', statementLine: 'other_income' },
  { code: '5000', name: 'Cost of vehicles sold', type: 'expense', statementLine: 'cogs' },
  { code: '5100', name: 'Cost of aftersales', type: 'expense', statementLine: 'cogs' },
  { code: '5200', name: 'Warranty expense', type: 'expense', statementLine: 'cogs' },
  { code: '5300', name: 'Outbound logistics', type: 'expense', statementLine: 'cogs' },
  { code: '6000', name: 'Personnel — production', type: 'expense', statementLine: 'personnel' },
  { code: '6010', name: 'Personnel — engineering (R&D)', type: 'expense', statementLine: 'personnel' },
  { code: '6020', name: 'Personnel — sales & marketing', type: 'expense', statementLine: 'personnel' },
  { code: '6030', name: 'Personnel — corporate', type: 'expense', statementLine: 'personnel' },
  { code: '6100', name: 'Factory overhead & energy', type: 'expense', statementLine: 'other_opex' },
  { code: '6150', name: 'Inventory storage & carrying', type: 'expense', statementLine: 'other_opex' },
  { code: '6200', name: 'Marketing', type: 'expense', statementLine: 'other_opex' },
  { code: '6300', name: 'General & administrative', type: 'expense', statementLine: 'other_opex' },
  { code: '6400', name: 'External R&D (expensed)', type: 'expense', statementLine: 'other_opex' },
  { code: '6500', name: 'Depreciation & amortisation', type: 'expense', statementLine: 'da' },
  { code: '6600', name: 'Restructuring costs', type: 'expense', statementLine: 'other_opex' },
  { code: '6700', name: 'CO₂ compliance cost', type: 'expense', statementLine: 'other_opex' },
  { code: '6800', name: 'Recall & field actions', type: 'expense', statementLine: 'other_opex' },
  { code: '6850', name: 'Impairments & write-offs', type: 'expense', statementLine: 'da' },
  { code: '6900', name: 'Lease & rent expense', type: 'expense', statementLine: 'other_opex' },
  { code: '7000', name: 'Interest expense', type: 'expense', statementLine: 'interest' },
  { code: '7100', name: 'Financing fees', type: 'expense', statementLine: 'interest' },
  { code: '8000', name: 'Income tax expense', type: 'expense', statementLine: 'tax' },
];

export const ACCOUNT_CODES = new Set(ACCOUNTS.map((a) => a.code));
export const ACCOUNT_BY_CODE = new Map(ACCOUNTS.map((a) => [a.code, a]));

export const PNL_TYPES = new Set(['revenue', 'expense']);

export function isPnl(code: string): boolean {
  const a = ACCOUNT_BY_CODE.get(code);
  return !!a && PNL_TYPES.has(a.type);
}

export const CASH = '1000';
export const AR = '1100';
export const INVENTORY = '1200';
export const AP = '2000';
export const DEBT = '2700';

/** Accounts that make up EBITDA-relevant operating expenses (excludes D&A, interest, tax). */
export const OPEX_LINES = new Set(['personnel', 'other_opex']);
