import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { amountFromLabels, buildTaskInput, findExistingBounties, normalizeAmount } from '../src/fund.js';
import { USDC_MINT } from '../src/gibwork.js';
import { emptyLedger, loadLedger, saveLedger } from '../src/ledger.js';
import { fromBaseUnits, loadPolicy, toBaseUnits } from '../src/policy.js';
import type { GithubIssue } from '../src/github.js';
import { policy } from './helpers.js';

const issue = (over: Partial<GithubIssue> = {}): GithubIssue => ({
  number: 10,
  html_url: 'https://github.com/acme/widgets/issues/10',
  title: 'Crash when <input> is empty',
  body: 'Steps:\n1. open <script>alert(1)</script>',
  state: 'open',
  labels: [{ name: 'gibwork' }, { name: 'bounty: $12.5 USDC' }],
  created_at: '2026-10-01T00:00:00Z',
  closed_at: null,
  ...over,
});
const ref = { owner: 'acme', repo: 'widgets', number: 10 };

test('reads the amount from a bounty label', () => {
  assert.equal(amountFromLabels(issue(), 'bounty:'), '12.50');
  assert.equal(amountFromLabels(issue({ labels: ['bug'] }), 'bounty:'), null);
});

test('builds a USDC CreateTaskInput with escaped, verifiable instructions', () => {
  const input = buildTaskInput(ref, issue(), policy());
  assert.equal(input.payment.mintAddress, USDC_MINT);
  assert.equal(input.payment.amount, '12.50');
  assert.equal(input.minSubmissionAmount, '12.50');
  assert.equal(input.title, '[widgets#10] Crash when <input> is empty');
  assert.doesNotMatch(input.content, /<script>/);
  assert.match(input.content, /&lt;script&gt;/);
  assert.match(input.content, /Fixes #10/);
  assert.match(input.content, /gibwork: &lt;your Gibwork username&gt;/);
  assert.match(input.content, /https:\/\/github.com\/acme\/widgets\/issues\/10/);
});

test('--amount overrides the label; missing amount is an error', () => {
  assert.equal(buildTaskInput(ref, issue(), policy(), { amount: '30' }).payment.amount, '30.00');
  assert.throws(() => buildTaskInput(ref, issue({ labels: [] }), policy()), /No amount/);
  assert.throws(() => normalizeAmount('1e3'));
});

test('deadline comes from policy.fund.deadlineDays', () => {
  const p = policy();
  p.fund = { ...p.fund, deadlineDays: 7 };
  const input = buildTaskInput(ref, issue(), p, { now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(input.deadline, '2026-10-08T00:00:00.000Z');
});

test('finds live bounties that already link the issue', () => {
  const live = [
    { id: 'a', content: '<p>Source: https://github.com/acme/widgets/issues/10</p>' },
    { id: 'b', content: '<p>https://github.com/acme/widgets/issues/11</p>' },
  ] as never[];
  assert.deepEqual(findExistingBounties(ref, live).map((t: { id: string }) => t.id), ['a']);
});

test('base-unit maths has no floating point drift', () => {
  assert.equal(toBaseUnits('0.1', 6) + toBaseUnits('0.2', 6), toBaseUnits('0.3', 6));
  assert.equal(fromBaseUnits(25_000_000n, 6), '25.00');
  assert.equal(fromBaseUnits('1500000', 6), '1.50');
});

test('policy validation explains bad files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2p-'));
  const bad = join(dir, 'bad.yml');
  writeFileSync(bad, 'maxPayoutPerBounty: lots\nunknownKey: 1\n');
  assert.throws(() => loadPolicy(bad), /maxPayoutPerBounty/);
  const good = join(dir, 'good.yml');
  writeFileSync(good, 'environment: stage\nmaxPayoutPerBounty: 40\nrequireChecks: success\n');
  const { policy: p } = loadPolicy(good);
  assert.equal(p.environment, 'stage');
  assert.equal(p.maxPayoutPerBounty, '40');
});

test('ledger round-trips atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2p-'));
  const path = join(dir, 'nested', 'ledger.json');
  const l = emptyLedger('stage');
  l.bounties.push({ issue: 'a/b#1', taskId: 't', amount: '1.00', createdAt: 'now', status: 'open' });
  saveLedger(path, l);
  assert.deepEqual(loadLedger(path), l);
});
