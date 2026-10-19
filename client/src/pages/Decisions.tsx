import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Card, D, Empty, Loading, Status, Tabs } from '../components/ui';
import { ShareForm } from '../components/ShareForm';
import { BoardOutlook } from '../components/ActionReview';
import { useGame, useView } from '../ctx';
import { addDays, fmtDate, fmtEur, fmtInt, titleCase } from '../format';

type Tab = 'take' | 'drafts' | 'progress' | 'recent';
type Area = 'people' | 'products' | 'production' | 'projects' | 'money' | 'deals' | 'board';

const AREAS: [Area, string][] = [
  ['people', 'People & communication'],
  ['products', 'Products & pricing'],
  ['production', 'Production'],
  ['projects', 'Projects & issues'],
  ['money', 'Money'],
  ['deals', 'Deals & contracts'],
  ['board', 'Board'],
];

const FINANCING_KINDS: [string, string][] = [
  ['bank_term_loan', 'Bank term loan — new debt; board approval above €100m'],
  ['bond', 'Bond — new debt from capital markets; always needs the board'],
  ['rights_issue', 'Rights issue — new shares (dilutes shareholders); needs the board'],
  ['sale_leaseback', 'Sale-and-leaseback of the HQ — one-off cash, then rent; needs the board'],
  ['shareholder_loan', 'Shareholder loan — from the anchor shareholder; independent directors approve'],
  ['ceo_contribution', 'Personal contribution from you — related party; independent directors approve'],
  ['covenant_waiver', 'Covenant waiver — ask lenders to relax a covenant for a fee'],
  ['rcf_extension', 'Extend the credit line (RCF) by three years — your decision; banks charge a fee'],
];

/** Requests that carry no amount (relief rather than money). */
const NO_AMOUNT = ['covenant_waiver', 'rcf_extension'];

/** One decision: a title, who decides, a plain explanation, and its form. */
function Decision({ title, who, children, hint }: { title: string; who: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="decision">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="spacer" />
        <span className="tiny muted">{who}</span>
      </div>
      {hint && <div className="small sub" style={{ margin: '2px 0 8px' }}>{hint}</div>}
      {children}
    </div>
  );
}

const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

