import { GithubClient, type GithubPull } from '../src/github.js';
import { PolicySchema, type Policy } from '../src/policy.js';

type Routes = Record<string, unknown>;

/** A GithubClient backed by an in-memory route table. Unknown paths 404. */
export function fakeGithub(routes: Routes): GithubClient & { calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const path = String(url).replace('https://api.github.com', '');
    calls.push(path);
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(k + '?'));
    if (!key) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  const client = new GithubClient({ fetch: fetchImpl }) as GithubClient & { calls: string[] };
  client.calls = calls;
  return client;
}

export function pull(n: number, over: Partial<GithubPull> = {}): GithubPull {
  return {
    number: n,
    html_url: `https://github.com/acme/widgets/pull/${n}`,
    title: `Fix things (#${n})`,
    body: 'Fixes #10',
    state: 'closed',
    merged_at: '2026-10-10T00:00:00Z',
    created_at: '2026-10-05T00:00:00Z',
    user: { login: 'alice' },
    head: { sha: `sha${n}` },
    base: { repo: { full_name: 'acme/widgets' } },
    ...over,
  };
}

export function greenChecks(sha: string): Routes {
  return {
    [`/repos/acme/widgets/commits/${sha}/check-runs`]: {
      check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    },
    [`/repos/acme/widgets/commits/${sha}/status`]: { statuses: [] },
  };
}

export function prRoutes(p: GithubPull, checks: Routes = greenChecks(p.head.sha)): Routes {
  return { [`/repos/acme/widgets/pulls/${p.number}`]: p, ...checks };
}

export function policy(over: Partial<Policy> = {}): Policy {
  return { ...PolicySchema.parse({}), ...over };
}

export const ISSUE = { owner: 'acme', repo: 'widgets', number: 10 };

export function sub(id: string, user: string, content: string, createdAt = '2026-10-06T00:00:00Z') {
  return { id, taskId: 'task-1', content, createdAt, status: 'OPEN', user: { username: user } };
}
