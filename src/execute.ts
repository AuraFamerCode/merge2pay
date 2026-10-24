/**
 * Apply a settlement plan through the Gibwork SDK. Only runs in keypair mode.
 *
 * Safety rules:
 *  - The ledger records the intent ID *before* a signed transaction is sent.
 *  - A submit is never retried. An ambiguous outcome halts all further payouts.
 *  - Every approval shows the SDK quote and needs confirmation (or --yes).
 */
import { createInterface } from 'node:readline/promises';
import { GibworkAmbiguousSubmitError, type ApprovalQuote } from '@gibwork/sdk';
import type { LiveGibwork } from './gibwork.js';
import { findBountyByTask, saveLedger, type Ledger } from './ledger.js';
import type { SettlementPlan } from './plan.js';
import type { Policy } from './policy.js';
import { feedbackFor } from './verify.js';

export interface ExecuteOptions {
  yes: boolean;
  ledgerPath: string;
  log?: (line: string) => void;
}

export interface ExecuteResult {
  approved: number;
  rejected: number;
  commented: number;
  skipped: number;
  halted?: string;
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export function describeQuote(q: ApprovalQuote): string {
  return `gross ${q.grossApprovalAmount} ${q.token.symbol}, fee ${q.platformFee.amount} (${q.platformFee.percent}%), net to contributor ${q.netPayoutAmount}${
    q.closeTask ? ', closes the task' : ''
  }`;
}

export async function executePlan(
  plan: SettlementPlan,
  ledger: Ledger,
  policy: Policy,
  gibwork: LiveGibwork,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const result: ExecuteResult = { approved: 0, rejected: 0, commented: 0, skipped: 0 };
  const now = () => new Date().toISOString();

  for (const b of plan.bounties) {
    for (const action of b.actions) {
      const v = action.verdict;
      const record = (applied: boolean) => {
        ledger.decisions[action.submissionId] = {
          taskId: action.taskId,
          decision: v.decision,
          fingerprint: v.fingerprint,
          applied,
          at: now(),
        };
        saveLedger(opts.ledgerPath, ledger);
      };

      if (action.kind === 'reject') {
        await gibwork.reject(action.taskId, action.submissionId, feedbackFor(v).slice(0, 1000));
        record(true);
        result.rejected++;
        log(`rejected ${v.submitter} on ${action.issue}: ${v.summary}`);
        continue;
      }

      if (action.kind === 'comment') {
        await gibwork.comment(action.taskId, action.submissionId, feedbackFor(v));
        record(true);
        result.commented++;
        log(`commented on ${v.submitter}'s submission (${action.issue}): ${v.summary}`);
        continue;
      }

      // approve
      const bounty = findBountyByTask(ledger, action.taskId);
      if (!bounty || bounty.status !== 'open' || bounty.pendingIntent) {
        result.skipped++;
        continue;
      }
      try {
        const res = await gibwork.approve(action.taskId, action.submissionId, action.amount!, policy.rating, {
          onQuote: async (q) => {
            const line = `pay ${v.submitter} for ${action.issue} via ${v.pr?.url}: ${describeQuote(q)}`;
            if (opts.yes) {
              log(line);
              return true;
            }
            return confirm(`${line}\nApprove this payout?`);
          },
          onIntent: (intentId) => {
            bounty.pendingIntent = { kind: 'approve', intentId, submissionId: action.submissionId, at: now() };
            saveLedger(opts.ledgerPath, ledger);
          },
        });
        if (!res) {
          result.skipped++;
          log(`skipped payout to ${v.submitter} (not confirmed)`);
          continue;
        }
        bounty.pendingIntent = null;
        bounty.status = 'paid';
        bounty.paidSubmissionId = action.submissionId;
        ledger.payouts.push({
          taskId: action.taskId,
          submissionId: action.submissionId,
          issue: action.issue,
          pr: v.pr!.url,
          amount: action.amount!,
          txHash: res.txHash,
          at: now(),
        });
        record(true);
        result.approved++;
        log(`paid ${v.submitter} ${action.amount} for ${action.issue} — tx ${res.txHash}`);
      } catch (err) {
        if (err instanceof GibworkAmbiguousSubmitError) {
          saveLedger(opts.ledgerPath, ledger);
          result.halted = `Ambiguous submit for intent ${err.context.intentId} on ${action.issue}. Not retrying; check the transaction before running again.`;
          log(result.halted);
          return result;
        }
        throw err;
      }
    }
  }
  return result;
}
