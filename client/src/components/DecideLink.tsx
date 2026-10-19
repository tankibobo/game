import { useGame } from '../ctx';

/** Information pages show the state; every decision is taken in one place: Decisions. */
export function DecideLink({ area, children = 'Change in Decisions →' }: { area: string; children?: string }) {
  const { go } = useGame();
  return (
    <button className="btn sm ghost" onClick={() => go('decisions', area)}>{children}</button>
  );
}
