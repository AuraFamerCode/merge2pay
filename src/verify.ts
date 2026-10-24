/**
 * The verifier: given one Gibwork submission and the GitHub issue its bounty
 * funds, decide whether the work is real, merged, and owned by the submitter.
 *
 * Every check is recorded with its evidence so a maintainer (or an agent) can
 * see exactly why merge2pay wants to pay, wait, or reject.
 */
import { createHash } from 'node:crypto';
import {
  extractClaimedGithubHandle,
  extractClosingRefs,
  extractGibworkHandle,
  extractPullRequests,
  formatIssue,
  htmlToText,
  sameIssue,
  sameRepo,
  type IssueRef,
  type PullRef,
} from './claims.js';
import { GithubError, type GithubClient, type GithubPull, type ChecksSummary } from './github.js';
import type { Policy } from './policy.js';

export type Decision = 'pay' | 'wait' | 'reject' | 'review';
export type CheckOutcome = 'pass' | 'fail' | 'wait' | 'warn' | 'skip';

export interface Check {
  id: string;
  outcome: CheckOutcome;
  /** What a failing check means for the decision. */
  effect?: Decision;
  detail: string;
}

export interface SubmissionLike {
  id: string;
  content: string;
  createdAt: string;
  status: string;
  user: { username: string };
}

export interface Verdict {
  submissionId: string;
  submitter: string;
  decision: Decision;
  /** The one-line reason a human reads first. */
  summary: string;
  pr: PullRef | null;
  prAuthor: string | null;
  checks: Check[];
  fingerprint: string;
}

export interface VerifyContext {
  issue: IssueRef;
  bountyCreatedAt: string;
  policy: Policy;
  github: GithubClient;
  /** PR URL (lowercase) -> the submission that legitimately claimed it first on this task. */
  firstClaims: Map<string, { id: string; user: string }>;
  /** PR URLs already paid by any bounty in the ledger. */
  paidPrs: Set<string>;
}

const rank: Record<Decision, number> = { pay: 0, review: 1, wait: 2, reject: 3 };

function decide(checks: Check[]): Decision {
  let worst: Decision = 'pay';
  for (const c of checks) {
    if ((c.outcome === 'fail' || c.outcome === 'wait' || c.outcome === 'warn') && c.effect) {
      if (rank[c.effect] > rank[worst]) worst = c.effect;
    }
  }
  return worst;
}

