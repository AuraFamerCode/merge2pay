import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureGibwork, type FixtureFile } from '../src/gibwork.js';
import { emptyLedger, type Ledger } from '../src/ledger.js';
import { planSettlement } from '../src/plan.js';
import { fakeGithub, policy, prRoutes, pull, sub } from './helpers.js';

const TASK = 'task-1';
const link = (n: number) => `https://github.com/acme/widgets/pull/${n}`;

function setup(subs: ReturnType<typeof sub>[], ledgerOver: Partial<Ledger['bounties'][number]> = {}) {
  const fixtures: FixtureFile = {
    tasks: {
      [TASK]: {
        id: TASK,
        title: 'Fix #10',
        content: '',
        createdAt: '2026-10-01T00:00:00Z',
        isOpen: true,
        status: 'CREATED',
        asset: { symbol: 'USDC', decimals: 6, amount: '25000000', mintAddress: 'x' },
      },
    },
    submissions: { [TASK]: subs },
  };
  const ledger = emptyLedger();
  ledger.bounties.push({ issue: 'acme/widgets#10', taskId: TASK, amount: '25.00', createdAt: '2026-10-01T00:00:00Z', status: 'open', ...ledgerOver });
  return { gibwork: new FixtureGibwork(fixtures), ledger };
}

test('pays exactly one submission per bounty and rejects copycats', async () => {
  const github = fakeGithub(prRoutes(pull(1)));
  const { gibwork, ledger } = setup([
    sub('s2', 'bob', link(1), '2026-10-07T00:00:00Z'),
    sub('s1', 'alice', link(1), '2026-10-06T00:00:00Z'),
  ]);
  const plan = await planSettlement({ ledger, policy: policy(), gibwork, github });
  const actions = plan.bounties[0]!.actions.map((a) => `${a.kind}:${a.submissionId}`);
  assert.deepEqual(actions, ['approve:s1', 'reject:s2']);
  assert.equal(plan.totals.payout, '25.00');
});

test('an impostor who submits first cannot lock out the real author', async () => {
  const github = fakeGithub(prRoutes(pull(1)));
  const { gibwork, ledger } = setup([
    sub('s1', 'mallory', `${link(1)} github: mallory`, '2026-10-05T00:00:00Z'),
    sub('s2', 'alice', `${link(1)} github: alice`, '2026-10-06T00:00:00Z'),
  ]);
  const plan = await planSettlement({ ledger, policy: policy(), gibwork, github });
  const byId = Object.fromEntries(plan.bounties[0]!.verdicts.map((v) => [v.submissionId, v.decision]));
  assert.deepEqual(byId, { s1: 'reject', s2: 'pay' });
});

test('payout caps send the payee to a human instead of paying', async () => {
  const github = fakeGithub(prRoutes(pull(1)));
  const { gibwork, ledger } = setup([sub('s1', 'alice', link(1))]);
  const plan = await planSettlement({ ledger, policy: policy({ maxPayoutPerBounty: '10' }), gibwork, github });
  assert.equal(plan.totals.approve, 0);
  assert.equal(plan.bounties[0]!.verdicts[0]!.decision, 'review');
});

test('a bounty with an unresolved intent is never planned for payment', async () => {
  const github = fakeGithub(prRoutes(pull(1)));
  const { gibwork, ledger } = setup([sub('s1', 'alice', link(1))], {
    pendingIntent: { kind: 'approve', intentId: 'i-1', submissionId: 's1', at: 'now' },
  });
  const plan = await planSettlement({ ledger, policy: policy(), gibwork, github });
  assert.equal(plan.totals.approve, 0);
  assert.match(plan.bounties[0]!.note!, /unknown outcome/);
  assert.equal(github.calls.length, 0);
});

test('wait comments are posted once per change of evidence', async () => {
  const github = fakeGithub(prRoutes(pull(2, { state: 'open', merged_at: null })));
  const { gibwork, ledger } = setup([sub('s1', 'alice', link(2))]);
  const first = await planSettlement({ ledger, policy: policy(), gibwork, github });
  const action = first.bounties[0]!.actions[0]!;
  assert.equal(action.kind, 'comment');
  ledger.decisions.s1 = { taskId: TASK, decision: 'wait', fingerprint: action.verdict.fingerprint, applied: true, at: 'now' };
  const second = await planSettlement({ ledger, policy: policy(), gibwork, github });
  assert.equal(second.bounties[0]!.actions.length, 0);
});

test('paid and refunded bounties are skipped', async () => {
  const github = fakeGithub({});
  const { gibwork, ledger } = setup([sub('s1', 'alice', link(1))], { status: 'paid' });
  const plan = await planSettlement({ ledger, policy: policy(), gibwork, github });
  assert.equal(plan.bounties.length, 0);
});
