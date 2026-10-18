/**
 * In-memory representation of the authoritative world state, loaded from
 * SQLite, mutated by pure-ish engine functions, and written back atomically.
 * Engine code never touches the database directly.
 */
import type {
  CharacterMemory,
  Character,
  Commitment,
  CompetitorProduct,
  Competitor,
  ComponentSupply,
  Contract,
  Covenant,
  DebtInstrument,
  Department,
  EntityRef,
  EventState,
  Factory,
  FinancialSnapshot,
  FinancingRequest,
  GameEvent,
  GameMeta,
  InboxItem,
  Issue,
  JournalEntry,
  MacroState,
  Milestone,
  Negotiation,
  Payable,
  ProductionLine,
  Project,
  ProjectHistory,
  Receivable,
  Regulation,
  Relationship,
  Segment,
  Supplier,
  VehicleModel,
  BoardProposal,
  Forecast,
  ActionStatus,
} from '../../shared/domain';
import type { Cents } from '../../shared/money';
import type { SimDate } from '../../shared/dates';
import { makeRng, type Rng } from './rng';

export interface ActionUpdate {
  actionId: string;
  status: ActionStatus;
  result?: Record<string, unknown> | null;
  note?: string;
}

export interface WorldOutput {
  journal: JournalEntry[];
  events: GameEvent[];
  inbox: InboxItem[];
  history: ProjectHistory[];
  memories: CharacterMemory[];
  snapshots: FinancialSnapshot[];
  forecasts: Forecast[];
  actionUpdates: ActionUpdate[];
  /** Actions the engine must commit (e.g. board-approved) — handled by the action service. */
  approvedActions: { actionId: string; proposalId: string }[];
}

export interface World {
  meta: GameMeta;
  macro: MacroState;
  segments: Segment[];
  models: VehicleModel[];
  competitors: Competitor[];
  competitorProducts: CompetitorProduct[];
  factories: Factory[];
  lines: ProductionLine[];
  suppliers: Supplier[];
  supplies: ComponentSupply[];
  departments: Department[];
  characters: Character[];
  relationships: Relationship[];
  projects: Project[];
  milestones: Milestone[];
  issues: Issue[];
  commitments: Commitment[];
  debts: DebtInstrument[];
  covenants: Covenant[];
  receivables: Receivable[];
  payables: Payable[];
  contracts: Contract[];
  negotiations: Negotiation[];
  financing: FinancingRequest[];
  boardProposals: BoardProposal[];
  regulations: Regulation[];
  eventStates: EventState[];
  /** GL balances derived from the journal (debit positive). */
  balances: Record<string, Cents>;
  /** Recent monthly snapshots (for LTM metrics). */
  snapshots: FinancialSnapshot[];
  out: WorldOutput;
  mode: 'live' | 'forecast';
  /** Forecast scenario demand multiplier (1 in live mode). */
  scenarioDemandFactor: number;
}

export function emptyOutput(): WorldOutput {
  return { journal: [], events: [], inbox: [], history: [], memories: [], snapshots: [], forecasts: [], actionUpdates: [], approvedActions: [] };
}

export function rngFor(w: World): Rng {
  return makeRng(w.meta.seed, w.mode === 'live');
}

/** Deterministic id generator: PREFIX-000123. */
export function nextId(w: World, prefix: string): string {
  w.meta.seq += 1;
  return `${prefix}-${String(w.meta.seq).padStart(6, '0')}`;
}

export function byId<T extends { id: string }>(xs: T[], id: string | null | undefined): T | undefined {
  if (!id) return undefined;
  return xs.find((x) => x.id === id);
}

export function must<T extends { id: string }>(xs: T[], id: string, what: string): T {
  const x = byId(xs, id);
  if (!x) throw new Error(`${what} not found: ${id}`);
  return x;
}

export function today(w: World): SimDate {
  return w.meta.currentDate;
}

export interface EmitEvent extends Omit<GameEvent, 'id' | 'date' | 'source' | 'actionId' | 'consequences' | 'followUps' | 'entities' | 'cause'> {
  date?: SimDate;
  source?: GameEvent['source'];
  actionId?: string | null;
  consequences?: GameEvent['consequences'];
  followUps?: string[];
  entities?: EntityRef[];
  cause?: GameEvent['cause'];
}

export function emit(w: World, e: EmitEvent): GameEvent {
  const ev: GameEvent = {
    id: nextId(w, 'EVT'),
    date: e.date ?? w.meta.currentDate,
    type: e.type,
    category: e.category,
    severity: e.severity,
    title: e.title,
    description: e.description,
    causeKind: e.causeKind,
    cause: e.cause ?? { text: '', refs: [] },
    entities: e.entities ?? [],
    consequences: e.consequences ?? [],
    followUps: e.followUps ?? [],
    source: e.source ?? 'engine',
    actionId: e.actionId ?? null,
  };
  if (w.mode === 'live') w.out.events.push(ev);
  return ev;
}

export function inbox(w: World, item: Omit<InboxItem, 'id' | 'date' | 'read'> & { date?: SimDate }): void {
  if (w.mode !== 'live') return;
  w.out.inbox.push({ id: nextId(w, 'MSG'), date: item.date ?? w.meta.currentDate, read: 0, ...item });
}

export function remember(w: World, m: Omit<CharacterMemory, 'id' | 'date'> & { date?: SimDate }): void {
  if (w.mode !== 'live') return;
  w.out.memories.push({ id: nextId(w, 'MEM'), date: m.date ?? w.meta.currentDate, ...m });
}

export function recordHistory(w: World, h: Omit<ProjectHistory, 'id' | 'date'> & { date?: SimDate }): void {
  if (w.mode !== 'live') return;
  w.out.history.push({ id: nextId(w, 'PHX'), date: h.date ?? w.meta.currentDate, ...h });
}

export function adjustTrust(w: World, characterId: string, delta: number): void {
  const c = byId(w.characters, characterId);
  if (!c) return;
  c.trustInCeo = Math.max(0, Math.min(100, Math.round((c.trustInCeo + delta) * 10) / 10));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function cloneWorld(w: World): World {
  const c = structuredClone(w);
  c.out = emptyOutput();
  return c;
}
