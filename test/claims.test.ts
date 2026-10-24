import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractClaimedGithubHandle,
  extractClosingRefs,
  extractGibworkHandle,
  extractIssueUrls,
  extractPullRequests,
  parseIssueSpec,
} from '../src/claims.js';

test('extracts PR links from Gibwork HTML, deduplicated and normalised', () => {
  const html =
    '<p>Done: <a href="https://github.com/Acme/widgets/pull/42">https://github.com/Acme/widgets/pull/42</a><br />also https://github.com/acme/other/pull/7.</p>';
  const prs = extractPullRequests(html);
  assert.deepEqual(
    prs.map((p) => p.url),
    ['https://github.com/Acme/widgets/pull/42', 'https://github.com/acme/other/pull/7'],
  );
});

test('ignores non-PR GitHub links', () => {
  assert.equal(extractPullRequests('see https://github.com/acme/widgets/issues/3').length, 0);
  assert.equal(extractIssueUrls('see https://github.com/acme/widgets/issues/3')[0]?.number, 3);
});

test('closing keywords: short refs, cross-repo refs, URLs, and case', () => {
  const base = { owner: 'acme', repo: 'widgets' };
  const refs = extractClosingRefs(
    'This FIXES #10, resolves other/lib#4 and closes https://github.com/acme/widgets/issues/11. Mentions #99 only.',
    base,
  );
  assert.deepEqual(
    refs.map((r) => `${r.owner}/${r.repo}#${r.number}`),
    ['acme/widgets#10', 'other/lib#4', 'acme/widgets#11'],
  );
});

test('a bare mention is not a closing reference', () => {
  assert.equal(extractClosingRefs('Related to #10', { owner: 'a', repo: 'b' }).length, 0);
});

test('identity markers', () => {
  assert.equal(extractGibworkHandle('Fixes #1\n\ngibwork: @kanish007'), 'kanish007');
  assert.equal(extractGibworkHandle('no marker'), null);
  assert.equal(extractClaimedGithubHandle('<p>PR ... (github: @alice-dev)</p>'), 'alice-dev');
  assert.equal(extractClaimedGithubHandle('https://github.com/acme/widgets/pull/1'), null);
});

test('parseIssueSpec accepts shorthand and URLs, rejects junk', () => {
  assert.deepEqual(parseIssueSpec('honojs/hono#5345'), { owner: 'honojs', repo: 'hono', number: 5345 });
  assert.deepEqual(parseIssueSpec('https://github.com/honojs/hono/issues/5345'), { owner: 'honojs', repo: 'hono', number: 5345 });
  assert.throws(() => parseIssueSpec('hono 5345'));
});
