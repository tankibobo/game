import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { askGuide, retrieve } from '../server/guide/guide';
import { MANUAL, PAGE_LABEL } from '../server/guide/manual';
import { NoneProvider, ScriptedProvider } from '../server/llm/provider';
import { newGameDb, withProvider } from './helpers';

const none = { provider: new NoneProvider(), timeoutMs: 1000 };

function clientText(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f)) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(join(__dirname, '..', 'client', 'src'));
  return out.join('\n').replace(/&amp;/g, '&').replace(/’/g, "'").replace(/\{' '\}/g, ' ');
}

describe('in-game guide', () => {
  it.each([
    ['How do I hire more people?', 'hire'],
    ['how can I recruit workers for Brno', 'hire'],
    ['The board approved my Vela revamp but nothing happens', 'approved-nothing-happened'],
    ['How do I upgrade the Vela to Euro 7?', 'vela'],
    ['How do I send a report to my CFO?', 'share'],
    ['How do I negotiate with the union?', 'negotiate'],
    ['I do not have enough engineers for a project', 'engineers'],
    ['why did the board reject my proposal', 'board-outlook'],
    ['How do I put several decisions to the board as one plan?', 'board-plan'],
    ['how do I refinance the bond', 'financing'],
    ['How do I advance time?', 'time'],
    ['How do I cut jobs at Lyon?', 'cut-jobs'],
    ['where are the proposals my team made', 'drafts'],
  ])('finds the right manual entry for “%s”', (q, id) => {
    expect(retrieve(q)[0]?.topic.id).toBe(id);
  });

  it('answers step by step without Claude, and never gives advice', async () => {
    const a = await askGuide(null, none, 'How do I hire more people?', 'dashboard');
    expect(a.source).toBe('manual');
    expect(a.steps.join(' ')).toMatch(/Decisions → Take a decision → People & communication → “Hire staff”/);
    expect(a.pages.map((p) => p.page)).toContain('decisions');
    const advice = await askGuide(null, none, 'Should I cut jobs at Lyon?', 'dashboard');
    expect(advice.answer).toMatch(/only explain how things work, not what you should decide/);
    expect(advice.topics[0].id).toBe('cut-jobs');
    const unknown = await askGuide(null, none, 'qwertyuiop zxcv', null);
    expect(unknown.answer).toMatch(/could not find that in the manual/);
  });

  it('uses Claude when available, keeps answers to known pages/topics, and falls back on bad output', async () => {
    const { db } = newGameDb();
    const p = new ScriptedProvider([
      JSON.stringify({ answer: 'Hiring is done from the Decisions page.', steps: ['Open Decisions → Take a decision → People & communication → “Hire staff”.'], pages: ['decisions', 'nowhere'], topic_ids: ['hire', 'made-up'] }),
      'not json at all',
    ]);
    const a = await askGuide(db, withProvider(p), 'How do I hire more people?', 'company');
    expect(a.source).toBe('claude');
    expect(a.pages.map((x) => x.page)).toEqual(['decisions']);
    expect(a.topics.map((t) => t.id)).toEqual(['hire']);
    const sent = p.calls[0].messages[0].content;
    expect(sent).toContain('[hire] Hire more people');
    expect(sent).toMatch(/a decision submitted today is voted on 2027-01-28/);
    expect(p.calls[0].system).toMatch(/Never give strategic advice/);
    const b = await askGuide(db, withProvider(p), 'How do I hire more people?', 'company');
    expect(b.source).toBe('manual');
    expect(b.topics[0].id).toBe('hire');
    const logged = db.prepare("SELECT status FROM llm_calls WHERE purpose = 'guide'").all() as { status: string }[];
    expect(logged.map((x) => x.status)).toEqual(['ok', 'invalid_output']);
  });

  it('only names buttons, tabs and cards that exist in the interface', () => {
    const ui = clientText();
    const missing: string[] = [];
    for (const t of MANUAL) {
      for (const line of [...t.steps, ...(t.notes ?? [])]) {
        for (const m of line.matchAll(/“([^”]+)”/g)) {
          const label = m[1].replace(/’/g, "'").replace(/…$/, '');
          if (/^(Done:|Board meeting — minutes|Approved by the board, not possible yet)/.test(label)) continue; // message subjects / server text
          if (!ui.includes(label)) missing.push(`${t.id}: “${m[1]}”`);
        }
      }
      for (const p of t.pages) expect(PAGE_LABEL[p]).toBeTruthy();
    }
    expect(missing).toEqual([]);
  });
});
