/**
 * merge2pay as an MCP server.
 *
 * Deliberately read-only: it gives an agent the *judgement* (is this PR real,
 * merged, unique, and owned by the submitter?) while money still moves through
 * the official Gibwork MCP's prepare -> confirm -> submit flow, or through
 * `merge2pay settle --execute` with its ledger.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatIssue, parseIssueSpec } from './claims.js';
import { buildContext, ledgerFor, type ContextOptions, type Context } from './context.js';
import { buildTaskInput, findExistingBounties } from './fund.js';
import { planSettlement } from './plan.js';
import { renderMarkdown } from './render.js';
import { verifySubmission } from './verify.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

export function createMcpServer(ctx: Context): McpServer {
  const server = new McpServer({ name: 'merge2pay', version: '0.1.0' });

  server.registerTool(
    'merge2pay_verify_pull_request',
    {
      title: 'Verify a PR against a bounty issue',
      description:
        'Check whether a GitHub pull request legitimately completes the bounty for an issue: exists, same repo, closes the issue, merged, CI, authorship, timing. Returns pay | wait | reject | review with evidence.',
      inputSchema: {
        prUrl: z.string().describe('https://github.com/owner/repo/pull/N'),
        issue: z.string().describe('owner/repo#N or issue URL the bounty funds'),
        submitter: z.string().optional().describe('Gibwork username of the submitter'),
        bountyCreatedAt: z.string().optional().describe('ISO time the bounty was posted'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ prUrl, issue, submitter, bountyCreatedAt }) => {
      const v = await verifySubmission(
        { id: 'mcp', content: prUrl, createdAt: new Date().toISOString(), status: 'OPEN', user: { username: submitter ?? 'anonymous' } },
        {
          issue: parseIssueSpec(issue),
          bountyCreatedAt: bountyCreatedAt ?? new Date(0).toISOString(),
          policy: ctx.policy,
          github: ctx.github,
          firstClaims: new Map(),
          paidPrs: new Set(),
        },
      );
      return json(v);
    },
  );

  server.registerTool(
    'merge2pay_plan_settlement',
    {
      title: 'Plan settlement for funded issues',
      description:
        'For every open bounty in the merge2pay ledger (or one task), read Gibwork submissions and GitHub state and return who should be paid, rejected, or nudged. Never moves money.',
      inputSchema: { taskId: z.string().optional(), format: z.enum(['json', 'markdown']).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskId, format }) => {
      const plan = await planSettlement({
        ledger: ledgerFor(ctx),
        policy: ctx.policy,
        gibwork: ctx.gibwork,
        github: ctx.github,
        ...(taskId ? { taskId } : {}),
      });
      return format === 'markdown' ? { content: [{ type: 'text' as const, text: renderMarkdown(plan) }] } : json(plan);
    },
  );

  server.registerTool(
    'merge2pay_draft_bounty',
    {
      title: 'Draft a Gibwork bounty from a GitHub issue',
      description:
        'Read a GitHub issue and return the exact Gibwork CreateTaskInput merge2pay would fund (verifiable claim instructions included), plus any live Gibwork bounty that already targets the issue. Does not create anything.',
      inputSchema: { issue: z.string(), amount: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ issue, amount }) => {
      const ref = parseIssueSpec(issue);
      const gh = await ctx.github.getIssue(ref);
      const input = buildTaskInput(ref, gh, ctx.policy, { amount });
      let existing: string[] = [];
      try {
        existing = findExistingBounties(ref, await ctx.gibwork.listAvailable(100)).map((t) => t.id);
      } catch {
        /* best effort */
      }
      return json({ issue: formatIssue(ref), issueState: gh.state, createTaskInput: input, existingBounties: existing });
    },
  );

  server.registerTool(
    'merge2pay_ledger',
    {
      title: 'Show the merge2pay ledger',
      description: 'Funded issues, their Gibwork task IDs, decisions, and payouts recorded so far.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(ledgerFor(ctx)),
  );

  return server;
}

export async function startMcpServer(opts: ContextOptions): Promise<void> {
  const ctx = buildContext(opts);
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}
