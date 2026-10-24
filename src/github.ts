/**
 * Minimal GitHub REST client. Works unauthenticated for public repositories;
 * set GITHUB_TOKEN for higher rate limits, private repos, or issue comments.
 */
import type { IssueRef, PullRef, RepoRef } from './claims.js';

export interface GithubUser {
  login: string;
  created_at?: string;
}

export interface GithubPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at: string | null;
  created_at: string;
  user: { login: string };
  head: { sha: string };
  base: { repo: { full_name: string } };
}

export interface GithubIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason?: string | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
  created_at: string;
  closed_at: string | null;
}

export type ChecksState = 'success' | 'failure' | 'pending' | 'none';

export interface ChecksSummary {
  state: ChecksState;
  total: number;
  failed: string[];
  pending: string[];
}

export class GithubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'GithubError';
  }
}

export interface GithubClientOptions {
  token?: string | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class GithubClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(options: GithubClientOptions = {}) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'merge2pay',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        throw new GithubError(
          res.status,
          path,
          `GitHub rate limit reached${this.token ? '' : ' (anonymous: 60 requests/hour). Set GITHUB_TOKEN to raise it'}.`,
        );
      }
      const msg = (body && typeof body === 'object' && 'message' in body && String(body.message)) || res.statusText;
      throw new GithubError(res.status, path, `GitHub ${res.status} on ${path}: ${msg}`);
    }
    return body as T;
  }

  /** GET with an in-process cache so one run never asks twice. */
  private get<T>(path: string): Promise<T> {
    let hit = this.cache.get(path) as Promise<T> | undefined;
    if (!hit) {
      hit = this.request<T>(path);
      this.cache.set(path, hit);
      hit.catch(() => this.cache.delete(path));
    }
    return hit;
  }

  getPull(ref: PullRef | IssueRef): Promise<GithubPull> {
    return this.get(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  }

  getIssue(ref: IssueRef): Promise<GithubIssue> {
    return this.get(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
  }

  getUser(login: string): Promise<GithubUser> {
    return this.get(`/users/${encodeURIComponent(login)}`);
  }

  listIssuesWithLabel(repo: RepoRef, label: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GithubIssue[]> {
    const q = new URLSearchParams({ labels: label, state, per_page: '100' });
    return this.get<GithubIssue[]>(`/repos/${repo.owner}/${repo.repo}/issues?${q}`).then((items) =>
      items.filter((i) => !i.pull_request),
    );
  }

  /** Combine check runs and legacy commit statuses into one verdict. */
  async getChecks(repo: RepoRef, sha: string): Promise<ChecksSummary> {
    const [runs, status] = await Promise.all([
      this.get<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(
        `/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs?per_page=100`,
      ),
      this.get<{ statuses: Array<{ context: string; state: string }> }>(
        `/repos/${repo.owner}/${repo.repo}/commits/${sha}/status`,
      ),
    ]);
    const failed: string[] = [];
    const pending: string[] = [];
    let total = 0;
    for (const r of runs.check_runs ?? []) {
      total++;
      if (r.status !== 'completed') pending.push(r.name);
      else if (!['success', 'skipped', 'neutral'].includes(r.conclusion ?? '')) failed.push(r.name);
    }
    for (const s of status.statuses ?? []) {
      total++;
      if (s.state === 'pending') pending.push(s.context);
      else if (s.state !== 'success') failed.push(s.context);
    }
    const state: ChecksState = total === 0 ? 'none' : failed.length ? 'failure' : pending.length ? 'pending' : 'success';
    return { state, total, failed, pending };
  }

  async commentOnIssue(ref: IssueRef, body: string): Promise<{ html_url: string }> {
    if (!this.token) throw new Error('GITHUB_TOKEN is required to comment on issues');
    return this.request(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
      headers: { 'content-type': 'application/json' },
    });
  }
}
