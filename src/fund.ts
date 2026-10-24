/**
 * Funding: turn a GitHub issue into a Gibwork CreateTaskInput whose
 * instructions make the submission machine-verifiable later.
 */
import { extractIssueUrls, formatIssue, sameIssue, type IssueRef } from './claims.js';
import { USDC_MINT } from './gibwork.js';
import type { GithubIssue } from './github.js';
import type { CreateTaskInput, AvailableTask } from '@gibwork/sdk';
import type { Policy } from './policy.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function labelNames(issue: GithubIssue): string[] {
  return issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
}

/** `bounty:25`, `bounty: 25 USDC`, `bounty:$12.50` -> "25.00" etc. */
export function amountFromLabels(issue: GithubIssue, prefix: string): string | null {
  const p = prefix.toLowerCase();
  for (const name of labelNames(issue)) {
    if (!name.toLowerCase().startsWith(p)) continue;
    const m = /\$?\s*(\d+(?:\.\d{1,6})?)/.exec(name.slice(p.length));
    if (m) return normalizeAmount(m[1]!);
  }
  return null;
}

export function normalizeAmount(v: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`Invalid amount "${v}"`);
  const [w, f = ''] = v.split('.');
  return `${Number(w)}.${f.padEnd(2, '0')}`;
}

export interface FundOptions {
  amount?: string | undefined;
  minSubmissionAmount?: string | undefined;
  now?: Date;
}

export function buildTaskInput(ref: IssueRef, issue: GithubIssue, policy: Policy, opts: FundOptions = {}): CreateTaskInput {
  const amount = opts.amount
    ? normalizeAmount(opts.amount)
    : (amountFromLabels(issue, policy.fund.amountLabelPrefix) ??
      (policy.fund.defaultAmount ? normalizeAmount(policy.fund.defaultAmount) : null));
  if (!amount) {
    throw new Error(
      `No amount for ${formatIssue(ref)}: pass --amount, add a "${policy.fund.amountLabelPrefix}25" label, or set fund.defaultAmount`,
    );
  }
  const minSubmission = normalizeAmount(opts.minSubmissionAmount ?? policy.fund.minSubmissionAmount ?? amount);
  const excerpt = (issue.body ?? '').trim().slice(0, 1200);
  const issueUrl = `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  const content = [
    `<p><strong>Fix GitHub issue <a href="${issueUrl}">${esc(formatIssue(ref))}</a>: ${esc(issue.title)}</strong></p>`,
    excerpt ? `<blockquote>${esc(excerpt).replace(/\r?\n/g, '<br />')}${(issue.body ?? '').length > 1200 ? ' …' : ''}</blockquote>` : '',
    `<p><strong>How to get paid</strong></p>`,
    `<ol>`,
    `<li>Open a pull request on <a href="https://github.com/${ref.owner}/${ref.repo}">${esc(ref.owner)}/${esc(ref.repo)}</a> whose description says <code>Fixes #${ref.number}</code>.</li>`,
    `<li>Add the line <code>gibwork: &lt;your Gibwork username&gt;</code> to the PR description so the payout reaches you.</li>`,
    `<li>Submit the pull request URL here.</li>`,
    `</ol>`,
    `<p>Payment is released automatically by merge2pay when the PR is merged and CI passes. The first merged PR that closes the issue is paid; duplicate claims on the same PR are rejected.</p>`,
    `<p>Source: ${issueUrl}</p>`,
  ]
    .filter(Boolean)
    .join('');

  const title = `[${ref.repo}#${ref.number}] ${issue.title}`.slice(0, 120);
  const input: CreateTaskInput = {
    title,
    content,
    tags: policy.fund.tags,
    payment: { mintAddress: USDC_MINT, amount },
    minSubmissionAmount: minSubmission,
    allowOnlyVerifiedSubmissions: policy.fund.allowOnlyVerifiedSubmissions,
  };
  if (policy.fund.deadlineDays) {
    const d = new Date((opts.now ?? new Date()).getTime() + policy.fund.deadlineDays * 86_400_000);
    input.deadline = d.toISOString();
  }
  return input;
}

/** Live bounties on Gibwork that already point at this issue. */
export function findExistingBounties(ref: IssueRef, available: AvailableTask[]): AvailableTask[] {
  return available.filter((t) => extractIssueUrls(t.content ?? '').some((r) => sameIssue(r, ref)));
}

export function issueComment(ref: IssueRef, taskUrl: string, amount: string, symbol = 'USDC'): string {
  return [
    `💰 **This issue has a ${amount} ${symbol} bounty on Gibwork:** ${taskUrl}`,
    '',
    `To claim it: open a PR with \`Fixes #${ref.number}\` and a \`gibwork: <your username>\` line in the description, then submit the PR link on Gibwork.`,
    'merge2pay pays the first merged PR automatically.',
  ].join('\n');
}
