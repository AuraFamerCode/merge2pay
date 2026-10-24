/** Terminal and Markdown rendering for settlement plans. */
import type { SettlementPlan } from './plan.js';
import type { Check, Decision } from './verify.js';

const useColor = () =>
  process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !process.env.NO_COLOR && Boolean(process.stdout.isTTY);

const wrap = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  magenta: wrap('35'),
};

const badge: Record<Decision, (s: string) => string> = {
  pay: (s) => c.green(c.bold(s)),
  wait: (s) => c.yellow(c.bold(s)),
  reject: (s) => c.red(c.bold(s)),
  review: (s) => c.magenta(c.bold(s)),
};

const label: Record<Decision, string> = { pay: 'PAY   ', wait: 'WAIT  ', reject: 'REJECT', review: 'REVIEW' };

const mark: Record<Check['outcome'], string> = { pass: '✓', fail: '✗', wait: '…', warn: '!', skip: '-' };
const markColor: Record<Check['outcome'], (s: string) => string> = {
  pass: (s) => c.green(s),
  fail: (s) => c.red(s),
  wait: (s) => c.yellow(s),
  warn: (s) => c.yellow(s),
  skip: (s) => c.dim(s),
};

export function renderPlan(plan: SettlementPlan, opts: { verbose?: boolean; executed?: boolean } = {}): string {
  const out: string[] = [];
  out.push(
    c.dim(
      `wallet ${plan.wallet}  ·  ${plan.environment}  ·  ${
        plan.mode === 'keypair' ? 'signing with your keypair' : plan.mode === 'ephemeral' ? 'read-only (no wallet)' : 'fixture data'
      }`,
    ),
  );
  out.push('');
  for (const b of plan.bounties) {
    const head = `${c.bold(b.bounty.issue)}  ${c.dim('→')}  ${b.task ? b.task.title : b.bounty.taskId}  ${c.cyan(
      `${b.bounty.amount} ${b.task?.asset.symbol ?? ''}`.trim(),
    )}`;
    out.push(head);
    if (b.task) out.push(c.dim(`  ${b.task.url}`));
    if (b.error) out.push(`  ${c.red('error')} ${b.error}`);
    if (b.note) out.push(`  ${c.dim(b.note)}`);
    if (!b.error && !b.note && b.verdicts.length === 0) out.push(c.dim('  no open submissions'));
    for (const v of b.verdicts) {
      const pr = v.pr ? `PR #${v.pr.number}` : 'no PR';
      out.push(`  ${badge[v.decision](label[v.decision])}  ${v.submitter.padEnd(14)} ${pr.padEnd(10)} ${v.summary}`);
      if (opts.verbose || v.decision !== 'pay') {
        for (const ch of v.checks) {
          if (!opts.verbose && (ch.outcome === 'pass' || ch.outcome === 'skip')) continue;
          out.push(`           ${markColor[ch.outcome](mark[ch.outcome])} ${c.dim(ch.id.padEnd(13))} ${ch.detail}`);
        }
      } else {
        const passed = v.checks.filter((ch) => ch.outcome === 'pass').map((ch) => ch.id);
        out.push(`           ${c.green('✓')} ${c.dim(passed.join(' · '))}`);
      }
    }
    out.push('');
  }
  const t = plan.totals;
  const verb = opts.executed ? 'Applied' : 'Plan';
  out.push(
    `${c.bold(verb + ':')} ${c.green(`${t.approve} to pay (${t.payout} ${t.symbol})`)}, ${c.red(`${t.reject} to reject`)}, ${c.yellow(
      `${t.comment} to update`,
    )}, ${c.magenta(`${t.review} for a human`)}.`,
  );
  if (!opts.executed) out.push(c.dim('Dry run: nothing was paid, rejected, or posted. Add --execute to apply.'));
  return out.join('\n');
}

export function renderMarkdown(plan: SettlementPlan): string {
  const out: string[] = [];
  out.push(`# merge2pay settlement report`, '');
  out.push(`- Generated: ${plan.generatedAt}`);
  out.push(`- Environment: ${plan.environment}`);
  out.push(`- Wallet: \`${plan.wallet}\` (${plan.mode})`);
  const t = plan.totals;
  out.push(`- Totals: ${t.approve} to pay (${t.payout} ${t.symbol}), ${t.reject} to reject, ${t.comment} to update, ${t.review} for review`, '');
  for (const b of plan.bounties) {
    out.push(`## ${b.bounty.issue} — ${b.bounty.amount} ${b.task?.asset.symbol ?? ''}`.trim(), '');
    out.push(`Gibwork task: ${b.task?.url ?? b.bounty.taskId}`, '');
    if (b.error) out.push(`> Error: ${b.error}`, '');
    if (b.note) out.push(`> ${b.note}`, '');
    if (b.verdicts.length) {
      out.push('| Decision | Submitter | PR | Reason |', '| --- | --- | --- | --- |');
      for (const v of b.verdicts) {
        out.push(`| **${v.decision.toUpperCase()}** | ${v.submitter} | ${v.pr ? `[#${v.pr.number}](${v.pr.url})` : '—'} | ${v.summary.replace(/\|/g, '\\|')} |`);
      }
      out.push('');
      for (const v of b.verdicts) {
        out.push(`<details><summary>${v.submitter} — evidence</summary>`, '');
        for (const ch of v.checks) out.push(`- ${mark[ch.outcome]} \`${ch.id}\` ${ch.detail}`);
        out.push('', '</details>', '');
      }
    }
  }
  return out.join('\n') + '\n';
}
