import { useState } from 'react';
import type { Report } from '../../../shared/report';
import { Card, Loading } from '../components/ui';
import { ReportGlance, ReportView } from '../components/ReportView';
import { useGame, useView } from '../ctx';

interface Division {
  key: string;
  name: string;
  headId: string;
  what: string;
  why: string;
  levers: [string, string][];
  report: string;
}

/** What each division does for you, how to tell whether it is working, and which decisions belong to it. */
export const DIVISIONS: Division[] = [
  {
    key: 'finance', name: 'Finance', headId: 'CHR-HOLM', report: 'pnl',
    what: 'Keeps the books, manages cash, debt and the banks, and forecasts the year. Sends you the P&L and cash position at every month end.',
    why: 'Liquidity and covenants decide whether the company survives; the board and the rating agency judge you on these figures.',
    levers: [['money', 'Draw or repay the credit line, raise financing, answer offers'], ['board', 'Put plans to the board']],
  },
  {
    key: 'sales', name: 'Sales & marketing', headId: 'CHR-GARNIER', report: 'marketing',
    what: 'Sets prices with you, runs the always-on marketing budget and campaigns, manages the dealer network and fleet customers.',
    why: 'Marketing lifts demand with diminishing returns: the first euros earn the most. Campaigns lift one model for a few weeks — and only sell if there are cars. The report below measures what each campaign returned.',
    levers: [['products', 'Change prices, launch a campaign, set the marketing budget'], ['deals', 'Negotiate fleet orders with rental and leasing companies']],
  },
  {
    key: 'operations', name: 'Operations', headId: 'CHR-MARCHETTI', report: 'production',
    what: 'Runs the plants and lines: production rates, downtime, quality and the cost of building each car.',
    why: 'Building more than dealers sell piles up stock and burns cash; building less idles paid crews. Fixed plant costs are spread over the cars built.',
    levers: [['production', 'Change line rates, plan downtime'], ['projects', 'Plant efficiency and capacity projects']],
  },
  {
    key: 'people', name: 'People (HR)', headId: 'CHR-OKAFOR', report: 'workforce',
    what: 'Hiring, restructuring, morale and the relationship with the unions; negotiates the wage agreement with you.',
    why: 'Short-staffed plants build less; low morale raises absenteeism and strike risk. Restructuring needs a consultation and sometimes the board.',
    levers: [['people', 'Hire, reduce headcount, make promises'], ['deals', 'Negotiate the wage agreement']],
  },
  {
    key: 'engineering', name: 'Engineering & projects', headId: 'CHR-WIERZBICKI', report: 'projects',
    what: 'The engineering pool and every project: new models, Euro 7 compliance, CO₂, cost and quality programmes. Reports what each completed project changed.',
    why: 'Projects are how the company changes for good. Each needs free engineers for its whole duration; completed projects change costs, capacity, appeal or features permanently.',
    levers: [['projects', 'Start a catalogue project or design your own, re-plan, cancel']],
  },
  {
    key: 'purchasing', name: 'Purchasing & supply', headId: 'CHR-LINDQVIST', report: 'supply',
    what: 'Suppliers, battery cells, chips and material costs; negotiates supply contracts with you.',
    why: 'Materials are most of the cost of a car. A supplier that fails stops the line; a second source costs money but removes the risk.',
    levers: [['deals', 'Negotiate supply contracts'], ['projects', 'Design-to-cost and second-source projects']],
  },
  {
    key: 'legal', name: 'Legal', headId: 'CHR-LAURENT', report: 'contracts',
    what: 'Drafts and reviews every contract and tracks the company’s obligations (volumes, penalties, deadlines).',
    why: 'An agreement reached at the table binds nobody until it is signed: signing turns it into a contract, and only then does the simulation apply its terms (prices, volumes, wages). Legal reviews the terms in the signing preview and reminds you of unsigned agreements; after 45 days unsigned they lapse and the counterparty loses trust.',
    levers: [['deals', 'Sign agreed contracts, open or walk away from talks']],
  },
];

function DivisionCard({ div, names }: { div: Division; names: Record<string, string> }) {
  const { go, openAsk } = useGame();
  const { data, error } = useView<Report>(`/reports/${div.report}`);
  const [full, setFull] = useState(false);
  return (
    <Card title={div.name} sub={`Head: ${names[div.headId] ?? div.headId}`} actions={<button className="btn sm" onClick={() => openAsk(div.headId)}>Ask {names[div.headId]?.split(' ')[0] ?? 'the head'}</button>}>
      <div id={`dept-${div.key}`} className="stack" style={{ gap: 8 }}>
        <div className="small">{div.what}</div>
        <div className="small sub"><strong>Why it matters.</strong> {div.why}</div>
        <div>
          <div className="tiny muted" style={{ marginBottom: 4 }}>Is it working? — {data?.title ?? 'report'}</div>
          {!data ? <Loading error={error} /> : full ? <ReportView report={data} compact /> : <ReportGlance report={data} />}
          {data && <button className="btn sm ghost" onClick={() => setFull(!full)}>{full ? 'Show less' : 'Full report'}</button>}
        </div>
        <div>
          <div className="tiny muted">Your decisions here</div>
          {div.levers.map(([area, label]) => (
            <div key={label} className="small"><a href="#" onClick={(e) => { e.preventDefault(); go('decisions', area); }}>{label} →</a></div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function DivisionsOverview({ characters }: { characters: any[] }) {
  const names = Object.fromEntries(characters.map((c) => [c.id, c.name]));
  return (
    <div className="grid g2">
      {DIVISIONS.map((div) => <DivisionCard key={div.key} div={div} names={names} />)}
    </div>
  );
}
