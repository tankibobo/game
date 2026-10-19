/**
 * Reports: structured, data-backed documents built from the simulation.
 * The same structure is rendered in the UI (figures, tables, charts) and
 * flattened to text for characters' context.
 */

export type Tone = 'good' | 'warning' | 'critical' | null;

export interface ReportKpi {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}

export interface ReportSeries {
  key: string;
  label: string;
}

export type ReportBlock =
  | { kind: 'kpis'; items: ReportKpi[] }
  | { kind: 'table'; title?: string; columns: string[]; rows: (string | number)[][]; numeric?: boolean[]; note?: string }
  | { kind: 'chart'; title: string; chart: 'bar' | 'line' | 'stacked'; x: string; unit: '€m' | 'units' | '%' | ''; series: ReportSeries[]; data: Record<string, string | number>[]; refY?: number; refLabel?: string; note?: string }
  | { kind: 'waterfall'; title: string; unit: '€m'; steps: { label: string; value: number; total?: boolean }[]; note?: string }
  | { kind: 'bullets'; title?: string; items: { text: string; tone?: Tone }[] }
  | { kind: 'text'; text: string };

export interface Report {
  key: string;
  title: string;
  /** Simulation date the figures are as of. */
  date: string;
  /** Who prepared it (character id) — or 'ceo'. */
  authorId: string;
  /** One or two sentences: the headline. */
  summary: string;
  blocks: ReportBlock[];
}

export interface ReportInfo {
  key: string;
  title: string;
  description: string;
  area: 'finance' | 'sales' | 'operations' | 'people' | 'projects' | 'deals' | 'board' | 'legal';
  /** Characters who produce this report (their department owns the data). */
  ownerIds: string[];
  param?: 'project' | 'negotiation' | 'board_proposal' | 'model';
}