function fingerprint(decision: Decision, checks: Check[]): string {
  const material = decision + '|' + checks.map((c) => `${c.id}:${c.outcome}`).join(',');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

function verdict(sub: SubmissionLike, checks: Check[], pr: PullRef | null, pull: GithubPull | null): Verdict {
  const decision = decide(checks);
  // The most telling reason first: fraud signals beat bookkeeping ones.
  const priority = ['identity', 'pr-link', 'repo', 'pr-exists', 'merged', 'closes-issue', 'unique'];
  const order = (id: string) => (priority.includes(id) ? priority.indexOf(id) : priority.length);
  const blocking =
    checks
      .filter((c) => c.effect === decision && c.outcome !== 'pass' && c.outcome !== 'skip')
      .sort((a, b) => order(a.id) - order(b.id))[0] ??
    checks.find((c) => c.outcome === 'pass' && c.id === 'merged');
  const summary =
    decision === 'pay'
      ? `Merged PR closes the bounty issue${pull ? ` (by @${pull.user.login})` : ''}`
      : (blocking?.detail ?? decision);
  return {
    submissionId: sub.id,
    submitter: sub.user.username,
    decision,
    summary,
    pr,
    prAuthor: pull?.user.login ?? null,
    checks,
    fingerprint: fingerprint(decision, checks),
  };
}

export async function verifySubmission(sub: SubmissionLike, ctx: VerifyContext): Promise<Verdict> {
  const { issue, policy, github } = ctx;
  const checks: Check[] = [];

  // 1. A pull request link.
  const prs = extractPullRequests(sub.content);
  const inRepo = prs.filter((p) => sameRepo(p, issue));
  const pr = inRepo[0] ?? prs[0] ?? null;
  if (!pr) {
    checks.push({
      id: 'pr-link',
      outcome: 'fail',
      effect: 'reject',
      detail: 'No GitHub pull request link in the submission',
    });
    return verdict(sub, checks, null, null);
  }
  checks.push({ id: 'pr-link', outcome: 'pass', detail: pr.url });

  // 2. Same repository as the bounty's issue.
  if (!sameRepo(pr, issue)) {
    checks.push({
      id: 'repo',
      outcome: 'fail',
      effect: 'reject',
      detail: `PR is in ${pr.owner}/${pr.repo}, bounty is for ${issue.owner}/${issue.repo}`,
    });
    return verdict(sub, checks, pr, null);
  }
  checks.push({ id: 'repo', outcome: 'pass', detail: `${pr.owner}/${pr.repo}` });

  // 3. The PR exists.
  let pull: GithubPull;
  try {
    pull = await github.getPull(pr);
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) {
      checks.push({ id: 'pr-exists', outcome: 'fail', effect: 'reject', detail: `${pr.url} does not exist` });
      return verdict(sub, checks, pr, null);
    }
    throw err;
  }

  // 4. Not claimed by an earlier submission, not already paid.
  const key = pr.url.toLowerCase();
  const first = ctx.firstClaims.get(key);
  if (ctx.paidPrs.has(key)) {
    checks.push({ id: 'unique', outcome: 'fail', effect: 'reject', detail: `PR #${pr.number} was already paid out` });
  } else if (first && first.id !== sub.id) {
    checks.push({
      id: 'unique',
      outcome: 'fail',
      effect: 'reject',
      detail: `PR #${pr.number} is already claimed by ${first.user}'s submission`,
    });
  } else {
    checks.push({ id: 'unique', outcome: 'pass', detail: 'First claim on this PR' });
  }

  // 5. It closes the bounty's issue.
  const closing = extractClosingRefs(`${pull.title}\n${pull.body ?? ''}`, pr);
  if (closing.some((r) => sameIssue(r, issue))) {
    checks.push({ id: 'closes-issue', outcome: 'pass', detail: `PR says it fixes ${formatIssue(issue)}` });
  } else {
    const others = closing.map((r) => (sameRepo(r, issue) ? `#${r.number}` : formatIssue(r))).join(', ');
    checks.push({
      id: 'closes-issue',
      outcome: policy.requireIssueReference ? 'fail' : 'warn',
      effect: policy.requireIssueReference ? 'reject' : 'review',
      detail: others
        ? `PR closes ${others}, not ${formatIssue(issue)}`
        : `PR does not reference ${formatIssue(issue)} with a closing keyword`,
    });
  }

  // 6. Merge state.
  if (pull.merged_at) {
    checks.push({ id: 'merged', outcome: 'pass', detail: `Merged ${pull.merged_at.slice(0, 10)}` });
  } else if (pull.state === 'closed') {
    checks.push({ id: 'merged', outcome: 'fail', effect: 'reject', detail: 'PR was closed without being merged' });
  } else if (policy.requireMerged) {
    checks.push({
      id: 'merged',
      outcome: 'wait',
      effect: 'wait',
      detail: pull.draft ? 'PR is still a draft' : 'PR is open, waiting for a maintainer to merge',
    });
  } else {
    checks.push({ id: 'merged', outcome: 'warn', effect: 'review', detail: 'PR is open (policy allows unmerged)' });
  }

  // 7. CI.
  if (policy.requireChecks === 'ignore') {
    checks.push({ id: 'ci', outcome: 'skip', detail: 'CI gate disabled by policy' });
  } else {
    let ci: ChecksSummary | null = null;
    try {
      ci = await github.getChecks(pr, pull.head.sha);
    } catch (err) {
      checks.push({ id: 'ci', outcome: 'warn', effect: 'review', detail: `Could not read CI: ${(err as Error).message}` });
    }
    if (ci) {
      const label = `${ci.total} check${ci.total === 1 ? '' : 's'}`;
      if (ci.state === 'success') checks.push({ id: 'ci', outcome: 'pass', detail: `${label} green` });
      else if (ci.state === 'failure')
        checks.push({
          id: 'ci',
          outcome: 'fail',
          effect: pull.merged_at ? 'review' : 'wait',
          detail: `CI failing: ${ci.failed.slice(0, 3).join(', ')}`,
        });
      else if (ci.state === 'pending')
        checks.push({
          id: 'ci',
          outcome: policy.requireChecks === 'success' ? 'wait' : 'warn',
          effect: policy.requireChecks === 'success' ? 'wait' : undefined,
          detail: `CI still running: ${ci.pending.slice(0, 3).join(', ')}`,
        } as Check);
      else
        checks.push({
          id: 'ci',
          outcome: policy.requireChecks === 'success' ? 'fail' : 'warn',
          effect: policy.requireChecks === 'success' ? 'review' : undefined,
          detail: 'No CI checks reported on the head commit',
        } as Check);
    }
  }

  // 8. Identity: who did the work?
  const claimedGithub = extractClaimedGithubHandle(sub.content);
  const proofHandle = extractGibworkHandle(pull.body ?? '');
  if (claimedGithub && claimedGithub.toLowerCase() !== pull.user.login.toLowerCase()) {
    checks.push({
      id: 'identity',
      outcome: 'fail',
      effect: 'reject',
      detail: `Submission claims GitHub @${claimedGithub}, but PR #${pr.number} is by @${pull.user.login}`,
    });
  } else if (proofHandle && proofHandle.toLowerCase() === sub.user.username.toLowerCase()) {
    checks.push({
      id: 'identity',
      outcome: 'pass',
      detail: `PR body links Gibwork user ${proofHandle} (author @${pull.user.login})`,
    });
  } else if (proofHandle) {
    checks.push({
      id: 'identity',
      outcome: 'fail',
      effect: 'reject',
      detail: `PR body names Gibwork user "${proofHandle}", submitter is "${sub.user.username}"`,
    });
  } else {
    checks.push({
      id: 'identity',
      outcome: policy.requireIdentityProof ? 'fail' : 'warn',
      effect: policy.requireIdentityProof ? 'review' : undefined,
      detail: `No "gibwork: ${sub.user.username}" line in the PR body; author is @${pull.user.login}${
        claimedGithub ? ' (matches claimed handle)' : ''
      }`,
    } as Check);
  }

  // 9. Was the work done for this bounty?
  if (Date.parse(pull.created_at) < Date.parse(ctx.bountyCreatedAt)) {
    checks.push({
      id: 'timing',
      outcome: policy.rejectPreBountyWork ? 'fail' : 'warn',
      effect: policy.rejectPreBountyWork ? 'reject' : undefined,
      detail: `PR opened ${pull.created_at.slice(0, 10)}, before the bounty (${ctx.bountyCreatedAt.slice(0, 10)})`,
    } as Check);
  } else {
    checks.push({ id: 'timing', outcome: 'pass', detail: 'PR opened after the bounty was posted' });
  }

  return verdict(sub, checks, pr, pull);
}

/** Text shown on Gibwork when a submission is rejected or waiting. */
export function feedbackFor(v: Verdict): string {
  const lines = v.checks
    .filter((c) => c.outcome !== 'pass' && c.outcome !== 'skip')
    .map((c) => `- ${c.detail}`);
  const head =
    v.decision === 'reject'
      ? 'merge2pay could not accept this submission:'
      : v.decision === 'wait'
        ? 'merge2pay is tracking your PR. It will pay automatically once these clear:'
        : 'merge2pay flagged this for a maintainer:';
  return [head, ...lines, '', 'Bounties here pay when the linked GitHub PR is merged and closes the issue.'].join('\n');
}

export function plainContent(html: string): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim();
}
