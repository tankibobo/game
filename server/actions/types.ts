import type { z } from 'zod';
import type { Consequence } from '../../shared/domain';
import type { Cents } from '../../shared/money';
import type { ProposalAnalysis } from '../engine/board';
import type { World } from '../engine/world';

export interface ApprovalRequirement {
  approver: 'board' | 'ceo' | 'counterparty' | 'shareholders' | 'lenders' | 'works_council';
  approverId?: string;
  reason: string;
  /** Approvals that are part of the process after commit (informational), not blocking. */
  informational?: boolean;
}

export interface Validation {
  errors: string[];
  warnings: string[];
}

export interface Preview {
  summary: string;
  consequences: Consequence[];
  approvals: ApprovalRequirement[];
}

export interface CommitContext {
  actionId: string;
  approverId: string;
  actorId: string;
}

export interface CommitResult {
  summary: string;
  details: string[];
  result?: Record<string, unknown>;
}

export interface ActionDef<P = any> {
  type: string;
  label: string;
  description: string;
  /** May an LLM character propose this action? */
  llmProposable: boolean;
  schema: z.ZodType<P>;
  /** Up-front financial commitment used for authority limits (cents). */
  amountCents?: (w: World, p: P) => Cents;
  /** Is the amount a financing amount (uses financing limits) rather than spend? */
  financing?: boolean;
  validate: (w: World, p: P, actorId: string) => Validation;
  preview: (w: World, p: P) => Preview;
  commit: (w: World, p: P, ctx: CommitContext) => CommitResult;
  /** Analysis attached to a board proposal when board approval is required. */
  boardAnalysis?: (w: World, p: P) => ProposalAnalysis;
  /** Does committing change plans enough to require a fresh forecast? */
  affectsForecast?: boolean;
}

export const ok = (): Validation => ({ errors: [], warnings: [] });
