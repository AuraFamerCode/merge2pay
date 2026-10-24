/**
 * Parsing helpers: pull GitHub references out of free-form text.
 *
 * Gibwork submissions and bounty descriptions are HTML written by humans, so
 * everything here is tolerant of markup, mixed case, and trailing noise.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface IssueRef extends RepoRef {
  number: number;
}

export interface PullRef extends RepoRef {
  number: number;
  url: string;
}

const PR_URL =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/gi;
const ISSUE_URL =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)/gi;

/** Strip tags and decode the handful of entities Gibwork content uses. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Every distinct GitHub pull request URL in the text, in order of appearance. */
export function extractPullRequests(text: string): PullRef[] {
  const plain = htmlToText(text);
  const seen = new Set<string>();
  const out: PullRef[] = [];
  for (const m of plain.matchAll(PR_URL)) {
    const owner = m[1]!;
    const repo = m[2]!.replace(/\.git$/, '');
    const number = Number(m[3]);
    const key = `${owner}/${repo}#${number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` });
  }
  return out;
}

/** Every distinct GitHub issue URL in the text. */
export function extractIssueUrls(text: string): IssueRef[] {
  const plain = htmlToText(text);
  const seen = new Set<string>();
  const out: IssueRef[] = [];
  for (const m of plain.matchAll(ISSUE_URL)) {
    const ref = { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
    const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Issues a pull request body says it closes, using GitHub's closing keywords
 * (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved).
 * Short refs (#12) resolve against the PR's own repository.
 */
export function extractClosingRefs(body: string, base: RepoRef): IssueRef[] {
  const out: IssueRef[] = [];
  const seen = new Set<string>();
  const re =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:#|\/issues\/)(\d+)|#(\d+))/gi;
  for (const m of body.matchAll(re)) {
    const ref: IssueRef = m[4]
      ? { ...base, number: Number(m[4]) }
      : { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
    const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** `owner/repo#123` or a full issue URL. */
export function parseIssueSpec(spec: string): IssueRef {
  const url = extractIssueUrls(spec)[0];
  if (url) return url;
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`Expected owner/repo#123 or an issue URL, got "${spec}"`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/**
 * Optional proof of authorship: a contributor writes `gibwork: <username>` in
 * the PR description so the payout can be tied to their Gibwork account.
 */
export function extractGibworkHandle(body: string): string | null {
  const m = /gibwork(?:\.work)?\s*[:=]\s*@?([A-Za-z0-9_.-]{2,40})/i.exec(body);
  return m ? m[1]!.replace(/[.]+$/, '') : null;
}

/** A GitHub handle the submitter claims, e.g. "github: @alice" or "github.com/alice". */
export function extractClaimedGithubHandle(text: string): string | null {
  const plain = htmlToText(text);
  const m =
    /github\s*[:=]\s*@?([A-Za-z0-9-]{1,39})\b/i.exec(plain) ??
    /github\.com\/([A-Za-z0-9-]{1,39})(?:\/?\s|\/?$)/i.exec(plain);
  return m ? m[1]! : null;
}

export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

export function sameIssue(a: IssueRef, b: IssueRef): boolean {
  return sameRepo(a, b) && a.number === b.number;
}

export function formatIssue(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}
