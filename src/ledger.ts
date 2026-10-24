/**
 * The ledger maps GitHub issues to Gibwork task IDs and records every
 * decision and payout. It is written *before* any money moves, so an
 * interrupted run can never pay the same bounty twice.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LedgerBounty {
  /** owner/repo#123 */
  issue: string;
  taskId: string;
  /** Human amount in the bounty token, e.g. "25.00". */
  amount: string;
  createdAt: string;
  status: 'open' | 'paid' | 'refunded';
  paidSubmissionId?: string | null;
  /** A create/approve that started but whose outcome is not known yet. */
  pendingIntent?: { kind: 'create' | 'approve'; intentId: string; submissionId?: string; at: string } | null;
}

export interface LedgerDecision {
  taskId: string;
  decision: 'pay' | 'wait' | 'reject' | 'review';
  /** Fingerprint of the evidence, so a WAIT comment is only posted when something changed. */
  fingerprint: string;
  applied: boolean;
  at: string;
}

export interface LedgerPayout {
  taskId: string;
  submissionId: string;
  issue: string;
  pr: string;
  amount: string;
  txHash: string | null;
  at: string;
}

export interface Ledger {
  version: 1;
  environment: 'production' | 'stage';
  bounties: LedgerBounty[];
  decisions: Record<string, LedgerDecision>;
  payouts: LedgerPayout[];
}

export function emptyLedger(environment: Ledger['environment'] = 'production'): Ledger {
  return { version: 1, environment, bounties: [], decisions: {}, payouts: [] };
}

export function loadLedger(path: string, environment?: Ledger['environment']): Ledger {
  if (!existsSync(path)) return emptyLedger(environment);
  const data = JSON.parse(readFileSync(path, 'utf8')) as Ledger;
  if (data.version !== 1) throw new Error(`Unsupported ledger version in ${path}`);
  data.decisions ??= {};
  data.payouts ??= [];
  return data;
}

/** Atomic write: temp file + rename, so a crash never leaves half a ledger. */
export function saveLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o644 });
  renameSync(tmp, path);
}

export function findBountyByIssue(ledger: Ledger, issue: string): LedgerBounty | undefined {
  return ledger.bounties.find((b) => b.issue.toLowerCase() === issue.toLowerCase());
}

export function findBountyByTask(ledger: Ledger, taskId: string): LedgerBounty | undefined {
  return ledger.bounties.find((b) => b.taskId.toLowerCase() === taskId.toLowerCase());
}

/** Every PR URL that has already been paid out, across all bounties. */
export function paidPullRequests(ledger: Ledger): Set<string> {
  return new Set(ledger.payouts.map((p) => p.pr.toLowerCase()));
}
