import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../server/db/connection';
import { loadWorld } from '../server/db/repo';
import { createNewGame } from '../server/game/game';
import { NoneProvider, type LlmConfig, type LlmProvider } from '../server/llm/provider';
import { buildInitialWorld } from '../server/scenario/initial';

export function tempFile(name = 'game.sqlite'): string {
  return join(mkdtempSync(join(tmpdir(), 'automanager-test-')), name);
}

export function newGameDb(seed?: number): { db: DB; file: string } {
  const file = tempFile();
  const db = openDb(file);
  createNewGame(db, seed);
  return { db, file };
}

export function memoryWorld(seed?: number) {
  return buildInitialWorld(seed);
}

export const noLlm: LlmConfig = { provider: new NoneProvider(), timeoutMs: 1000 };
export const withProvider = (provider: LlmProvider): LlmConfig => ({ provider, timeoutMs: 1000 });

/** Stable fingerprint of the authoritative state (tables that matter). */
export function fingerprint(db: DB): string {
  const tables = ['game_meta', 'vehicle_models', 'production_lines', 'projects', 'milestones', 'issues', 'commitments', 'debt_instruments', 'contracts', 'negotiations', 'financing_requests', 'board_proposals', 'characters', 'departments', 'component_supplies'];
  const parts: string[] = [];
  for (const t of tables) parts.push(JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()));
  parts.push(JSON.stringify(db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS s FROM journal_lines').get()));
  parts.push(JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM payables").get()));
  return parts.join('|');
}

export function ledgerCash(db: DB): number {
  return (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM journal_lines WHERE account = '1000'").get() as { s: number }).s;
}

export { loadWorld };
