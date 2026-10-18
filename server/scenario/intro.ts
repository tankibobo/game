/** Opening inbox: the situation the new CEO finds on 1 January 2027. */
import type { World } from '../engine/world';
import { inbox } from '../engine/world';

export function addIntroInbox(w: World): void {
  inbox(w, {
    kind: 'letter',
    fromId: 'CHR-DUBREUIL',
    subject: 'Welcome — and what the board expects',
    body: `Welcome to Asterion. You inherit a company with good people and a narrow margin for error.

The board's expectations for 2027 are simple to state and hard to deliver:
• Keep liquidity above €700m and stay inside our bank covenants.
• Get the Eon into production — the plan we approved in October says 1 October 2027.
• Present a credible refinancing plan for the €900m bond (due November 2028) at our April meeting — that means a financing request (bank loan, bond, equity…) submitted to us or to the lenders by then.
• Operating profit of around €210m.

Our next meeting is on 28 January. I would rather hear bad news early than late.

Charlotte Dubreuil, Chair`,
    priority: 'high',
    linked: [{ type: 'character', id: 'CHR-DUBREUIL' }],
  });
  inbox(w, {
    kind: 'report',
    fromId: 'CHR-HOLM',
    subject: 'Finance: where we stand',
    body: `Opening cash is €1.2bn against €2.4bn of debt; the €500m RCF is undrawn. Net leverage 2.2x vs a 3.50x covenant.

What worries me:
1. Lyon is still building ~575 Velas a day while dealers sell fewer than that and already hold ~58 days of stock. Every surplus car ties up ~€14k of cash.
2. The Eon still needs ~€300m of external spend this year.
3. If the Vela is not Euro 7 certified by 29 November 2027, the stock we hold becomes unsellable in the EU.
4. CO₂: our fleet average is above the 2027 target. Each g/km costs ~€95 per car registered.

I recommend we decide on the Vela, align Lyon's rate with retail demand, and start the refinancing work now.

Margarethe`,
    priority: 'high',
    linked: [{ type: 'character', id: 'CHR-HOLM' }],
  });
  inbox(w, {
    kind: 'report',
    fromId: 'CHR-WIERZBICKI',
    subject: 'Eon programme — honest status',
    body: `Battery-system validation is the critical path. The thermal-propagation tests on the Voltaris pack have not passed; the team is working on it but I cannot give you a date I believe in until they do.

Second, Voltaris will only commit 140 packs a day without a new agreement. We need ~250+ for the business case. Until that is signed, the SOP has no credible date at all.

Options are on the issue log. I would rather spend money on the barrier redesign than on hope.

Tomasz`,
    priority: 'high',
    linked: [{ type: 'project', id: 'PRJ-EON' }, { type: 'issue', id: 'ISS-THERMAL' }],
  });
  inbox(w, {
    kind: 'invitation',
    fromId: 'CHR-NOVAK',
    subject: 'Request for a meeting — wage agreement',
    body: `Our agreement expires on 31 March. Our members expect a real raise after two years of inflation, and guarantees for Lyon. We are ready to talk — the sooner the better.

Dragan Novak, United Metalworkers’ Confederation`,
    priority: 'normal',
    linked: [{ type: 'negotiation', id: 'NEG-UNION' }],
  });
  inbox(w, {
    kind: 'invitation',
    fromId: 'CHR-SUND',
    subject: 'Eon volumes — let us find a solution',
    body: `We want to build your Eon packs. A second module line needs funding and committed volumes. Our proposal is on the table; I am happy to meet at your convenience.

Mikael Sund, CEO, Voltaris Cells`,
    priority: 'normal',
    linked: [{ type: 'negotiation', id: 'NEG-VOLTARIS' }],
  });
  inbox(w, {
    kind: 'request',
    fromId: 'CHR-MARCHETTI',
    subject: 'Decision needed: Vela Euro 7 project and the Kora inverter',
    body: `Two things need your call:
1. The Vela Euro 7 compliance project (€42m, 160 engineers) has been waiting for approval. It takes ~10 months; if we start later than about March we will not certify in time. The alternative is the Vela mild-hybrid refresh (€165m, 220 engineers, needs the board), which includes Euro 7 and replaces the compliance project. Both are under Decisions → Projects & issues.
2. We have 37 field reports of Kora inverter shutdowns. I want either a root-cause investigation with Hanseatic or a proactive campaign. Doing nothing is a bet.

Elena`,
    priority: 'high',
    linked: [{ type: 'project', id: 'PRJ-VELA-E7' }, { type: 'issue', id: 'ISS-KORA-INV' }],
  });
}
