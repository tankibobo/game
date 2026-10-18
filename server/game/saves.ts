/**
 * Save slots. Each slot is a self-contained SQLite file; progress is written
 * continuously (every committed action and every time advance), so "saving"
 * means the slot is always current. "Save as" snapshots the active slot to a
 * new file with VACUUM INTO; "load" switches the active slot.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, type DB } from '../db/connection';

export interface SlotInfo {
  id: string;
  name: string;
  file: string;
  createdAt: string;
  updatedAt: string;
  currentDate: string | null;
  status: string | null;
  companyName: string | null;
  active: boolean;
}

export class SaveManager {
  readonly dir: string;
  private dbs = new Map<string, DB>();

  constructor(dataDir: string) {
    this.dir = resolve(dataDir, 'saves');
    mkdirSync(this.dir, { recursive: true });
  }

  private indexFile() {
    return join(this.dir, 'index.json');
  }

  private readIndex(): { active: string | null; names: Record<string, { name: string; createdAt: string }> } {
    if (!existsSync(this.indexFile())) return { active: null, names: {} };
    try {
      return JSON.parse(readFileSync(this.indexFile(), 'utf8'));
    } catch {
      return { active: null, names: {} };
    }
  }

  private writeIndex(ix: ReturnType<SaveManager['readIndex']>) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.indexFile(), JSON.stringify(ix, null, 2));
  }

  fileFor(id: string): string {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error('invalid slot id');
    mkdirSync(this.dir, { recursive: true });
    return join(this.dir, `${id}.sqlite`);
  }

  activeId(): string | null {
    const ix = this.readIndex();
    return ix.active && existsSync(this.fileFor(ix.active)) ? ix.active : null;
  }

  db(id = this.activeId()): DB {
    if (!id) throw new Error('No active game. Start a new game or load a save.');
    let d = this.dbs.get(id);
    if (!d) {
      d = openDb(this.fileFor(id));
      this.dbs.set(id, d);
    }
    return d;
  }

  newSlotId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'game';
    let id = `${base}-${Date.now().toString(36)}`;
    while (existsSync(this.fileFor(id))) id = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    return id;
  }

  register(id: string, name: string, makeActive = true) {
    const ix = this.readIndex();
    ix.names[id] = { name, createdAt: new Date().toISOString() };
    if (makeActive) ix.active = id;
    this.writeIndex(ix);
  }

  setActive(id: string) {
    if (!existsSync(this.fileFor(id))) throw new Error(`Save "${id}" not found.`);
    const ix = this.readIndex();
    ix.active = id;
    this.writeIndex(ix);
  }

  /** Snapshot the active game into a new slot (the copy becomes a separate save; the active game stays active). */
  saveAs(name: string): string {
    const src = this.activeId();
    if (!src) throw new Error('No active game.');
    const id = this.newSlotId(name);
    const db = this.db(src);
    db.prepare('VACUUM INTO ?').run(this.fileFor(id));
    this.register(id, name, false);
    return id;
  }

  delete(id: string) {
    if (id === this.activeId()) throw new Error('Cannot delete the active save. Load another one first.');
    const d = this.dbs.get(id);
    d?.close();
    this.dbs.delete(id);
    for (const suffix of ['', '-wal', '-shm']) {
      const f = this.fileFor(id) + suffix;
      if (existsSync(f)) rmSync(f);
    }
    const ix = this.readIndex();
    delete ix.names[id];
    this.writeIndex(ix);
  }

  list(): SlotInfo[] {
    const ix = this.readIndex();
    const out: SlotInfo[] = [];
    if (!existsSync(this.dir)) return out;
    for (const f of readdirSync(this.dir)) {
      const m = f.match(/^([a-z0-9-]+)\.sqlite$/);
      if (!m) continue;
      const id = m[1];
      let meta: { current_date?: string; status?: string; company_name?: string } = {};
      try {
        meta = (this.db(id).prepare('SELECT "current_date", status, company_name FROM game_meta LIMIT 1').get() as typeof meta) ?? {};
      } catch {
        /* unreadable save */
      }
      const st = statSync(this.fileFor(id));
      out.push({ id, name: ix.names[id]?.name ?? id, file: this.fileFor(id), createdAt: ix.names[id]?.createdAt ?? st.birthtime.toISOString(), updatedAt: st.mtime.toISOString(), currentDate: meta.current_date ?? null, status: meta.status ?? null, companyName: meta.company_name ?? null, active: id === ix.active });
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  closeAll() {
    for (const d of this.dbs.values()) d.close();
    this.dbs.clear();
  }
}
