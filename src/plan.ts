/**
 * Settlement planning: turn ledger bounties + live Gibwork submissions +
 * live GitHub state into a list of concrete actions. Pure planning, no writes.
 */
import { parseIssueSpec } from './claims.js';
import { describeError, type GibworkSource, type TaskView } from './gibwork.js';
import type { GithubClient } from './github.js';
import { paidPullRequests, type Ledger, type LedgerBounty } from './ledger.js';
import { toBaseUnits, type Policy } from './policy.js';
import { verifySubmission, type Verdict } from './verify.js';

export type ActionKind = 'approve' | 'reject' | 'comment';

export interface PlannedAction {
  kind: ActionKind;
  taskId: string;
  submissionId: string;
  issue: string;
  /** approve only: human amount in the bounty token. */
  amount?: string;
  verdict: Verdict;
}

export interface BountyPlan {
  bounty: LedgerBounty;
  task: TaskView | null;
  error?: string;
  note?: string;
  verdicts: Verdict[];
  actions: PlannedAction[];
}

export interface SettlementPlan {
  generatedAt: string;
  environment: string;
  wallet: string;
  mode: string;
  bounties: BountyPlan[];
  totals: { approve: number; reject: number; comment: number; review: number; payout: string; symbol: string };
}

export interface PlanInput {
  ledger: Ledger;
  policy: Policy;
  gibwork: GibworkSource;
  github: GithubClient;
  /** Restrict to one task. */
  taskId?: string;
  now?: Date;
}

export async function planSettlement(input: PlanInput): Promise<SettlementPlan> {
  const { ledger, policy, gibwork, github } = input;
  const paid = paidPullRequests(ledger);
  const plans: BountyPlan[] = [];
  let runPayout = 0n;
  let symbol = 'USDC';
  let decimals = 6;
  const runCap = () => toBaseUnits(policy.maxPayoutPerRun, decimals);

  const targets = ledger.bounties.filter(
    (b) => b.status === 'open' && (!input.taskId || b.taskId.toLowerCase() === input.taskId.toLowerCase()),
  );

  for (const bounty of targets) {
    const plan: BountyPlan = { bounty, task: null, verdicts: [], actions: [] };
    plans.push(plan);
    if (bounty.pendingIntent) {
      plan.note = `A ${bounty.pendingIntent.kind} intent (${bounty.pendingIntent.intentId}) has an unknown outcome. Reconcile it before paying again.`;
      continue;
    }
    try {
      plan.task = await gibwork.getTask(bounty.taskId);
    } catch (err) {
      plan.error = `Could not read Gibwork task: ${describeError(err)}`;
      continue;
    }
    symbol = plan.task.asset.symbol ?? symbol;
    decimals = plan.task.asset.decimals ?? decimals;
    if (!plan.task.isOpen) {
      plan.note = `Task is ${plan.task.status} on Gibwork; nothing to settle.`;
      continue;
    }

    let subs;
    try {
      subs = await gibwork.listOpenSubmissions(bounty.taskId);
    } catch (err) {
      plan.error = `Could not list submissions (${describeError(err)}). Only the bounty creator's wallet can read them.`;
      continue;
    }
    subs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    const issue = parseIssueSpec(bounty.issue);
    const baseCtx = { issue, bountyCreatedAt: bounty.createdAt, policy, github, paidPrs: paid };

    // Pass 1: verify each submission on its own. A claim only "owns" a PR if
    // its identity check did not fail, so an impostor who submits someone
    // else's PR first cannot lock the real author out.
    const firstClaims = new Map<string, { id: string; user: string }>();
    for (const s of subs) {
      const solo = await verifySubmission(s, { ...baseCtx, firstClaims: new Map() });
      const identityFailed = solo.checks.some((ch) => ch.id === 'identity' && ch.outcome === 'fail');
      const key = solo.pr?.url.toLowerCase();
      if (key && !identityFailed && !firstClaims.has(key)) firstClaims.set(key, { id: s.id, user: s.user.username });
    }

    // Pass 2: verify again with uniqueness (GitHub responses are cached).
    let payee: Verdict | null = null;
    for (const s of subs) {
      const v = await verifySubmission(s, { ...baseCtx, firstClaims });
      if (v.decision === 'pay') {
        if (payee) {
          v.decision = 'review';
          v.summary = `Also qualifies, but ${payee.submitter}'s earlier submission is being paid`;
          v.checks.push({ id: 'single-payout', outcome: 'warn', effect: 'review', detail: v.summary });
        } else {
          const amount = toBaseUnits(bounty.amount, decimals);
          if (amount > toBaseUnits(policy.maxPayoutPerBounty, decimals)) {
            v.decision = 'review';
            v.summary = `Payout ${bounty.amount} exceeds maxPayoutPerBounty ${policy.maxPayoutPerBounty}`;
            v.checks.push({ id: 'payout-cap', outcome: 'fail', effect: 'review', detail: v.summary });
          } else if (runPayout + amount > runCap()) {
            v.decision = 'review';
            v.summary = `Payout would exceed maxPayoutPerRun ${policy.maxPayoutPerRun}`;
            v.checks.push({ id: 'run-cap', outcome: 'fail', effect: 'review', detail: v.summary });
          } else {
            payee = v;
            runPayout += amount;
          }
        }
      }
      plan.verdicts.push(v);

      const prior = ledger.decisions[s.id];
      const base = { taskId: bounty.taskId, submissionId: s.id, issue: bounty.issue, verdict: v };
      if (v.decision === 'pay') plan.actions.push({ ...base, kind: 'approve', amount: bounty.amount });
      else if (v.decision === 'reject' && policy.autoReject) plan.actions.push({ ...base, kind: 'reject' });
      else if (v.decision === 'wait' && policy.commentOnWait && !(prior?.applied && prior.fingerprint === v.fingerprint))
        plan.actions.push({ ...base, kind: 'comment' });
    }
  }

  const count = (k: ActionKind) => plans.reduce((n, p) => n + p.actions.filter((a) => a.kind === k).length, 0);
  const review = plans.reduce((n, p) => n + p.verdicts.filter((v) => v.decision === 'review').length, 0);
  const s = runPayout.toString().padStart(decimals + 1, '0');
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    environment: gibwork.environment,
    wallet: gibwork.wallet,
    mode: gibwork.mode,
    bounties: plans,
    totals: {
      approve: count('approve'),
      reject: count('reject'),
      comment: count('comment'),
      review,
      payout: `${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals, s.length - decimals + 2)}`,
      symbol,
    },
  };
}
