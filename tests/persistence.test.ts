import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../server/db/connection';
import { loadWorld } from '../server/db/repo';
import { WORLD_TABLES, snake } from '../server/db/tables';
import { advanceTime, confirmAction, proposeAction } from '../server/game/game';
import { SaveManager } from '../server/game/saves';
import { newGameDb } from './helpers';

describe('persistence (acceptance 2)', () => {
  it('migrated schema matches the table specifications', () => {
    const { db } = newGameDb();
    for (const spec of WORLD_TABLES) {
      const cols = (db.prepare(`PRAGMA table_info("${spec.table}")`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toEqual(spec.columns.map(([f]) => snake(f)));
    }
  });

  it('survives close and restart without losing projects, relationships or financial state', () => {
    const { db, file } = newGameDb();
    const a = proposeAction(db, { type: 'approve_project', payload: { projectId: 'PRJ-VELA-E7' } });
    confirmAction(db, a.id);
    advanceTime(db, 35, 'persist-adv-1');
    const before = loadWorld(db);
    db.close();
    const db2 = openDb(file);
    const after = loadWorld(db2);
    expect(after.meta).toEqual(before.meta);
    expect(after.projects).toEqual(before.projects);
    expect(after.milestones).toEqual(before.milestones);
    expect(after.relationships).toEqual(before.relationships);
    expect(after.characters).toEqual(before.characters);
    expect(after.balances).toEqual(before.balances);
    expect(after.debts).toEqual(before.debts);
    expect(after.commitments).toEqual(before.commitments);
    expect(after.issues).toEqual(before.issues);
    expect(after.payables).toEqual(before.payables);
    // and the game continues from the same point
    const r = advanceTime(db2, 1, 'persist-adv-2');
    expect(r.from).toBe(before.meta.currentDate);
  });

  it('save slots: new game, save as, load and delete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'automanager-saves-'));
    const saves = new SaveManager(dir);
    const id = saves.newSlotId('My company');
    const db = openDb(saves.fileFor(id));
    // create via the same path the API uses
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return import('../server/game/game').then(({ createNewGame }) => {
      createNewGame(db);
      db.close();
      saves.register(id, 'My company');
      advanceTime(saves.db(), 10, 'slot-adv-1');
      const copy = saves.saveAs('Before the board meeting');
      advanceTime(saves.db(), 10, 'slot-adv-2');
      expect(loadWorld(saves.db()).meta.currentDate).toBe('2027-01-21');
      saves.setActive(copy);
      expect(loadWorld(saves.db()).meta.currentDate).toBe('2027-01-11');
      const list = saves.list();
      expect(list.length).toBe(2);
      expect(list.find((s) => s.active)?.id).toBe(copy);
      saves.setActive(id);
      saves.delete(copy);
      expect(saves.list().length).toBe(1);
      saves.closeAll();
    });
  });

  it('enforces the append-only event ledger and journal', () => {
    const { db } = newGameDb();
    expect(() => db.prepare("UPDATE events SET title = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM journal_lines').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM project_history').run()).not.toThrow(); // empty table: nothing deleted
  });
});
