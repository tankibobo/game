# Automanager: The Weight of Decisions

A single-player automotive CEO simulator. You run **Asterion Automotive**, a fictional
European car maker (€7.5bn revenue, 18,000 employees, three plants), from 1 January 2027.
You talk to executives, directors, the union, banks and suppliers in natural language —
and every consequence is decided by a rules-based simulation, not by the language model.

> **Core principle:** the LLM may *propose* what should happen; only the simulation
> engine decides what *actually* happens.

---

## Quick start

Requirements: Node.js ≥ 20 (tested on 22), npm. No database server — SQLite is embedded.

```bash
npm install
claude                      # once: type /login and sign in with your Claude subscription
cp .env.example .env        # optional — the subscription provider is the default
npm run dev                 # API on :8787 + Vite UI on http://localhost:5173
```

### Claude from your subscription (no API key)

Characters are voiced by Claude **through your Claude subscription** (Pro, Max, Team or
Enterprise), using the same login as Claude Code — no API key, no per-token billing.

1. `npm install` (installs the Claude Agent SDK, which bundles the Claude Code engine).
2. Sign in once: run `claude` in a terminal (`npm i -g @anthropic-ai/claude-code` if you
   don't have it), type `/login`, and choose your Claude account. If you already use
   Claude Code on this computer you are done.
3. Start the game. **Saves → Claude → Test Claude connection** makes one tiny round trip
   and shows which model answered.

How it works: `server/llm/claudeCode.ts` runs each character turn as a one-shot,
locked-down Claude Code session — no tools, no MCP servers, no CLAUDE.md or settings
loaded from disk, no session files written — with the character's system prompt and the
JSON Schema of the turn as structured output. The reply is validated exactly like any
other LLM output. `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are stripped from that
process because Claude Code would otherwise prefer the key over your subscription.

Notes: each reply uses a little of your plan's usage (limits shared with Claude Code and
claude.ai); a turn takes a few seconds because a session starts per call. If you are not
signed in or hit a limit, the UI says so and characters fall back to the deterministic
responder — the simulation never depends on Claude. Subscription login is meant for your
own, personal local play; don't host the game for other people on your account.

Production-style single process (builds the UI, serves UI + API on one port):

```bash
npm start                   # → http://localhost:8787
```

On first launch, click **Start new game**. Progress is written continuously to
`data/saves/<slot>.sqlite`; restarting the server resumes the active save.

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) + Vite dev server with proxy |
| `npm start` | Build the client, then serve UI + API (`NODE_ENV=production`) |
| `npm run serve` | Serve an already-built client + API |
| `npm test` | Run the automated test suite (Vitest) |
| `npm run typecheck` | TypeScript check of server, client, shared and tests |
| `npm run playthrough` | Play ~12 months as a scripted CEO; writes `docs/PLAYTHROUGH.md` |
| `npm run calibrate` | Engine-only calibration run (prints a simulated year) |

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `claude-code` | `claude-code` (your Claude subscription), `anthropic` (API key) or `none` (deterministic mode) |
| `CLAUDE_MODEL` | account default | Subscription provider model: `opus`, `sonnet`, `haiku` or a full model ID |
| `CLAUDE_EFFORT` | `low` | Subscription provider reasoning effort (`low`/`medium`/`high`) |
| `CLAUDE_CODE_PATH` | bundled | Use a specific `claude` executable instead of the SDK's bundled one |
| `ANTHROPIC_API_KEY` | — | Only for `LLM_PROVIDER=anthropic`. Read only by the server; never sent to the browser. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model for character dialogue and argument assessment |
| `ANTHROPIC_EFFORT` | `low` | Reasoning effort (`low`/`medium`/`high`) |
| `ANTHROPIC_FALLBACKS` | `on` | Server-side refusal fallback (`server-side-fallback-2026-07-01` beta). Automatically disabled if the API rejects it. |
| `LLM_TIMEOUT_MS` | `120000` (`claude-code`) / `60000` | Per-call timeout |
| `PORT` | `8787` | API port |
| `DATA_DIR` | `./data` | Where save files live |

**Deterministic mode.** With `LLM_PROVIDER=none` (or whenever Claude is unreachable) the game is fully playable: characters answer
through a rule-based responder (intent patterns + templated, in-character replies built
from authoritative facts) that produces the same structured proposals as the LLM path.
The UI labels this mode clearly ("Deterministic mode" badge; each reply is tagged
`deterministic` or `LLM`). If an LLM call times out, is rate-limited or returns malformed
output, that single turn falls back to the deterministic responder; game state is never
partially updated.

---

## How to play

New to the game? The dashboard opens with a **Getting started** card. Two buttons in the top
bar are always there:

- **? Coach** — a guide who sits *outside* the game (no character hears it). Ask it anything:
  how to do something (“How do I hire more people?”), why something happens (“Why am I losing
  money?”, “Is my marketing working?” — answered from the company's own reports), or what to
  do next. Its **read of your company** shows where board confidence is heading and what to
  look at first, with the reasoning; the exact steps and a ready-made preview appear only when
  you click **Show me how**. The advice is computed by the engine (never invented), and an
  automated player that simply follows it wins every scenario (see *Testing*). With Claude
  available the answers are phrased by Claude from the manual, the live figures and that
  analysis.
- **Ask someone** — a quick question to anyone, no meeting needed. Executives answer from
  their own department's figures and attach the report (figures, tables, charts); “Continue as
  a meeting” turns it into a conversation.

### Scenarios, difficulty and seeds — and how to win

A new game (start screen, or **Saves → Start a new game**) starts from one of five
situations: **The Turnaround** (the original), **A Steadier Start** (gentler: Voltaris
signed, more cash — good for learning), **Cash Crunch**, **Electric Rush** and **Labour
Crisis** (tougher). Pick a difficulty — **Relaxed** (patient board: three meetings below 12
to dismiss you, renewal at 50/100), **Standard** (two meetings below 20, renewal at 60) or
**Hard** (two below 25, short honeymoon, renewal at 65) — and optionally a seed (chance
events; the same seed replays the same luck).

You are hired for a **three-year mandate**. On 31 December 2029 the board scores it out of
100 across seven objectives — board confidence (20), the Eon launch (20), the Vela under
Euro 7 (10), refinancing the 2028 bond (15), operating profit vs budget (15), the liquidity
buffer (10), keeping your word (10). Reach the pass mark and your contract is renewed: you
win and may keep playing. Fall short, go insolvent, or lose the board's confidence at
consecutive meetings and the game ends. The dashboard's **Your mandate** card shows the
score if you were judged today.

- **Time** only moves when you press **+1 day / +1 week / +1 month**. Each advance ends with
  a CEO briefing: what was built and sold, cash, what needs attention, what was carried out
  and what is coming up.
- **Decisions** (sidebar) is the one place for everything you can decide, grouped by area
  (people & communication, products & pricing, production, projects & issues, money, deals,
  board). **Preview…** never changes anything: the review shows the calculated consequences,
  who must approve, *what happens next*, and — for board items — how each director is likely
  to vote and why. Then **Approve & execute**, **Submit to the board**, **Keep as draft**,
  **Change parameters** (re-checked from scratch) or **Reject**. Other pages show the state of
  the company and link here (“Change in Decisions →”); only actions on one specific item (approve
  *this* project, answer *this* issue) also sit next to the item.
- **The board.** Decisions above your authority (spending >€50m, bank debt >€100m, hiring
  >500, restructuring >300 positions, bonds, equity, asset sales, cancelling a vehicle
  programme) are put to the next meeting automatically when you confirm them and **carried
  out on the meeting day if approved**. To have several decisions voted together, tick your
  drafts into a **board plan** (Decisions → Board); a plan without decisions is an
  endorsement only and changes nothing by itself. If an approved decision cannot run on the
  day (e.g. the engineers it needs are busy), it waits with the reason under
  **Decisions → In progress**, is retried after every time advance and can be run with
  **Execute now**; approvals stay valid for 90 days.
- **In progress** lists everything already set in motion, with dates: board votes, hires
  arriving, consultations ending, lender reviews, agreements to sign, approved decisions
  waiting. **Recent decisions** shows what was carried out, rejected or withdrawn.
- **Meetings** (People & divisions → *Meet*, or Inbox → Meetings): talk naturally — ask, instruct,
  persuade, promise. Characters push back when their incentives or the facts warrant it.
  Concrete proposals they make appear under their reply (and in Decisions → Your drafts).
  They know what the leadership knows: your recent decisions, the board agenda, and the gist
  of your meetings with their colleagues.
- **Documents.** A document is one or more reports from a described catalogue (P&L
  breakdown, margin per car, cash, forecast, debt, sales, market, marketing performance,
  production, supply, quality, CO₂, workforce, projects, one project, contracts, a
  negotiation, a board proposal, the decision log) plus an optional memo — each can be
  previewed before sending (in a meeting, People & divisions → Share a document, or Decisions →
  People & communication). Every report is built from the live simulation: figures, tables
  and charts with a “Show the numbers” table. Colleagues also exchange documents among
  themselves and with you; when they need something they ask for a report by name and a
  **Send it** button appears under their reply.
- **Your executives act on their own.** The CFO and the sales director report every month,
  operations, HR and engineering every quarter (report attached); they prepare decisions when
  they see a problem (production, a campaign, hiring, funding — in Decisions → Your drafts,
  “Prepared on their own initiative”), react to what you do (price changes, cuts, cancelled
  projects or deals, signed contracts), remind you of deadlines and chase unsigned agreements.
- **Deals** (Decisions → Deals & contracts): open talks yourself — supply contracts, the wage
  agreement, dealer support, **fleet orders** with a rental & leasing company (cars delivered
  from factory stock at a discount) or **contract assembly** for a competitor at Lyon (a fee
  per car, using Lyon capacity and crews). Negotiate in Inbox → Negotiations or beside a
  meeting with the counterparty: offers term by term plus an argument; they accept, counter,
  ask for internal approval or break off. You can **walk away** from talks or **decline** an
  agreement. An agreement binds nobody until it is **signed** — Legal reviews the terms in the
  signing preview; unsigned agreements are chased and lapse after 45 days.
- **Marketing**: an always-on budget (diminishing returns) and **campaigns** for one model for
  2–16 weeks. The Marketing performance report measures every campaign (extra cars, extra
  contribution) and says whether another €1m a month would pay for itself.
- **People & divisions → Divisions** explains each division — what it does, why it matters,
  its key figures right now and the decisions that belong to it (including why Legal makes
  you sign contracts).
- **News**: the trade paper — each month's results, market shares, competitors' promotions,
  recalls and failures, tariffs and regulation, our share price — each with “What it means for
  Asterion”. Competitors' moves really change demand; the share price follows results,
  liquidity, the Eon and board confidence (and prices any rights issue).
- **Projects**: approve, start from the catalogue (sixteen projects, each saying what it will
  change and why it cannot start now, if it cannot), or **design your own** (what to improve,
  where, how big — the engine sizes it and the real result is 60–120% of the estimate);
  re-plan or cancel; act on issues via their documented options. Every completed project
  changes the simulation (costs, crews, capacity, appeal, quality, CO₂, features of the cars,
  marketing efficiency, reach) and its **What it changed** card shows the measured
  before → after; the people affected react (the union over automation, dealers over online
  sales). Completed catalogue projects are no longer offered. The Vela mild-hybrid refresh replaces the proposed Euro 7
  compliance project if that one was never approved.
- **Finance**: **Where the money goes** (a waterfall from revenue to net income, every cost
  line with its share of revenue, monthly results, break-even volume, margin per car by model
  — the full-year forecast before the first month closes), statements straight from the ledger, 3-scenario forecasts, debt & covenants,
  financing requests (bank loan, bond, rights issue, shareholder loan, sale-and-leaseback,
  covenant waiver, RCF extension, personal investment, RCF). Time pauses when an offer
  arrives — offers expire within days.
- **Saves**: progress is always persisted; *Save snapshot* copies the current game into a
  separate slot; load or delete slots there.

**The opening situation** (see the Inbox): Lyon overproduces the ageing Vela; the Vela must
be certified for Euro 7 by 29 Nov 2027 or become unsellable; the Kora hybrid has an
unexplained inverter fault; the Eon EV is late, stuck in thermal validation and short of
battery supply (Voltaris will only commit 140 packs/day); the wage agreement expires
31 March; a €900m bond matures in Nov 2028; the board meets on 28 January.

**Failure states.** *Insolvency* (≥10 days unable to pay >€25m of overdue obligations, or a
debt payment default), *dismissal* (board confidence below the difficulty's line at
consecutive regular meetings — after a formal warning; any meeting above the line resets the
count) and *non-renewal* (mandate score below the pass mark at the final review). Recovery routes exist before both: RCF, bank loans,
equity, asset sales, covenant waivers, production cuts.

**Strategies** with concrete costs and trade-offs: hybrid transition (Vela mild-hybrid),
premium positioning (Kora GT), EV leadership (second battery source, Brno expansion,
compact EV "Nova"), operational restructuring (Lyon automation, workforce programmes),
profitability over volume (pricing, quality programme, production discipline), financial
turnaround (refinancing, sale-and-leaseback, equity). Competitors respond to price cuts.

---

## Architecture

```
client/ (React + Vite + Recharts)          UI only: renders read models, sends proposals
   │  HTTP /api (JSON)
server/
  api/routes.ts          Express routes; request validation (Zod)
  game/game.ts           ★ The only code path that mutates a save:
                           propose → validate → preview → confirm → commit (one transaction)
  game/queries.ts        Read models for the UI (private data stripped)
  game/decisions.ts      The Decisions view: catalogue data, drafts, everything in progress
  game/documents.ts      Shareable documents and memos (snapshots of authoritative data)
  guide/                 The how-to guide: manual.ts (step-by-step entries) + guide.ts
  game/saves.ts          Save slots (one SQLite file each)
  actions/               D. Action validator & transaction layer
    registry.ts            22 typed actions + authority checks
    defs/*.ts              validate / preview / commit per action
    templates.ts           project catalogue
  engine/                B. Deterministic simulation engine (no I/O, no LLM)
    tick.ts                daily ordered processing
    demand.ts sales.ts operations.ts projects.ts treasury.ts close.ts
    events.ts board.ts negotiation.ts financing.ts commitments.ts forecast.ts
    ledger.ts accounts.ts metrics.ts rng.ts params.ts world.ts
  llm/                   C. LLM interaction layer
    provider.ts            provider abstraction (Anthropic API, none, scripted test double)
    claudeCode.ts          Claude via your subscription (Claude Agent SDK, tool-less session)
    config.ts              provider selection from the environment
    context.ts             bounded, prioritised, epistemically-labelled context builder
    conversation.ts        orchestration + validation of every LLM output field
    fallback.ts            deterministic responder
    schemas.ts             output contracts (JSON Schema + Zod)
  db/                    A + E. Authoritative state & memory
    migrations/001_init.sql  generated from tables.ts (see scripts/gen-migration.ts)
    migrations/002–003       board plans with several decisions; shared documents
    repo.ts                load/persist the world atomically; append-only outputs
  scenario/              The coherent 2027 starting world + opening inbox
shared/                  domain types, money (integer cents), dates
tests/                   Vitest suites (engine, validator, persistence, LLM safety, acceptance)
```

### The five layers

**A. Authoritative world state (SQLite).** ~27 typed tables (models, segments, competitors,
factories, lines, suppliers, component supplies, departments, characters, relationships,
projects, milestones, issues, commitments, debt instruments, covenants, receivables,
payables, contracts, negotiations, financing requests, board proposals, regulations, event
states, game meta, macro). All money is **integer euro cents**; rates are applied with
BigInt-backed rounding (`shared/money.ts`).

**B. Deterministic engine.** Pure functions over an in-memory `World` loaded from SQLite.
Randomness is *keyed*: a draw is a hash of `(seed, date, purpose, entity)`, so outcomes are
reproducible and **independent of how you chunk time** (30 × "+1 day" ≡ "+1 month", tested).
Each day is processed in a fixed order:

1. scheduled items (regulations, supplier capacity changes, hires/leavers, counterparty decisions, financing reviews)
2. projects (progress, spend, milestone gates)
3. production (supplier deliveries → line output)
4. sales/deliveries, dealer receipts, payments, debt service, automatic RCF treasury
5. commitments & contractual obligations
6. issue upkeep (investigations, deadlines)
7. event eligibility (causal events, bounded seeded shocks)
8. board meeting (if scheduled)
9. month-end close (payroll, overhead, depreciation, interest, tax, CO₂, snapshot, covenants)
10. project forecasts, terminal checks

**C. LLM layer.** For every message a context package is built from the database in
priority order within a token budget (header → character profile → commitments → projects
→ issues → operations/finance by access rights → negotiations → recent events (event
ledger) → character memories (FTS5 relevance + importance + recency) → rules & action
catalogue). Lines are labelled `[FACT]`, `[EST]`, `[BELIEF]`, `[RUMOR]`, `[UNKNOWN]`.
External parties (union, banks, suppliers, regulator) only see what their role plausibly
gives them; characters' private facts are included only above a trust threshold, and
counterparties never see their own walk-away numbers expressed as instructions to reveal.
The model returns structured JSON (`CharacterTurn`: dialogue, perspective, proposed
actions, claims with epistemic basis, memory candidates, CEO commitments, escalation
proposals, bounded trust delta, summary update).

**D. Validator & transactions.** Every LLM proposal and every UI action goes through the
same pipeline: schema parse → `validate` (facts, resources, prerequisites, deadlines,
contracts) → `preview` (computed consequences & approvals) → authority check (CEO limits,
delegated limits per character, board rules) → commit of all related changes in **one
SQLite transaction** → event-ledger entry. Invalid proposals are recorded with their
errors and change nothing. Proposals ≠ agreements: a financing request is a review, an
accepted negotiation is an unsigned contract; only signature/execution moves money.
Idempotency keys make retried requests safe.

**E. Memory & audit.** Append-only (DB triggers) event ledger with entity index and FTS5
search; append-only journal; append-only project history (original deadlines are never
erased); character memories (FTS5); action/decision log including invalid proposals;
commitments; conversations and messages with running summaries; monthly financial
snapshots; stored forecasts; `llm_calls` audit table.

### LLM output safety (what the backend enforces)

- Unknown action types / bad parameters → recorded as invalid, nothing changes.
- External characters cannot propose company decisions; nobody but the CEO advances time.
- Claims are cross-checked: "the contract is signed", "validation is complete", "€80m was
  transferred", "the board approved" are compared with the database and flagged in the UI
  when unsupported.
- Trust changes are clamped (±2 per reply); memories are bounded; escalation events must be
  `proposable` catalogue entries whose preconditions hold — and they are applied by the
  engine at the next tick.
- Negotiation outcomes are computed by the engine *before* the LLM narrates them; the
  argument-quality modifier (−0.05…+0.10) is assessed server-side and counts only when
  backed by entity IDs that exist.

---

## Simulation model (summary)

**Demand.** Per segment, multinomial logit:
`u = appeal/20 + (quality−70)/40 + (satisfaction−70)/50 − elasticity·ln(price/ref) + ln(powertrainPref) + distribution + 0.12·ln(marketing/€8m)`;
appeal decays with model age; powertrain preference drifts toward BEV each year (plus
subsidy regulations); the "other brands" utility is calibrated once at scenario creation so
starting volumes match FY2026. Seasonality, macro confidence and shocks scale the market.
Euro 7: non-compliant models cannot be registered after 29 Nov 2027.

**Sales.** Daily retail from dealer stock (seeded noise, partial backlog, cancellations).
Dealers order the seasonal flow plus a correction toward 45 days of (deseasonalised) stock,
capped at 95 days. **Revenue is recognised on wholesale delivery to dealers**; dealers pay
in 30 days.

**Production.** Working days only (weekends, public holidays, planned shutdowns, strikes).
Output = planned rate × ramp-up × workforce availability (headcount × (1−absenteeism) vs
crew requirement) × small random losses, capped by critical-component stock. Components are
supplier-owned consignment stock until consumed; a disruption only affects models using that
component.

**Projects.** Work in FTE-days; capacity = effective FTE (Brooks's law exponent 0.72 above
plan) × productivity × morale. Open issues absorb a share of capacity until worked off.
Milestones close in order only when work is done and gates hold (issue resolved, battery
supply ≥ 250/day contracted, not-before dates). Forecast = deterministic replay (P50) plus a
risk buffer (P80).

**Accounting (documented simplifications).**
- Double-entry ledger; debit positive. Trial balance and A = L + E checked in tests.
- Inventory at material cost (variable costing): labour and plant overhead are period costs.
- Warranty provision accrued per vehicle (quality-adjusted), claims paid monthly.
- Payroll from headcount-days (pro-rated hires/leavers), paid at month end.
- Interest accrued monthly from principal-days, paid on coupon dates; amortisation and
  maturities scheduled; RCF commitment fee; automatic RCF draw/sweep by treasury policy.
- Depreciation: legacy base €25m/month + new capex over 10 years; capitalised development
  amortised over 6 years from SOP.
- Tax 25% of YTD profit after loss carry-forward, paid quarterly; CO₂ excess premium
  (€95/g/km/vehicle) provisioned monthly on YTD fleet average, paid in April.
- Cash flow statement uses the direct method from cash lines tagged operating/investing/financing.
- Sale-and-leaseback is treated as a sale with an operating lease (not full IFRS 16).

**Finance & institutions.** Covenants (net leverage ≤3.5x, interest cover ≥3.0x, minimum
liquidity €400m) tested quarterly on LTM figures (pre-game months use the FY2026 baseline).
A breach blocks the RCF. Financing has eligibility rules, timelines, prices and rejections
(`engine/financing.ts`). A "personal investment" by the CEO is limited to verified personal
liquid assets (€2.8m) and needs related-party approval.

**Board.** Six voting directors with explicit priority weights. Each vote is a deterministic
function of what the proposal itself does — its up-front cash and recurring profit effect,
jobs, dilution, execution risk, strategic fit and how unavoidable it is (legal compliance, a
blocked programme, a crew shortage) — plus trust in the CEO, board confidence, CFO support,
the written case (bounded) and a small seeded term. Tight liquidity makes directors more
sensitive to cash spent (and more appreciative of cash saved); it does not sink every
proposal. The same function, without the seeded term, produces the vote outlook shown before
you submit. Confidence trends toward a target built from the forecast vs. the board plan,
covenant status, commitments kept/broken and trust (with a 150-day new-CEO grace period); a
new budget target is set at each year end. A materially worse forecast that leaves the
company short of the plan triggers a board reaction — but not for spending the board itself
approved, and full-year figures are never compared across a year end.

**Events.** See World → Event catalogue in the UI (or `engine/events.ts`): every event lists
preconditions, kind (causal / random shock / scheduled), magnitude and cooldown.

---

## Testing

```bash
npm test
```

108 tests across twelve suites. Mapping to the acceptance criteria:

| # | Criterion | Test |
|---|---|---|
| 1 | New game is internally consistent | `finance.test.ts` › initial scenario |
| 2 | Save, close, restart, load | `persistence.test.ts` |
| 3 | No duplicated expenses/production/payments | `finance.test.ts` › time progression |
| 4 | Statements reconcile | `finance.test.ts` › statements reconcile with the ledger |
| 5 | Impossible expenditure rejected, no partial transaction | `actions.test.ts` (validation + forced mid-commit failure rollback) |
| 6 | Loan stays a proposal until approved and executed | `actions.test.ts` |
| 7 | Unauthorised approver blocked | `actions.test.ts` |
| 8 | Original deadline preserved in history | `acceptance.test.ts` |
| 9 | Ongoing project + issues retrieved later | `memory_llm.test.ts` |
| 10 | Promise remembered and surfaced near deadline | `memory_llm.test.ts` |
| 11 | Supplier event isolated to related products | `world.test.ts` |
| 12 | LLM cannot invent milestone/contract/transaction | `memory_llm.test.ts` |
| 13 | Recovery from timeout / malformed output | `memory_llm.test.ts` |
| 14 | Invalid/rejected actions leave state unchanged | `actions.test.ts` |
| 15 | Displayed figures come from authoritative state | `world.test.ts` |
| — | Scenario: delay Eon → forecast changes → board reacts → consistent after restart | `acceptance.test.ts` |
| — | Living company: completed projects change the simulation and leave the catalogue; own projects; campaigns measured; fleet orders delivered and invoiced; contract assembly; walking away / declining; unsigned agreements lapse; documents with real reports; quick questions; executives' own reports and drafts; share price, competitors and the newspaper; no duplicate submissions | `living.test.ts` |
| — | Coach outside the game: how-to, “why” from the company's figures, advice as hints | `guide.test.ts` |
| — | Board judges proposals on their merits; approved decisions are carried out (or wait with a reason); plans; endorsements; engineer conflicts | `board_flow.test.ts` |
| — | Characters share one picture: capabilities, shared documents, company knowledge | `characters.test.ts` |
| — | Guide finds the right how-to, advises from the Coach when asked, only names buttons that exist in the UI | `guide.test.ts` |
| — | Scenarios build balanced books; difficulty and consecutive strikes; final review renews/does not renew; every Coach action is a valid decision; RCF extension; time pauses on offers; wage-agreement renewal; Coach-following player safe for 8 months | `mandate.test.ts` |

**Is the game winnable?** `scripts/dev/coach-bot.ts` plays whole mandates by doing what the
Coach recommends (and negotiating within the ranges it gives). With the final code it wins
every scenario on Standard (three seeds each) and on Hard, with mandate scores of 88–94;
a passive player loses every scenario (dismissed or insolvent in 2027–28):

```bash
npx tsx scripts/dev/coach-bot.ts all standard 20270101,424242 --quiet   # follow the Coach
npx tsx scripts/dev/coach-bot.ts all standard 20270101 --passive --quiet # do nothing
```

LLM behaviour is tested with a scripted provider (canned/malformed/failed responses) and the
subscription provider with a fake Claude Code session (`claude_code.test.ts`: locked-down
options, API key never passed on, login/usage-limit/timeout handling); no network access is
needed.

---

## Limitations & simplifications

- **Limited live LLM verification.** The subscription provider was exercised once against
  the real Claude Code engine (structured output came back schema-valid), but full games
  with Claude-voiced characters were not played in the build environment. The API-key
  provider is type-checked against the official SDK but was not run against the API.
- One market (Europe), two segments; competitors are rule-based (launch timelines, price
  responses, promotions, recalls, financial distress, tariff exposure), not full agents.
- Workforce is modelled per department, not per employee; ~25 named characters.
- Inventory valuation is variable costing; no raw-material inventory; components are
  consignment stock.
- Negotiation templates cover Voltaris, the union, Hanseatic (second source and warranty
  cost-sharing) and the dealer council. Bank financing is offer/accept, not haggled.
- No acquisitions module yet (divestment is limited to the HQ sale-and-leaseback).
- The deterministic responder understands common intents (deadlines, re-plans, prices,
  production rates, hiring/cuts, financing, issue options, negotiations, promises); free-form
  nuance requires the LLM.
- Forecasts exclude random shocks and decisions not yet taken; they are labelled estimates.
- Single-user, local; no authentication.

## Project data

- Scenario: `server/scenario/initial.ts` (all starting figures, characters, contracts, debt).
- Parameters: `server/engine/params.ts`.
- Example playthrough: `docs/PLAYTHROUGH.md` (regenerate with `npm run playthrough`).