function People({ d }: { d: any }) {
  const { propose } = useGame();
  const [hire, setHire] = useState({ dep: 'DEP-BRNO', n: '', why: '' });
  const [cut, setCut] = useState({ dep: 'DEP-LYON', n: '', mode: 'voluntary', why: '' });
  const [promise, setPromise] = useState({ to: d.characters[0]?.id ?? '', text: '', due: '' });
  const hd = d.departments.find((x: any) => x.id === hire.dep);
  const cd = d.departments.find((x: any) => x.id === cut.dep);
  const needText = (x: any) => (x.kind === 'engineering' ? `${fmtInt(d.freeEngineers)} engineers are currently unassigned to projects.` : x.need > 0 ? `Short of about ${fmtInt(x.need)} people for its production plan.` : x.need < 0 ? `About ${fmtInt(-x.need)} more people than its production plan needs.` : '');
  return (
    <div className="stack">
      <Card>
        <Decision title="Hire staff" who={`You decide up to ${d.limits.hiring} people; above that the board`} hint="New people arrive after the recruiting lead time (plants ≈45 days, engineering ≈90 days) and only then count towards crews or project staffing.">
          <div className="form-grid">
            <label className="field">Department<select value={hire.dep} onChange={(e) => setHire({ ...hire, dep: e.target.value })}>{d.departments.map((x: any) => <option key={x.id} value={x.id}>{x.name} ({fmtInt(x.headcount)})</option>)}</select></label>
            <label className="field">How many<input type="number" min={1} value={hire.n} onChange={(e) => setHire({ ...hire, n: e.target.value })} placeholder="e.g. 300" /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Reason (optional)<input type="text" value={hire.why} onChange={(e) => setHire({ ...hire, why: e.target.value })} placeholder="e.g. Eon ramp-up crew" /></label>
            <div><button className="btn primary" disabled={!(num(hire.n) > 0)} onClick={() => propose('hire_staff', { departmentId: hire.dep, headcount: Math.round(num(hire.n)), reason: hire.why || undefined })}>Preview…</button></div>
          </div>
          {hd && <div className="tiny muted" style={{ marginTop: 6 }}>{hd.name}: {fmtInt(hd.headcount)} people{hd.hiring ? `, ${fmtInt(hd.hiring)} already being hired` : ''}{hd.leaving ? `, ${fmtInt(hd.leaving)} leaving` : ''}. {needText(hd)}</div>}
        </Decision>
      </Card>
      <Card>
        <Decision title="Reduce headcount" who={`You decide up to ${d.limits.restructuring} positions; above that the board`} hint="Starts a 60-day consultation with employee representatives; people leave and severance is paid at the end. Voluntary programmes cost more per person but anger the union less.">
          <div className="form-grid">
            <label className="field">Department<select value={cut.dep} onChange={(e) => setCut({ ...cut, dep: e.target.value })}>{d.departments.map((x: any) => <option key={x.id} value={x.id}>{x.name} ({fmtInt(x.headcount)})</option>)}</select></label>
            <label className="field">How many<input type="number" min={1} value={cut.n} onChange={(e) => setCut({ ...cut, n: e.target.value })} placeholder="e.g. 250" /></label>
            <label className="field">Type<select value={cut.mode} onChange={(e) => setCut({ ...cut, mode: e.target.value })}><option value="voluntary">Voluntary departures</option><option value="compulsory">Compulsory redundancies</option></select></label>
            <label className="field">Reason (optional)<input type="text" value={cut.why} onChange={(e) => setCut({ ...cut, why: e.target.value })} /></label>
            <div><button className="btn danger" disabled={!(num(cut.n) > 0)} onClick={() => propose('restructure_workforce', { departmentId: cut.dep, reduction: Math.round(num(cut.n)), mode: cut.mode, reason: cut.why || undefined })}>Preview…</button></div>
          </div>
          {cd && <div className="tiny muted" style={{ marginTop: 6 }}>{cd.name}: {fmtInt(cd.headcount)} people, morale {Math.round(cd.morale)}. {needText(cd)}</div>}
        </Decision>
      </Card>
      <Card>
        <Decision title="Share a document or send a memo" who="You — immediate" hint="Give people the information they ask for: forecasts, results, project reports and more, built from the company's current figures. They will remember it in later meetings; colleagues learn that it was circulated. This never changes the company itself.">
          <ShareForm />
        </Decision>
      </Card>
      <Card>
        <Decision title="Record a promise you made" who="You — immediate" hint="Promises are tracked as commitments. Keeping them builds trust; breaking them costs more. Promises you make in meetings are recorded automatically.">
          <div className="form-grid">
            <label className="field">To<select value={promise.to} onChange={(e) => setPromise({ ...promise, to: e.target.value })}>{d.characters.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="field">Due date (optional)<input type="date" value={promise.due} min={d.today} onChange={(e) => setPromise({ ...promise, due: e.target.value })} /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>What you promised<input type="text" value={promise.text} onChange={(e) => setPromise({ ...promise, text: e.target.value })} /></label>
            <div><button className="btn" disabled={promise.text.trim().length < 5} onClick={() => propose('make_promise', { promiseeId: promise.to, description: promise.text.trim(), dueDate: promise.due || null })}>Preview…</button></div>
          </div>
        </Decision>
      </Card>
    </div>
  );
}

function Products({ d }: { d: any }) {
  const { propose } = useGame();
  const models = d.models.filter((m: any) => m.status === 'in_production');
  const [price, setPrice] = useState({ model: models[0]?.id ?? '', eur: '' });
  const [mkt, setMkt] = useState('');
  const m = d.models.find((x: any) => x.id === price.model);
  return (
    <div className="stack">
      <Card>
        <Decision title="Change a model's price" who="You — immediate" hint="Net price is what dealers pay per car (after their margin and VAT). Demand reacts to price relative to competitors; see Products for the market shares.">
          <div className="form-grid">
            <label className="field">Model<select value={price.model} onChange={(e) => setPrice({ ...price, model: e.target.value })}>{models.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label className="field">New net price (€)<input type="number" step={100} value={price.eur} onChange={(e) => setPrice({ ...price, eur: e.target.value })} placeholder={m ? String(Math.round(m.netPriceCents / 100)) : ''} /></label>
            <div><button className="btn primary" disabled={!(num(price.eur) > 0)} onClick={() => propose('change_price', { modelId: price.model, netPriceCents: Math.round(num(price.eur) * 100), reason: 'Pricing decision' })}>Preview…</button></div>
          </div>
          {m && <div className="tiny muted" style={{ marginTop: 6 }}>Current net price {fmtEur(m.netPriceCents, { compact: false })}.</div>}
        </Decision>
      </Card>
      <Card>
        <Decision title="Set the marketing budget" who="You — immediate" hint="Monthly brand and product marketing for all models. More spending lifts demand, with diminishing returns.">
          <div className="form-grid">
            <label className="field">€ million per month<input type="number" step={1} value={mkt} onChange={(e) => setMkt(e.target.value)} placeholder={String(Math.round(d.marketingMonthlyCents / 1e8))} /></label>
            <div><button className="btn primary" disabled={!(num(mkt) >= 0)} onClick={() => propose('set_marketing_budget', { monthlyCents: Math.round(num(mkt) * 1e8), reason: 'Marketing budget decision' })}>Preview…</button></div>
          </div>
          <div className="tiny muted" style={{ marginTop: 6 }}>Current budget {fmtEur(d.marketingMonthlyCents)} per month.</div>
        </Decision>
      </Card>
    </div>
  );
}

function Production({ d }: { d: any }) {
  const { propose } = useGame();
  const [rate, setRate] = useState({ line: d.lines[0]?.id ?? '', v: '' });
  const [down, setDown] = useState({ f: d.factories[0]?.id ?? '', s: '', e: '', why: '' });
  const l = d.lines.find((x: any) => x.id === rate.line);
  return (
    <div className="stack">
      <Card>
        <Decision title="Change a line's production rate" who="You — immediate" hint="Cars built per working day. Building more than dealers sell piles up stock and ties up cash; building less idles crews. Each plant needs enough people for its planned rate.">
          <div className="form-grid">
            <label className="field">Line<select value={rate.line} onChange={(e) => setRate({ ...rate, line: e.target.value })}>{d.lines.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label className="field">Cars per day<input type="number" value={rate.v} onChange={(e) => setRate({ ...rate, v: e.target.value })} placeholder={l ? String(l.plannedDailyRate) : ''} /></label>
            <div><button className="btn primary" disabled={!(num(rate.v) >= 0)} onClick={() => propose('adjust_production', { lineId: rate.line, plannedDailyRate: Math.round(num(rate.v)), reason: 'Production plan change' })}>Preview…</button></div>
          </div>
          {l && <div className="tiny muted" style={{ marginTop: 6 }}>{l.name}: {titleCase(l.status)}, planned {l.plannedDailyRate}/day, maximum {l.maxDailyRate}/day.</div>}
        </Decision>
      </Card>
      <Card>
        <Decision title="Plan factory downtime" who="You — immediate" hint="Stop a plant for a period (for example to cut excess stock). Crews are still paid.">
          <div className="form-grid">
            <label className="field">Factory<select value={down.f} onChange={(e) => setDown({ ...down, f: e.target.value })}>{d.factories.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label className="field">From<input type="date" min={d.today} value={down.s} onChange={(e) => setDown({ ...down, s: e.target.value })} /></label>
            <label className="field">To<input type="date" min={down.s || d.today} value={down.e} onChange={(e) => setDown({ ...down, e: e.target.value })} /></label>
            <label className="field">Reason<input type="text" value={down.why} onChange={(e) => setDown({ ...down, why: e.target.value })} placeholder="e.g. Reduce stock" /></label>
            <div><button className="btn" disabled={!down.s || !down.e} onClick={() => propose('schedule_downtime', { factoryId: down.f, startDate: down.s, endDate: down.e, reason: down.why || 'Planned downtime' })}>Preview…</button></div>
          </div>
        </Decision>
      </Card>
    </div>
  );
}

function Projects({ d }: { d: any }) {
  const { propose, go } = useGame();
  const live = d.projects.filter((p: any) => ['active', 'delayed', 'blocked', 'approved', 'proposed'].includes(p.status));
  const proposed = d.projects.filter((p: any) => p.status === 'proposed');
  const [rp, setRp] = useState({ p: live[0]?.id ?? '', date: '', staff: '', budget: '', descope: '', why: '' });
  const [bud, setBud] = useState({ p: live[0]?.id ?? '', m: '', why: '' });
  const [can, setCan] = useState({ p: live[0]?.id ?? '', why: '' });
  const [iss, setIss] = useState(d.issues.find((i: any) => i.options.length)?.id ?? '');
  const issue = d.issues.find((i: any) => i.id === iss);
  const replanPayload = () => {
    const p: Record<string, unknown> = { projectId: rp.p, reason: rp.why.trim() || 'Re-plan' };
    if (rp.date) p.newTargetDate = rp.date;
    if (rp.staff.trim()) p.staffingDelta = Math.round(num(rp.staff));
    if (rp.budget.trim()) p.budgetDeltaCents = Math.round(num(rp.budget) * 1e8);
    if (rp.descope.trim()) p.descopePct = num(rp.descope) / 100;
    return p;
  };
  return (
    <div className="stack">
      <Card>
        <Decision title="Start a new project" who={`You decide up to ${fmtEur(d.limits.ceoSpendCents)}; above that the board`} hint={<>Each project needs free engineers for its whole duration ({fmtInt(d.freeEngineers)} free now). Projects above your spending limit go to the board meeting on {fmtDate(d.submissionMeeting)} and start that day if approved.</>}>
          <div className="list">
            {d.templates.map((t: any) => (
              <div key={t.key} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="small strong">{t.name} <span className="pill">{t.strategy}</span>{t.needsBoard && <span className="pill warning" style={{ marginLeft: 4 }}>board</span>}</div>
                  <div className="tiny muted">{fmtEur(t.budgetCents)} · {t.fte} engineers · ~{t.months} months — {t.tradeoffs}</div>
                  {t.replaces.length > 0 && <div className="tiny" style={{ color: 'var(--warning-text)' }}>Replaces the proposed {t.replaces.join(', ')} (withdrawn when this starts).</div>}
                  {t.reason && <div className="tiny" style={{ color: 'var(--critical-text)' }}>{t.reason}</div>}
                </div>
                <button className="btn sm" disabled={!t.available} onClick={() => propose('start_project', { templateKey: t.key })}>Preview…</button>
              </div>
            ))}
          </div>
        </Decision>
      </Card>
      <Card>
        <Decision title="Approve a proposed project" who="You (or the board above your limit)" hint="Projects prepared by your team that wait for a go-ahead. Nothing happens until you approve.">
          {proposed.length === 0 ? <Empty>No proposed projects.</Empty> : (
            <div className="list">
              {proposed.map((p: any) => (
                <div key={p.id} className="list-item">
                  <div style={{ flex: 1 }}><div className="small strong">{p.name}</div><div className="tiny muted">{fmtEur(p.budgetCents)} · {p.staffingFte} engineers · target {fmtDate(p.targetDate)}</div></div>
                  <button className="btn sm primary" onClick={() => propose('approve_project', { projectId: p.id })}>Preview…</button>
                </div>
              ))}
            </div>
          )}
        </Decision>
      </Card>
      <Card>
        <Decision title="Re-plan a project" who="You (budget increases above your limit: the board)" hint="Move the target date, add or release engineers (diminishing returns), change the budget or cut remaining scope. Fill in only what you want to change.">
          <div className="form-grid">
            <label className="field">Project<select value={rp.p} onChange={(e) => setRp({ ...rp, p: e.target.value })}>{live.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field">New target date<input type="date" min={addDays(d.today, 1)} value={rp.date} onChange={(e) => setRp({ ...rp, date: e.target.value })} /></label>
            <label className="field">Engineers (±)<input type="number" value={rp.staff} onChange={(e) => setRp({ ...rp, staff: e.target.value })} placeholder="e.g. 60 or −40" /></label>
            <label className="field">Budget change (€m, ±)<input type="number" value={rp.budget} onChange={(e) => setRp({ ...rp, budget: e.target.value })} /></label>
            <label className="field">Cut remaining scope (%)<input type="number" min={0} max={30} value={rp.descope} onChange={(e) => setRp({ ...rp, descope: e.target.value })} placeholder="0–30" /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Reason (kept in the project history)<input type="text" value={rp.why} onChange={(e) => setRp({ ...rp, why: e.target.value })} /></label>
            <div><button className="btn primary" disabled={!rp.p || (!rp.date && !rp.staff.trim() && !rp.budget.trim() && !rp.descope.trim())} onClick={() => propose('change_project_scope', replanPayload())}>Preview…</button></div>
          </div>
        </Decision>
      </Card>
      <Card>
        <Decision title="Increase a project's budget" who={`You up to ${fmtEur(d.limits.ceoSpendCents)}; above that the board`}>
          <div className="form-grid">
            <label className="field">Project<select value={bud.p} onChange={(e) => setBud({ ...bud, p: e.target.value })}>{live.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field">Extra budget (€m)<input type="number" min={0} value={bud.m} onChange={(e) => setBud({ ...bud, m: e.target.value })} /></label>
            <label className="field">Reason<input type="text" value={bud.why} onChange={(e) => setBud({ ...bud, why: e.target.value })} /></label>
            <div><button className="btn" disabled={!(num(bud.m) > 0) || bud.why.trim().length < 3} onClick={() => propose('propose_budget', { projectId: bud.p, amountCents: Math.round(num(bud.m) * 1e8), reason: bud.why.trim() })}>Preview…</button></div>
          </div>
        </Decision>
      </Card>
      <Card>
        <Decision title="Respond to an issue" who="You (options above your limit: the board)" hint="Problems with documented response options: tests, redesigns, campaigns, investigations. The Projects page shows each issue in full.">
          {d.issues.filter((i: any) => i.options.length).length === 0 ? <Empty>No open issues with options.</Empty> : (
            <>
              <label className="field" style={{ marginBottom: 8 }}>Issue<select value={iss} onChange={(e) => setIss(e.target.value)}>{d.issues.filter((i: any) => i.options.length).map((i: any) => <option key={i.id} value={i.id}>{i.title} ({i.severity})</option>)}</select></label>
              <div className="list">
                {issue?.options.map((o: any) => (
                  <div key={o.key} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}><div className="small strong">{o.label}</div><div className="tiny muted">{o.description}</div></div>
                    <span className="small num">{o.costCents ? fmtEur(o.costCents) : 'no direct cost'}</span>
                    <button className="btn sm" onClick={() => propose('address_issue', { issueId: issue.id, optionKey: o.key })}>Preview…</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </Decision>
      </Card>
      <Card>
        <Decision title="Cancel a project" who="You (vehicle programmes and projects with >€50m spent: the board)" hint="Engineers return to the pool; capitalised spend is written off.">
          <div className="form-grid">
            <label className="field">Project<select value={can.p} onChange={(e) => setCan({ ...can, p: e.target.value })}>{live.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Reason<input type="text" value={can.why} onChange={(e) => setCan({ ...can, why: e.target.value })} /></label>
            <div><button className="btn danger" disabled={can.why.trim().length < 3} onClick={() => propose('cancel_project', { projectId: can.p, reason: can.why.trim() })}>Preview…</button></div>
          </div>
        </Decision>
      </Card>
      <div className="small muted">Project details, milestones and history: <a href="#" onClick={(e) => { e.preventDefault(); go('projects'); }}>Projects</a>.</div>
    </div>
  );
}

function Money({ d }: { d: any }) {
  const { propose } = useGame();
  const [rcfAmt, setRcf] = useState('');
  const [fin, setFin] = useState({ kind: 'bank_term_loan', m: '', tenor: '5', why: '' });
  const offers = d.financing.filter((f: any) => f.status === 'offered');
  return (
    <div className="stack">
      <Card>
        <Decision title="Draw or repay the credit line" who="You — immediate" hint={<>The €500m revolving credit facility (RCF): {fmtEur(d.rcf.availableCents)} available, {fmtEur(d.rcf.drawnCents)} drawn. Drawing raises cash but not liquidity (undrawn credit already counts).</>}>
          <div className="form-grid">
            <label className="field">Amount (€m)<input type="number" min={1} value={rcfAmt} onChange={(e) => setRcf(e.target.value)} /></label>
            <div className="row">
              <button className="btn" disabled={!(num(rcfAmt) > 0)} onClick={() => propose('request_financing', { kind: 'rcf_draw', amountCents: Math.round(num(rcfAmt) * 1e8), rationale: 'Liquidity buffer' })}>Draw…</button>
              <button className="btn" disabled={!(num(rcfAmt) > 0)} onClick={() => propose('request_financing', { kind: 'rcf_repay', amountCents: Math.round(num(rcfAmt) * 1e8), rationale: 'Reduce interest cost' })}>Repay…</button>
            </div>
          </div>
        </Decision>
      </Card>
      <Card>
        <Decision title="Raise financing" who="You up to €100m of bank debt; bonds, equity and asset sales: the board" hint="Lenders and investors review the request and answer with an offer (or a refusal) after a few weeks; you then accept or decline the offer below. Board approval, where needed, comes first.">
          <div className="form-grid">
            <label className="field" style={{ gridColumn: '1 / -1' }}>Type<select value={fin.kind} onChange={(e) => setFin({ ...fin, kind: e.target.value })}>{FINANCING_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">Amount (€m)<input type="number" min={1} value={NO_AMOUNT.includes(fin.kind) ? '' : fin.m} disabled={NO_AMOUNT.includes(fin.kind)} placeholder={NO_AMOUNT.includes(fin.kind) ? 'not needed' : ''} onChange={(e) => setFin({ ...fin, m: e.target.value })} /></label>
            <label className="field">Tenor (years)<input type="number" min={1} max={10} value={fin.tenor} onChange={(e) => setFin({ ...fin, tenor: e.target.value })} /></label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Purpose (shown to lenders)<input type="text" value={fin.why} onChange={(e) => setFin({ ...fin, why: e.target.value })} placeholder="e.g. Refinance the 2028 bond" /></label>
            <div><button className="btn primary" disabled={!NO_AMOUNT.includes(fin.kind) && !(num(fin.m) > 0)} onClick={() => propose('request_financing', { kind: fin.kind, amountCents: NO_AMOUNT.includes(fin.kind) ? 0 : Math.round(num(fin.m) * 1e8), tenorYears: Math.round(num(fin.tenor) || 5), rationale: fin.why.trim() || 'Financing request' })}>Preview…</button></div>
          </div>
        </Decision>
      </Card>
      <Card>
        <Decision title="Respond to a financing offer" who="You (the board if the original request needed it)">
          {offers.length === 0 ? <Empty>No offers waiting. Offers arrive here (and in Finance) after lenders review a request.</Empty> : (
            <div className="list">
              {offers.map((f: any) => (
                <div key={f.id} className="list-item">
                  <div style={{ flex: 1 }}><div className="small strong">{titleCase(f.kind)} — {f.counterparty}</div><div className="tiny muted">Offer {fmtEur(f.offer.amountCents)} at {(f.offer.rateBps / 100).toFixed(2)}%, valid until {fmtDate(f.offer.validUntil)}</div></div>
                  <button className="btn sm primary" onClick={() => propose('accept_financing', { financingId: f.id })}>Accept…</button>
                  <button className="btn sm" onClick={() => propose('decline_financing', { financingId: f.id })}>Decline…</button>
                </div>
              ))}
            </div>
          )}
        </Decision>
      </Card>
    </div>
  );
}

function Deals({ d }: { d: any }) {
  const { propose, go } = useGame();
  return (
    <div className="stack">
      <Card>
        <Decision title="Negotiate" who="You — offers go to the counterparty" hint="Open a negotiation, then make offers term by term (Inbox → Negotiations, or from a meeting with the counterparty). An agreement still has to be signed.">
          <div className="list">
            {d.negotiations.filter((n: any) => n.status === 'open').map((n: any) => (
              <div key={n.id} className="list-item">
                <div style={{ flex: 1 }}><div className="small strong">{n.title}</div><div className="tiny muted">with {n.counterpartyName}{n.deadline ? ` · deadline ${fmtDate(n.deadline)}` : ''}</div></div>
                <button className="btn sm primary" onClick={() => go('inbox', n.id)}>Make an offer</button>
              </div>
            ))}
            {d.negotiationTemplates.filter((t: any) => !t.open).map((t: any) => (
              <div key={t.key} className="list-item">
                <div style={{ flex: 1 }}><div className="small">{t.title}</div><div className="tiny muted">with {t.counterpartyName}{t.unavailable ? ` — ${t.unavailable}` : ''}</div></div>
                <button className="btn sm" disabled={!!t.unavailable} onClick={() => propose('open_negotiation', { templateKey: t.key })}>Start…</button>
              </div>
            ))}
          </div>
        </Decision>
      </Card>
      <Card>
        <Decision title="Sign an agreed contract" who="You (the board above your limit)" hint="An agreement reached at the table has no effect until it is signed.">
          {d.contractsToSign.length === 0 ? <Empty>Nothing to sign.</Empty> : (
            <div className="list">
              {d.contractsToSign.map((c: any) => (
                <div key={c.id} className="list-item">
                  <div style={{ flex: 1 }}><div className="small strong">{c.title}</div><div className="tiny muted">{c.counterpartyName}</div></div>
                  <button className="btn sm primary" onClick={() => propose('sign_contract', { contractId: c.id })}>Sign…</button>
                </div>
              ))}
            </div>
          )}
        </Decision>
      </Card>
    </div>
  );
}

export function Board({ d, preselect }: { d: any; preselect?: string[] }) {
  const { propose } = useGame();
  const [bp, setBp] = useState({ title: '', kind: 'strategy', rationale: '' });
  const [ids, setIds] = useState<string[]>(preselect ?? []);
  const [meet, setMeet] = useState('');
  useEffect(() => setIds(preselect ?? []), [preselect]);
  const drafts = d.drafts.filter((a: any) => !['issue_board_proposal', 'call_board_meeting', 'negotiate_contract', 'make_promise', 'resolve_commitment'].includes(a.type));
  const toggle = (id: string) => setIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  return (
    <div className="stack">
      <div className="callout info small">
        You rarely need this form: when a single decision is above your authority, confirming it submits it to the board automatically and it is carried out if approved. Use a <strong>board plan</strong> to have several drafted decisions voted together, or to ask for endorsement of a strategy.
      </div>
      <Card>
        <Decision title="Put a plan to the board" who={`Voted on ${fmtDate(d.submissionMeeting)}`} hint="Tick the drafted decisions the plan contains: if the board approves, all of them are carried out that day; if it rejects, none are. A plan with no decisions is an endorsement only — it changes nothing except board confidence.">
          <div className="stack" style={{ gap: 8 }}>
            <div className="form-grid">
              <label className="field" style={{ gridColumn: '1 / -1' }}>Title<input type="text" value={bp.title} onChange={(e) => setBp({ ...bp, title: e.target.value })} placeholder="e.g. Turnaround plan 2027" /></label>
              <label className="field">Type<select value={bp.kind} onChange={(e) => setBp({ ...bp, kind: e.target.value })}><option value="strategy">Strategy</option><option value="recovery_plan">Recovery plan</option><option value="other">Other</option></select></label>
            </div>
            <label className="field">Your case for the board (at least 20 characters)<textarea rows={3} value={bp.rationale} onChange={(e) => setBp({ ...bp, rationale: e.target.value })} placeholder="What it achieves, what it costs, what the alternatives are…" /></label>
            <div>
              <div className="small strong" style={{ marginBottom: 4 }}>Decisions in this plan</div>
              {drafts.length === 0 ? <div className="tiny muted">No drafts yet. Prepare decisions with “Preview…” in the other areas and close the review without confirming — they stay as drafts and appear here.</div> : drafts.map((a: any) => (
                <label key={a.id} className="row small" style={{ gap: 6, marginBottom: 2 }}>
                  <input type="checkbox" checked={ids.includes(a.id)} onChange={() => toggle(a.id)} />
                  <span>{a.summary}</span>
                  {a.needsBoard && <span className="pill warning">board</span>}
                </label>
              ))}
            </div>
            <div><button className="btn primary" disabled={bp.title.trim().length < 5 || bp.rationale.trim().length < 20} onClick={() => propose('issue_board_proposal', { title: bp.title.trim(), kind: bp.kind, rationale: bp.rationale.trim(), actionIds: ids })}>Preview…</button></div>
          </div>
        </Decision>
      </Card>
      <Card>
        <Decision title="Call an extraordinary board meeting" who="You" hint={`Brings a vote forward. At least 7 days' notice, before the next regular meeting (${fmtDate(d.nextBoardMeeting)}).`}>
          <div className="row">
            <input type="date" value={meet} min={addDays(d.today, 7)} onChange={(e) => setMeet(e.target.value)} aria-label="Meeting date" />
            <button className="btn" disabled={!meet} onClick={() => propose('call_board_meeting', { date: meet, reason: 'Decisions that cannot wait for the regular meeting' })}>Preview…</button>
          </div>
        </Decision>
      </Card>
    </div>
  );
}

function InProgress({ d, reload }: { d: any; reload: () => void }) {
  const { reviewAction, go, toast, refresh } = useGame();
  const execute = async (id: string) => {
    try {
      const r = await api.post(`/actions/${id}/execute`);
      toast(r.message, r.ok ? 'success' : 'error');
      reload();
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (!d.inProgress.length) return <Empty>Nothing in motion. Decisions with a future effect (board votes, hires arriving, consultations, lender reviews…) appear here with their dates.</Empty>;
  return (
    <Card flush>
      <div className="list">
        {d.inProgress.map((x: any, i: number) => (
          <div key={i} className="list-item progress-item" style={{ alignItems: 'flex-start' }}>
            <div className="num small progress-date">{x.date ? fmtDate(x.date) : '—'}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small strong">{x.title}</div>
              <div className="tiny sub">{x.detail}</div>
              {x.outlook && <BoardOutlook o={x.outlook} compact />}
            </div>
            <div className="row progress-actions">
              {x.kind === 'approved_waiting' && x.actionId && x.executable && <button className="btn sm primary" onClick={() => execute(x.actionId)}>Execute now</button>}
              {x.actionId && <button className="btn sm" onClick={() => reviewAction(x.actionId)}>Details</button>}
              {x.link && <button className="btn sm ghost" onClick={() => go(x.link.page, x.link.param)}>Open</button>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Decisions() {
  const { data: d, error, reload } = useView<any>('/decisions');
  const { nav, reviewAction } = useGame();
  const [tab, setTab] = useState<Tab>('take');
  const [area, setArea] = useState<Area>('people');
  const [bundle, setBundle] = useState<string[]>([]);
  useEffect(() => {
    if (!nav.param) return;
    if (['take', 'drafts', 'progress', 'recent'].includes(nav.param)) setTab(nav.param as Tab);
    else if (AREAS.some(([a]) => a === nav.param)) {
      setTab('take');
      setArea(nav.param as Area);
    }
  }, [nav.param]);
  if (!d) return <Loading error={error} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Decisions</h1>
          <p>Everything you can decide, in one place. “Preview…” never changes anything: it shows the calculated consequences, who has to approve, and what happens next. Only “Approve &amp; execute” or “Submit to the board” acts.</p>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[['take', 'Take a decision'], ['drafts', `Your drafts (${d.drafts.length})`], ['progress', `In progress (${d.inProgress.length})`], ['recent', 'Recent decisions']]} />
      {tab === 'take' && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(180px, 220px) minmax(0, 1fr)' }}>
          <Card flush>
            <div className="list" role="tablist" aria-label="Decision areas">
              {AREAS.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={area === k} className={`list-item clickable area-btn ${area === k ? 'active' : ''}`} onClick={() => setArea(k)}>{l}</button>
              ))}
            </div>
          </Card>
          <div>
            {area === 'people' && <People d={d} />}
            {area === 'products' && <Products d={d} />}
            {area === 'production' && <Production d={d} />}
            {area === 'projects' && <Projects d={d} />}
            {area === 'money' && <Money d={d} />}
            {area === 'deals' && <Deals d={d} />}
            {area === 'board' && <Board d={d} preselect={bundle} />}
          </div>
        </div>
      )}
      {tab === 'drafts' && (
        <Card flush sub="Proposals you previewed but did not confirm, and proposals made by your team in meetings. Nothing happens until you confirm one.">
          {d.drafts.length === 0 ? <Empty>No drafts.</Empty> : (
            <>
              <div className="list">
                {d.drafts.map((a: any) => (
                  <div key={a.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <input type="checkbox" aria-label={`Select ${a.summary}`} checked={bundle.includes(a.id)} onChange={() => setBundle((x) => (x.includes(a.id) ? x.filter((y) => y !== a.id) : [...x, a.id]))} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="small strong">{a.summary}{a.needsBoard && <span className="pill warning" style={{ marginLeft: 6 }}>board</span>}</div>
                      <div className="tiny muted">{a.source === 'llm_proposal' ? `Proposed in a meeting by ${d.characters.find((c: any) => c.id === a.actorId)?.name ?? 'a colleague'}` : 'Your draft'} · {fmtDate(a.simDate)}</div>
                      <div className="tiny sub">{a.nextStep}</div>
                    </div>
                    <button className="btn sm primary" onClick={() => reviewAction(a.id)}>Review…</button>
                  </div>
                ))}
              </div>
              <div className="row" style={{ padding: 10 }}>
                <span className="small muted">{bundle.length} selected</span>
                <button className="btn sm" disabled={bundle.length === 0} onClick={() => { setTab('take'); setArea('board'); }}>Put the selected drafts to the board as one plan…</button>
              </div>
            </>
          )}
        </Card>
      )}
      {tab === 'progress' && <InProgress d={d} reload={reload} />}
      {tab === 'recent' && (
        <Card flush>
          {d.recent.length === 0 ? <Empty>No decisions yet.</Empty> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Decision</th><th>Status</th><th className="num">Took effect</th><th>What it means</th><th></th></tr></thead>
                <tbody>
                  {d.recent.map((a: any) => (
                    <tr key={a.id}>
                      <td className="small strong">{a.summary}</td>
                      <td><Status s={a.status} label={a.status === 'committed' ? 'Done' : undefined} /></td>
                      <td className="num"><D d={a.effectiveDate ?? a.simDate} /></td>
                      <td className="tiny sub">{a.nextStep}</td>
                      <td><button className="btn sm ghost" onClick={() => reviewAction(a.id)}>Details</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
