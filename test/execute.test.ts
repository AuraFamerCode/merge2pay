import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GibworkAmbiguousSubmitError, type ApprovalQuote } from '@gibwork/sdk';
import { executePlan } from '../src/execute.js';
import { FixtureGibwork, type LiveGibwork } from '../src/gibwork.js';
import { emptyLedger } from '../src/ledger.js';
import { planSettlement } from '../src/plan.js';
import { fakeGithub, policy, prRoutes, pull, sub } from './helpers.js';

const quote: ApprovalQuote = {
  token: { mintAddress: 'm', symbol: 'USDC', decimals: 6 },
  grossApprovalAmount: '25.00',
  platformFee: { percent: 5, amount: '1.25' },
  referralFee: '0',
  netPayoutAmount: '23.75',
  closeTask: true,
};

async function scenario() {
  const github = fakeGithub({ ...prRoutes(pull(1)), ...prRoutes(pull(3, { merged_at: null })) });
  const gibwork = new FixtureGibwork({
    tasks: {
      t1: { id: 't1', title: 'x', content: '', createdAt: '2026-10-01T00:00:00Z', isOpen: true, status: 'CREATED', asset: { symbol: 'USDC', decimals: 6, amount: '25000000', mintAddress: 'm' } },
    },
    submissions: {
      t1: [
        { ...sub('s1', 'alice', 'https://github.com/acme/widgets/pull/1'), taskId: 't1' },
        { ...sub('s3', 'carol', 'https://github.com/acme/widgets/pull/3', '2026-10-07T00:00:00Z'), taskId: 't1' },
      ],
    },
  });
  const ledger = emptyLedger();
  ledger.bounties.push({ issue: 'acme/widgets#10', taskId: 't1', amount: '25.00', createdAt: '2026-10-01T00:00:00Z', status: 'open' });
  const plan = await planSettlement({ ledger, policy: policy(), gibwork, github });
  const ledgerPath = join(mkdtempSync(join(tmpdir(), 'm2p-')), 'ledger.json');
  return { plan, ledger, ledgerPath };
}

test('records the intent before submitting, then the payout; rejects with a reason', async () => {
  const { plan, ledger, ledgerPath } = await scenario();
  const calls: string[] = [];
  const writer = {
    approve: async (_t: string, s: string, amount: string, _r: number, hooks: { onQuote: (q: ApprovalQuote) => Promise<boolean>; onIntent: (id: string) => void }) => {
      assert.equal(await hooks.onQuote(quote), true);
      hooks.onIntent('intent-1');
      const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      assert.equal(onDisk.bounties[0].pendingIntent.intentId, 'intent-1', 'intent must be on disk before submit');
      calls.push(`approve ${s} ${amount}`);
      return { txHash: 'TX1' };
    },
    reject: async (_t: string, s: string, reason: string) => {
      calls.push(`reject ${s}`);
      assert.match(reason, /closed without being merged/);
    },
    comment: async () => calls.push('comment'),
  } as unknown as LiveGibwork;

  const res = await executePlan(plan, ledger, policy(), writer, { yes: true, ledgerPath, log: () => {} });
  assert.deepEqual(calls, ['approve s1 25.00', 'reject s3']);
  assert.equal(res.approved, 1);
  const saved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(saved.bounties[0].status, 'paid');
  assert.equal(saved.bounties[0].pendingIntent, null);
  assert.equal(saved.payouts[0].txHash, 'TX1');
  assert.equal(saved.payouts[0].pr, 'https://github.com/acme/widgets/pull/1');
});

test('an ambiguous submit halts everything and leaves the intent for reconciliation', async () => {
  const { plan, ledger, ledgerPath } = await scenario();
  const writer = {
    approve: async (_t: string, _s: string, _a: string, _r: number, hooks: { onIntent: (id: string) => void }) => {
      hooks.onIntent('intent-9');
      throw new GibworkAmbiguousSubmitError('POST', '/x', { operation: 'approve-submission', intentId: 'intent-9' });
    },
    reject: async () => assert.fail('must not continue after an ambiguous payment'),
    comment: async () => {},
  } as unknown as LiveGibwork;
  const res = await executePlan(plan, ledger, policy(), writer, { yes: true, ledgerPath, log: () => {} });
  assert.match(res.halted!, /intent-9/);
  const saved = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(saved.bounties[0].pendingIntent.intentId, 'intent-9');
  assert.equal(saved.payouts.length, 0);
});

test('without --yes and without a TTY, payouts are skipped, never assumed', async () => {
  const { plan, ledger, ledgerPath } = await scenario();
  const writer = {
    approve: async (_t: string, _s: string, _a: string, _r: number, hooks: { onQuote: (q: ApprovalQuote) => Promise<boolean> }) =>
      (await hooks.onQuote(quote)) ? { txHash: 'nope' } : null,
    reject: async () => {},
    comment: async () => {},
  } as unknown as LiveGibwork;
  const res = await executePlan(plan, ledger, policy(), writer, { yes: false, ledgerPath, log: () => {} });
  assert.equal(res.approved, 0);
  assert.equal(res.skipped, 1);
});
