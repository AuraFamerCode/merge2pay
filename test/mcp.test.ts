import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { FixtureGibwork } from '../src/gibwork.js';
import { fakeGithub, policy, prRoutes, pull } from './helpers.js';

test('MCP server exposes read-only tools and verifies a PR', async () => {
  const server = createMcpServer({
    policy: policy(),
    policySource: 'test',
    ledgerPath: '/nonexistent/ledger.json',
    gibwork: new FixtureGibwork({ tasks: {}, submissions: {} }),
    github: fakeGithub(prRoutes(pull(1))),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'merge2pay_draft_bounty',
    'merge2pay_ledger',
    'merge2pay_plan_settlement',
    'merge2pay_verify_pull_request',
  ]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint), 'every tool is read-only');

  const res = await client.callTool({
    name: 'merge2pay_verify_pull_request',
    arguments: { prUrl: 'https://github.com/acme/widgets/pull/1', issue: 'acme/widgets#10', submitter: 'alice' },
  });
  const verdict = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
  assert.equal(verdict.decision, 'pay');
  await client.close();
});
