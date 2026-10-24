import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySubmission, feedbackFor } from '../src/verify.js';
import { fakeGithub, ISSUE, policy, prRoutes, pull, sub } from './helpers.js';

const ctx = (github: ReturnType<typeof fakeGithub>, over: Record<string, unknown> = {}) => ({
  issue: ISSUE,
  bountyCreatedAt: '2026-10-01T00:00:00Z',
  policy: policy(),
  github,
  firstClaims: new Map(),
  paidPrs: new Set<string>(),
  ...over,
});

const link = (n: number) => `https://github.com/acme/widgets/pull/${n}`;

test('merged PR that closes the issue with green CI is paid', async () => {
  const gh = fakeGithub(prRoutes(pull(1)));
  const v = await verifySubmission(sub('s1', 'alice', link(1)), ctx(gh));
  assert.equal(v.decision, 'pay');
  assert.equal(v.prAuthor, 'alice');
});

test('open PR waits; draft PR says so', async () => {
  const gh = fakeGithub(prRoutes(pull(2, { state: 'open', merged_at: null, draft: true })));
  const v = await verifySubmission(sub('s1', 'alice', link(2)), ctx(gh));
  assert.equal(v.decision, 'wait');
  assert.match(v.summary, /draft/);
});

test('closed without merge is rejected', async () => {
  const gh = fakeGithub(prRoutes(pull(3, { merged_at: null })));
  assert.equal((await verifySubmission(sub('s1', 'a', link(3)), ctx(gh))).decision, 'reject');
});

test('PR that fixes a different issue is rejected, or reviewed if policy relaxes it', async () => {
  const gh = fakeGithub(prRoutes(pull(4, { body: 'Fixes #77' })));
  const strict = await verifySubmission(sub('s1', 'a', link(4)), ctx(gh));
  assert.equal(strict.decision, 'reject');
  assert.match(strict.summary, /closes #77, not acme\/widgets#10/);
  const relaxed = await verifySubmission(sub('s1', 'a', link(4)), ctx(gh, { policy: policy({ requireIssueReference: false }) }));
  assert.equal(relaxed.decision, 'review');
});

test('no PR link, wrong repo, and missing PR are rejected without paying', async () => {
  const gh = fakeGithub({});
  assert.equal((await verifySubmission(sub('s', 'a', 'see my drive link'), ctx(gh))).decision, 'reject');
  const wrong = await verifySubmission(sub('s', 'a', 'https://github.com/evil/fork/pull/1'), ctx(gh));
  assert.equal(wrong.decision, 'reject');
  assert.match(wrong.summary, /evil\/fork/);
  const missing = await verifySubmission(sub('s', 'a', link(404)), ctx(gh));
  assert.equal(missing.decision, 'reject');
  assert.match(missing.summary, /does not exist/);
});

test('claiming someone else\'s PR is rejected as an identity mismatch', async () => {
  const gh = fakeGithub(prRoutes(pull(5)));
  const v = await verifySubmission(sub('s1', 'mallory', `${link(5)} github: mallory`), ctx(gh));
  assert.equal(v.decision, 'reject');
  assert.match(v.summary, /claims GitHub @mallory, but PR #5 is by @alice/);
});

test('gibwork: <username> in the PR body proves authorship; a different name rejects', async () => {
  const ok = fakeGithub(prRoutes(pull(6, { body: 'Fixes #10\n\ngibwork: alice_gw' })));
  const v = await verifySubmission(sub('s1', 'alice_gw', link(6)), ctx(ok, { policy: policy({ requireIdentityProof: true }) }));
  assert.equal(v.decision, 'pay');
  const bad = await verifySubmission(sub('s2', 'bob', link(6)), ctx(ok));
  assert.equal(bad.decision, 'reject');
});

test('requireIdentityProof sends unproven claims to a human', async () => {
  const gh = fakeGithub(prRoutes(pull(7)));
  const v = await verifySubmission(sub('s1', 'alice', link(7)), ctx(gh, { policy: policy({ requireIdentityProof: true }) }));
  assert.equal(v.decision, 'review');
});

test('duplicate claims and already-paid PRs are rejected', async () => {
  const gh = fakeGithub(prRoutes(pull(8)));
  const first = new Map([[link(8).toLowerCase(), { id: 's1', user: 'alice' }]]);
  const dup = await verifySubmission(sub('s2', 'bob', link(8)), ctx(gh, { firstClaims: first }));
  assert.equal(dup.decision, 'reject');
  assert.match(dup.summary, /claimed by alice/);
  const paid = await verifySubmission(sub('s1', 'alice', link(8)), ctx(gh, { paidPrs: new Set([link(8).toLowerCase()]) }));
  assert.equal(paid.decision, 'reject');
});

test('merged but CI failing goes to a human; open with failing CI waits', async () => {
  const failing = (sha: string) => ({
    [`/repos/acme/widgets/commits/${sha}/check-runs`]: { check_runs: [{ name: 'lint', status: 'completed', conclusion: 'failure' }] },
    [`/repos/acme/widgets/commits/${sha}/status`]: { statuses: [] },
  });
  const merged = fakeGithub(prRoutes(pull(9), failing('sha9')));
  assert.equal((await verifySubmission(sub('s', 'alice', link(9)), ctx(merged))).decision, 'review');
  const open = fakeGithub(prRoutes(pull(10, { state: 'open', merged_at: null }), failing('sha10')));
  assert.equal((await verifySubmission(sub('s', 'alice', link(10)), ctx(open))).decision, 'wait');
});

test('pre-bounty work warns by default and rejects when policy says so', async () => {
  const gh = fakeGithub(prRoutes(pull(11, { created_at: '2026-09-01T00:00:00Z' })));
  assert.equal((await verifySubmission(sub('s', 'alice', link(11)), ctx(gh))).decision, 'pay');
  const strict = await verifySubmission(sub('s', 'alice', link(11)), ctx(gh, { policy: policy({ rejectPreBountyWork: true }) }));
  assert.equal(strict.decision, 'reject');
});

test('feedback text lists only the problems', async () => {
  const gh = fakeGithub(prRoutes(pull(12, { merged_at: null })));
  const v = await verifySubmission(sub('s', 'alice', link(12)), ctx(gh));
  const text = feedbackFor(v);
  assert.match(text, /closed without being merged/);
  assert.doesNotMatch(text, /First claim/);
});
