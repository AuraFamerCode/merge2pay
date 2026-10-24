/**
 * Maintainer policy: the rules merge2pay applies before it will pay anyone.
 * Lives in merge2pay.yml next to the code, so changes go through review.
 */
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const decimal = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d{1,6})?$/.test(v), 'must be a decimal amount like "25.00"');

export const PolicySchema = z
  .object({
    /** Gibwork environment the bounties live in. */
    environment: z.enum(['production', 'stage']).default('production'),
    /** Only pay when the pull request is merged (not just opened). */
    requireMerged: z.boolean().default(true),
    /** CI gate: "success" needs green checks, "not-failing" tolerates none/pending, "ignore" skips. */
    requireChecks: z.enum(['success', 'not-failing', 'ignore']).default('not-failing'),
    /** The PR must say it closes the bounty's issue (Fixes #N). */
    requireIssueReference: z.boolean().default(true),
    /** The PR body must contain `gibwork: <username>` matching the submitter. */
    requireIdentityProof: z.boolean().default(false),
    /** Reject PRs opened before the bounty existed (otherwise only warn). */
    rejectPreBountyWork: z.boolean().default(false),
    /** Hard ceiling for one approval, in the bounty token. */
    maxPayoutPerBounty: decimal.default('100'),
    /** Hard ceiling for all approvals in one run. */
    maxPayoutPerRun: decimal.default('250'),
    /** Reject clearly invalid submissions on Gibwork with a reason. */
    autoReject: z.boolean().default(true),
    /** Leave a status comment on submissions that are waiting on merge/CI. */
    commentOnWait: z.boolean().default(true),
    /** Rating sent with each approval (1-5). */
    rating: z.number().int().min(1).max(5).default(5),
    /** Defaults for `merge2pay fund`. */
    fund: z
      .object({
        label: z.string().default('gibwork'),
        amountLabelPrefix: z.string().default('bounty:'),
        defaultAmount: decimal.optional(),
        minSubmissionAmount: decimal.optional(),
        tags: z.array(z.string()).default(['Development']),
        deadlineDays: z.number().int().positive().optional(),
        allowOnlyVerifiedSubmissions: z.boolean().default(false),
      })
      .default({}),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export function loadPolicy(path?: string): { policy: Policy; source: string } {
  const candidate = path ?? 'merge2pay.yml';
  if (!existsSync(candidate)) {
    if (path) throw new Error(`Policy file not found: ${path}`);
    return { policy: PolicySchema.parse({}), source: 'built-in defaults' };
  }
  const raw = parse(readFileSync(candidate, 'utf8')) ?? {};
  const result = PolicySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid policy in ${candidate}:\n${issues}`);
  }
  return { policy: result.data, source: candidate };
}

/** Compare decimal strings without floating point surprises. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole! + frac.padEnd(decimals, '0').slice(0, decimals));
}

export function fromBaseUnits(units: bigint | string | number, decimals: number): string {
  const s = BigInt(units).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac.padEnd(2, '0')}` : `${whole}.00`;
}
