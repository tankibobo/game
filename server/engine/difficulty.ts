/**
 * Difficulty: how strict the board is. The simulation of the company itself is
 * identical at every level; only the board's patience changes.
 */
import type { Difficulty } from '../../shared/domain';
import type { World } from './world';

export interface DifficultySettings {
  label: string;
  description: string;
  /** Board confidence below this at a regular meeting counts as a strike. */
  dismissalThreshold: number;
  /** Consecutive strikes that end the mandate. */
  dismissalMeetings: number;
  /** Days during which the board judges the new CEO mostly on the inherited baseline. */
  graceDays: number;
  /** How far confidence moves towards its target at each regular meeting / each month end. */
  meetingPull: number;
  monthlyPull: number;
  /** Multiplier on the board's reaction to forecast revisions. */
  reactionScale: number;
  /** Mandate score needed for the board to renew the CEO at the end of the term. */
  passScore: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultySettings> = {
  relaxed: {
    label: 'Relaxed',
    description: 'A patient board: a long honeymoon, small reactions to bad news, and it takes three bad meetings in a row (below 12) to dismiss you. Good for learning.',
    dismissalThreshold: 12,
    dismissalMeetings: 3,
    graceDays: 300,
    meetingPull: 0.35,
    monthlyPull: 0.12,
    reactionScale: 0.5,
    passScore: 50,
  },
  standard: {
    label: 'Standard',
    description: 'A demanding but fair board: confidence below 20 at two regular meetings in a row ends your mandate.',
    dismissalThreshold: 20,
    dismissalMeetings: 2,
    graceDays: 150,
    meetingPull: 0.5,
    monthlyPull: 0.2,
    reactionScale: 1,
    passScore: 60,
  },
  hard: {
    label: 'Hard',
    description: 'An impatient board: a short honeymoon, sharp reactions, and two meetings below 25 end your mandate.',
    dismissalThreshold: 25,
    dismissalMeetings: 2,
    graceDays: 90,
    meetingPull: 0.6,
    monthlyPull: 0.25,
    reactionScale: 1.25,
    passScore: 65,
  },
};

export function difficultyOf(w: World): DifficultySettings {
  return DIFFICULTIES[w.meta.difficulty] ?? DIFFICULTIES.standard;
}
