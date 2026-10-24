#!/usr/bin/env node
/**
 * merge2pay: merge-to-pay bounties for Gibwork.
 */
import { writeFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { GibworkApiError } from '@gibwork/sdk';
import { formatIssue, parseIssueSpec } from './claims.js';
import { buildContext, ledgerFor, type ContextOptions } from './context.js';
import { executePlan, confirm } from './execute.js';
import { buildTaskInput, findExistingBounties, issueComment, normalizeAmount } from './fund.js';
import { describeError, LiveGibwork, taskUrl } from './gibwork.js';
import { findBountyByIssue, saveLedger } from './ledger.js';
import { planSettlement } from './plan.js';
import { fromBaseUnits } from './policy.js';
import { c, renderMarkdown, renderPlan } from './render.js';
import { verifySubmission } from './verify.js';

const program = new Command();
program
  .name('merge2pay')
  .description('Merge-to-pay for Gibwork: fund GitHub issues as bounties and pay contributors when their PR merges.')
  .version('0.1.0');

const common = (cmd: Command) =>
  cmd
    .option('--policy <file>', 'policy file (default: ./merge2pay.yml if present)')
    .option('--ledger <file>', 'ledger file', '.merge2pay/ledger.json')
    .addOption(new Option('--env <environment>', 'Gibwork environment (overrides policy)').choices(['production', 'stage']))
    .option('--json', 'machine-readable output on stdout');

const ctxOpts = (o: Record<string, unknown>): ContextOptions => ({
  policy: o.policy as string | undefined,
  ledger: o.ledger as string | undefined,
  fixtures: o.fixtures as string | undefined,
  environment: o.env as ContextOptions['environment'],
});

const print = (json: boolean, data: unknown, human: () => string) => {
  process.stdout.write(json ? JSON.stringify({ ok: true, data }, null, 2) + '\n' : human() + '\n');
};

// ---------------------------------------------------------------- settle
common(
  program
    .command('settle')
    .description('Verify every open submission against GitHub and pay / reject / update (dry run unless --execute)')
    .option('--task <taskId>', 'only settle this Gibwork task')
    .option('--fixtures <file>', 'read Gibwork data from a fixture file instead of the API')
    .option('--report <file>', 'also write a Markdown settlement report')
    .option('--execute', 'apply the plan through the Gibwork SDK (needs a wallet)')
    .option('--yes', 'do not prompt before each payout (CI)')
    .option('-v, --verbose', 'show every check, including passing ones'),
).action(async (o) => {
  const ctx = buildContext(ctxOpts(o));
  const ledger = ledgerFor(ctx);
  if (ledger.bounties.length === 0) {
    throw new Error(`No bounties in ${ctx.ledgerPath}. Fund one with "merge2pay fund owner/repo#N" or adopt one with "merge2pay link".`);
  }
  const plan = await planSettlement({ ledger, policy: ctx.policy, gibwork: ctx.gibwork, github: ctx.github, taskId: o.task });
  if (o.report) writeFileSync(o.report, renderMarkdown(plan));
  if (!o.execute) {
    print(Boolean(o.json), plan, () => renderPlan(plan, { verbose: o.verbose }) + (o.report ? c.dim(`\nReport written to ${o.report}`) : ''));
    return;
  }
  if (!(ctx.gibwork instanceof LiveGibwork) || !ctx.gibwork.canWrite) {
    throw new Error('--execute needs a wallet: set GIBWORK_KEYPAIR_PATH (or GIBWORK_PRIVATE_KEY) and do not use --fixtures');
  }
  if (!o.json) process.stdout.write(renderPlan(plan, { verbose: o.verbose }) + '\n\n');
  const res = await executePlan(plan, ledger, ctx.policy, ctx.gibwork, { yes: Boolean(o.yes), ledgerPath: ctx.ledgerPath });
  print(Boolean(o.json), { plan, result: res }, () =>
    `${c.bold('Applied:')} ${res.approved} paid, ${res.rejected} rejected, ${res.commented} updated, ${res.skipped} skipped.${
      res.halted ? '\n' + c.red(res.halted) : ''
    }`,
  );
  if (res.halted) process.exitCode = 22;
});

// ---------------------------------------------------------------- verify
program
  .command('verify <prUrl>')
  .description('Check one pull request against a bounty issue, exactly as settle would (live GitHub, no wallet)')
  .requiredOption('--issue <owner/repo#N>', 'the issue the bounty funds')
  .option('--submitter <username>', 'Gibwork username of the submitter', 'anonymous')
  .option('--bounty-created <iso>', 'when the bounty was posted (for the timing check)', new Date(0).toISOString())
  .option('--policy <file>', 'policy file')
  .option('--json', 'machine-readable output')
  .action(async (prUrl: string, o) => {
    const ctx = buildContext({ policy: o.policy, fixtures: undefined });
    const issue = parseIssueSpec(o.issue);
    const v = await verifySubmission(
      { id: 'adhoc', content: prUrl, createdAt: new Date().toISOString(), status: 'OPEN', user: { username: o.submitter } },
      { issue, bountyCreatedAt: o.bountyCreated, policy: ctx.policy, github: ctx.github, firstClaims: new Map(), paidPrs: new Set() },
    );
    print(Boolean(o.json), v, () => {
      const colour = { pay: c.green, wait: c.yellow, reject: c.red, review: c.magenta }[v.decision];
      const lines = [`${colour(c.bold(v.decision.toUpperCase()))}  ${v.summary}`];
      for (const ch of v.checks) {
        const m = { pass: c.green('✓'), fail: c.red('✗'), wait: c.yellow('…'), warn: c.yellow('!'), skip: c.dim('-') }[ch.outcome];
        lines.push(`  ${m} ${c.dim(ch.id.padEnd(13))} ${ch.detail}`);
      }
      return lines.join('\n');
    });
  });

// ---------------------------------------------------------------- fund
common(
  program
    .command('fund [issues...]')
    .description('Turn GitHub issues into Gibwork bounties (dry run unless --execute)')
    .option('--repo <owner/repo>', 'fund every open issue carrying the funding label (policy fund.label)')
    .option('--amount <decimal>', 'bounty amount in USDC (otherwise from a "bounty:25" label or policy)')
    .option('--min-submission <decimal>', 'minimum payout per submission (defaults to the full amount)')
    .option('--execute', 'create the bounties through the Gibwork SDK (needs a funded wallet)')
    .option('--yes', 'do not prompt before funding')
    .option('--comment-issue', 'after funding, comment the bounty link on the GitHub issue (needs GITHUB_TOKEN)'),
).action(async (issues: string[], o) => {
  const ctx = buildContext(ctxOpts(o));
  const ledger = ledgerFor(ctx);
  const refs = issues.map(parseIssueSpec);
  if (o.repo) {
    const [owner, repo] = String(o.repo).split('/');
    const labelled = await ctx.github.listIssuesWithLabel({ owner: owner!, repo: repo! }, ctx.policy.fund.label);
    refs.push(...labelled.map((i) => ({ owner: owner!, repo: repo!, number: i.number })));
  }
  if (refs.length === 0) throw new Error('Name at least one issue (owner/repo#N) or pass --repo');

  let available: Awaited<ReturnType<typeof ctx.gibwork.listAvailable>> = [];
  try {
    available = await ctx.gibwork.listAvailable(100);
  } catch {
    /* discovery is best-effort */
  }

  const planned = [] as Array<{ issue: string; status: string; input?: ReturnType<typeof buildTaskInput>; existing?: string[] }>;
  for (const ref of refs) {
    const key = formatIssue(ref);
    const inLedger = findBountyByIssue(ledger, key);
    if (inLedger) {
      planned.push({ issue: key, status: `already funded (${inLedger.taskId})` });
      continue;
    }
    const gh = await ctx.github.getIssue(ref);
    if (gh.state !== 'open') {
      planned.push({ issue: key, status: `skipped: issue is ${gh.state}` });
      continue;
    }
    const existing = findExistingBounties(ref, available).map((t) => t.id);
    const input = buildTaskInput(ref, gh, ctx.policy, { amount: o.amount, minSubmissionAmount: o.minSubmission });
    planned.push({ issue: key, status: existing.length ? 'duplicate on Gibwork' : 'create', input, existing });
  }

  if (!o.execute) {
    print(Boolean(o.json), { environment: ctx.policy.environment, wallet: ctx.gibwork.wallet, discoveredLive: available.length, planned }, () => {
      const lines = [c.dim(`wallet ${ctx.gibwork.wallet}  ·  ${ctx.policy.environment}  ·  checked ${available.length} live Gibwork bounties for duplicates`), ''];
      for (const p of planned) {
        if (!p.input) {
          lines.push(`  ${c.dim('=')} ${p.issue.padEnd(28)} ${c.dim(p.status)}`);
          continue;
        }
        const sym = p.status === 'create' ? c.green('+') : c.yellow('!');
        lines.push(`  ${sym} ${p.issue.padEnd(28)} ${c.cyan(p.input.payment.amount + ' USDC')}  ${p.input.title}`);
        if (p.existing?.length) lines.push(`      ${c.yellow('already has a live bounty:')} ${p.existing.join(', ')}`);
        lines.push(c.dim(`      tags ${p.input.tags.join(', ')} · min submission ${p.input.minSubmissionAmount}${p.input.deadline ? ' · deadline ' + p.input.deadline.slice(0, 10) : ''}`));
      }
      const n = planned.filter((p) => p.status === 'create').length;
      lines.push('', `${c.bold('Plan:')} ${n} bount${n === 1 ? 'y' : 'ies'} to fund.`, c.dim('Dry run: nothing was created or paid. Add --execute to fund.'));
      return lines.join('\n');
    });
    return;
  }

  const gw = ctx.gibwork;
  if (!(gw instanceof LiveGibwork) || !gw.canWrite) throw new Error('--execute needs a wallet: set GIBWORK_KEYPAIR_PATH');
  for (const p of planned) {
    if (p.status !== 'create' || !p.input) continue;
    const ref = parseIssueSpec(p.issue);
    const res = await gw.createTask(p.input, {
      onQuote: async (q) => {
        const line = `fund ${p.issue}: ${q.fundingAmount} ${q.token.symbol} + fee ${q.platformFee.amount} = ${q.totalDebit} debited`;
        if (o.yes) return process.stderr.write(line + '\n'), true;
        return confirm(`${line}\nCreate this bounty?`);
      },
      onIntent: (intentId, taskId) => {
        ledger.bounties.push({
          issue: p.issue,
          taskId,
          amount: p.input!.payment.amount,
          createdAt: new Date().toISOString(),
          status: 'open',
          pendingIntent: { kind: 'create', intentId, at: new Date().toISOString() },
        });
        saveLedger(ctx.ledgerPath, ledger);
      },
    });
    if (!res) continue;
    const entry = findBountyByIssue(ledger, p.issue)!;
    entry.taskId = res.taskId;
    entry.pendingIntent = res.status === 'confirmed' ? null : entry.pendingIntent;
    saveLedger(ctx.ledgerPath, ledger);
    const url = taskUrl(res.taskId, ctx.policy.environment);
    process.stdout.write(`funded ${p.issue} -> ${url} (${res.status}${res.txHash ? ', tx ' + res.txHash : ''})\n`);
    if (o.commentIssue) {
      const comment = await ctx.github.commentOnIssue(ref, issueComment(ref, url, p.input.payment.amount));
      process.stdout.write(`  commented ${comment.html_url}\n`);
    }
  }
});

// ---------------------------------------------------------------- link
common(
  program
    .command('link <issue> <taskId>')
    .description('Adopt an existing Gibwork bounty into the ledger (reads it live to validate)')
    .option('--amount <decimal>', 'payout amount (defaults to the task reward pool)')
    .option('--fixtures <file>', 'read Gibwork data from a fixture file'),
).action(async (issue: string, taskId: string, o) => {
  const ctx = buildContext(ctxOpts(o));
  const ledger = ledgerFor(ctx);
  const ref = parseIssueSpec(issue);
  const key = formatIssue(ref);
  if (findBountyByIssue(ledger, key)) throw new Error(`${key} is already in the ledger`);
  const task = await ctx.gibwork.getTask(taskId);
  const amount = o.amount ? normalizeAmount(o.amount) : fromBaseUnits(BigInt(Math.round(Number(task.asset.amount))), task.asset.decimals);
  ledger.bounties.push({ issue: key, taskId: task.id, amount, createdAt: task.createdAt, status: 'open' });
  saveLedger(ctx.ledgerPath, ledger);
  print(Boolean(o.json), { issue: key, task }, () => `linked ${c.bold(key)} -> ${task.title} (${amount} ${task.asset.symbol})\n${c.dim(task.url)}`);
});

// ---------------------------------------------------------------- doctor
common(program.command('doctor').description('Check wallet, Gibwork API, and GitHub access')).action(async (o) => {
  const ctx = buildContext(ctxOpts(o));
  const rows: Array<[string, boolean, string]> = [];
  rows.push(['policy', true, ctx.policySource]);
  rows.push([
    'wallet',
    true,
    `${ctx.gibwork.wallet} (${ctx.gibwork.mode === 'keypair' ? 'your keypair: reads + writes' : 'ephemeral: read-only, nothing can be paid'})`,
  ]);
  try {
    const t = await ctx.gibwork.listAvailable(100);
    rows.push(['gibwork api', true, `${ctx.policy.environment}: ${t.length} open bounties discoverable via SDK tasks.listAvailable`]);
  } catch (err) {
    rows.push(['gibwork api', false, describeError(err)]);
  }
  try {
    await ctx.github.getUser('octocat');
    rows.push(['github api', true, ctx.github.authenticated ? 'authenticated (GITHUB_TOKEN)' : 'anonymous (public repos only, 60 req/h)']);
  } catch (err) {
    rows.push(['github api', false, (err as Error).message]);
  }
  const ledger = ledgerFor(ctx);
  rows.push(['ledger', true, `${ctx.ledgerPath}: ${ledger.bounties.length} bounties, ${ledger.payouts.length} payouts`]);
  print(Boolean(o.json), rows.map(([name, ok, detail]) => ({ name, ok, detail })), () =>
    rows.map(([n, ok, d]) => `  ${ok ? c.green('✓') : c.red('✗')} ${n.padEnd(12)} ${d}`).join('\n'),
  );
  if (rows.some((r) => !r[1])) process.exitCode = 1;
});

// ---------------------------------------------------------------- mcp
program
  .command('mcp')
  .description('Run merge2pay as an MCP server (stdio) for Claude Code, Codex, or any MCP client')
  .option('--policy <file>', 'policy file')
  .option('--ledger <file>', 'ledger file', '.merge2pay/ledger.json')
  .option('--fixtures <file>', 'fixture file instead of the live API')
  .action(async (o) => {
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer(ctxOpts(o));
  });

program.parseAsync().catch((err: unknown) => {
  const e = err as Error & { status?: number; body?: unknown };
  const msg = e instanceof GibworkApiError ? `Gibwork API ${describeError(e)}` : e.message;
  if (process.argv.includes('--json')) process.stderr.write(JSON.stringify({ ok: false, error: { message: msg } }) + '\n');
  else process.stderr.write(`${c.red('error')} ${msg}\n`);
  process.exitCode = e instanceof GibworkApiError ? 20 : 1;
});
