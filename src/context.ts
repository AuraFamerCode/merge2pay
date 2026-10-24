/** Shared wiring for the CLI and the MCP server. */
import { FixtureGibwork, LiveGibwork, loadSigner, type GibworkSource } from './gibwork.js';
import { GithubClient } from './github.js';
import { loadLedger } from './ledger.js';
import { loadPolicy, type Policy } from './policy.js';

export interface ContextOptions {
  policy?: string | undefined;
  ledger?: string | undefined;
  fixtures?: string | undefined;
  environment?: 'production' | 'stage' | undefined;
}

export interface Context {
  policy: Policy;
  policySource: string;
  ledgerPath: string;
  gibwork: GibworkSource;
  github: GithubClient;
}

export function buildContext(opts: ContextOptions): Context {
  const { policy, source } = loadPolicy(opts.policy);
  const environment = opts.environment ?? (process.env.GIBWORK_ENVIRONMENT as Policy['environment'] | undefined) ?? policy.environment;
  const ledgerPath = opts.ledger ?? '.merge2pay/ledger.json';
  const github = new GithubClient({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined });
  let gibwork: GibworkSource;
  if (opts.fixtures) {
    gibwork = FixtureGibwork.fromFile(opts.fixtures, environment);
  } else {
    const { signer, mode } = loadSigner();
    gibwork = new LiveGibwork(signer, mode, environment, process.env.GIBWORK_API_URL || undefined);
  }
  return { policy: { ...policy, environment }, policySource: source, ledgerPath, gibwork, github };
}

export function ledgerFor(ctx: Context) {
  return loadLedger(ctx.ledgerPath, ctx.policy.environment);
}
