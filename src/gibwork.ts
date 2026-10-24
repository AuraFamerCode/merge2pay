/**
 * Gibwork access through the official @gibwork/sdk.
 *
 * Three modes:
 *  - keypair:   GIBWORK_KEYPAIR_PATH or GIBWORK_PRIVATE_KEY is set (same names as
 *               the official CLI). Reads your own bounties and can write.
 *  - ephemeral: no key configured. Read-only discovery and task lookup are signed
 *               with a throwaway in-memory keypair that is never saved and holds
 *               no funds. Nothing can be written.
 *  - fixtures:  a JSON file stands in for Gibwork (tests, offline demos).
 */
import { readFileSync, statSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import {
  GibworkClient,
  signPreparedTransaction,
  type ApprovalQuote,
  type AvailableTask,
  type CreateTaskInput,
  type PaymentQuote,
  type TaskDetails,
  type WalletSigner,
} from '@gibwork/sdk';
import { createKeypairSigner } from '@gibwork/sdk/node';
import type { SubmissionLike } from './verify.js';

/** USDC on Solana: the only mint the official CLI allows for bounty funding. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type SigningMode = 'keypair' | 'ephemeral' | 'fixtures';

export interface TaskView {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  isOpen: boolean;
  status: string;
  asset: { symbol: string; decimals: number; amount: number | string; mintAddress: string };
  pendingCount?: number;
  url: string;
}

export interface SubmissionView extends SubmissionLike {
  taskId: string;
}

export interface FixtureFile {
  wallet?: string;
  tasks: Record<string, Omit<TaskView, 'url'> & { url?: string }>;
  submissions: Record<string, SubmissionView[]>;
}

export interface GibworkSource {
  mode: SigningMode;
  environment: 'production' | 'stage';
  wallet: string;
  canWrite: boolean;
  getTask(taskId: string): Promise<TaskView>;
  listOpenSubmissions(taskId: string): Promise<SubmissionView[]>;
  listAvailable(limit?: number): Promise<AvailableTask[]>;
}

/** Human message for SDK errors, including the API's own explanation. */
export function describeError(err: unknown): string {
  const e = err as { message?: string; status?: number; body?: { message?: unknown } };
  const apiMsg = e?.body && typeof e.body === 'object' ? e.body.message : undefined;
  if (apiMsg) return `HTTP ${e.status}: ${Array.isArray(apiMsg) ? apiMsg.join('; ') : String(apiMsg)}`;
  return e?.message ?? String(err);
}

export function taskUrl(id: string, environment: 'production' | 'stage'): string {
  // Stage bounties are kept out of the public marketplace, so there is no public page for them.
  return environment === 'production' ? `https://gib.work/bounty/${id}` : `stage bounty ${id}`;
}

/** Resolve credentials the same way the official Gibwork CLI does (env only). */
export function loadSigner(env: NodeJS.ProcessEnv = process.env): { signer: WalletSigner; mode: SigningMode } {
  const path = env.GIBWORK_KEYPAIR_PATH;
  const raw = env.GIBWORK_PRIVATE_KEY;
  if (path && raw) throw new Error('Set only one of GIBWORK_KEYPAIR_PATH or GIBWORK_PRIVATE_KEY');
  if (path) {
    const mode = statSync(path).mode & 0o077;
    if (mode && process.platform !== 'win32') {
      process.stderr.write(`warning: ${path} is readable by other users; run chmod 600 on it\n`);
    }
    return { signer: createKeypairSigner(readFileSync(path, 'utf8').trim()), mode: 'keypair' };
  }
  if (raw) return { signer: createKeypairSigner(raw.trim()), mode: 'keypair' };
  return { signer: createKeypairSigner(Keypair.generate().secretKey), mode: 'ephemeral' };
}

function toTaskView(t: TaskDetails, environment: 'production' | 'stage'): TaskView {
  return {
    id: t.id,
    title: t.title,
    content: t.content,
    createdAt: t.createdAt,
    isOpen: t.isOpen,
    status: t.status,
    asset: {
      symbol: t.asset.symbol,
      decimals: t.asset.decimals,
      amount: t.asset.amount,
      mintAddress: t.asset.mintAddress,
    },
    pendingCount: t.taskSubmissionsPendingCount,
    url: taskUrl(t.id, environment),
  };
}

export class LiveGibwork implements GibworkSource {
  readonly client: GibworkClient;
  readonly wallet: string;
  readonly canWrite: boolean;

  constructor(
    readonly signer: WalletSigner,
    readonly mode: SigningMode,
    readonly environment: 'production' | 'stage',
    baseUrl?: string,
  ) {
    this.client = new GibworkClient({
      signer,
      production: environment === 'production',
      ...(baseUrl ? { baseUrl } : {}),
    });
    this.wallet = signer.publicKey.toBase58();
    this.canWrite = mode === 'keypair';
  }

  async getTask(taskId: string): Promise<TaskView> {
    return toTaskView(await this.client.tasks.get(taskId), this.environment);
  }

  async listOpenSubmissions(taskId: string): Promise<SubmissionView[]> {
    const out: SubmissionView[] = [];
    for (let page = 1; ; page++) {
      const res = await this.client.submissions.list(taskId, { page, limit: 100 });
      for (const s of res.results) {
        if (s.status !== 'OPEN') continue;
        out.push({ id: s.id, taskId, content: s.content, createdAt: s.createdAt, status: s.status, user: { username: s.user.username } });
      }
      if (page >= res.lastPage) break;
    }
    return out;
  }

  async listAvailable(limit = 100): Promise<AvailableTask[]> {
    return (await this.client.tasks.listAvailable({ page: 1, limit })).results;
  }

  // ---- writes (keypair mode only) ---------------------------------------

  private assertWrite(): void {
    if (!this.canWrite) throw new Error('No wallet configured: set GIBWORK_KEYPAIR_PATH to enable writes');
  }

  /** prepare -> caller persists intent -> sign -> submit (never retried). */
  async createTask(
    input: CreateTaskInput,
    hooks: { onQuote: (q: PaymentQuote) => Promise<boolean>; onIntent: (intentId: string, taskId: string) => void },
  ): Promise<{ taskId: string; txHash?: string; status: string } | null> {
    this.assertWrite();
    const prepared = await this.client.tasks.prepareCreate(input);
    if (!(await hooks.onQuote(prepared.paymentQuote))) return null;
    hooks.onIntent(prepared.intentId, prepared.taskId);
    const signed = await signPreparedTransaction(prepared.serializedTransaction, this.signer);
    const res = await this.client.tasks.submitCreate(prepared.intentId, signed);
    return { taskId: res.taskId, status: res.status, ...(res.txHash ? { txHash: res.txHash } : {}) };
  }

  async approve(
    taskId: string,
    submissionId: string,
    amount: string,
    rating: number,
    hooks: { onQuote: (q: ApprovalQuote) => Promise<boolean>; onIntent: (intentId: string) => void },
  ): Promise<{ txHash: string } | null> {
    this.assertWrite();
    const prepared = await this.client.submissions.prepareApproval(taskId, submissionId, { amount, rating });
    if (!(await hooks.onQuote(prepared.approvalQuote))) return null;
    hooks.onIntent(prepared.intentId);
    const signed = await signPreparedTransaction(prepared.serializedTransaction, this.signer);
    const res = await this.client.submissions.submitApproval(taskId, submissionId, prepared.intentId, signed);
    return { txHash: res.txHash };
  }

  async reject(taskId: string, submissionId: string, reason: string): Promise<void> {
    this.assertWrite();
    await this.client.submissions.reject(taskId, submissionId, reason);
  }

  async comment(taskId: string, submissionId: string, text: string): Promise<void> {
    this.assertWrite();
    await this.client.submissions.comments.create(taskId, submissionId, text);
  }
}

export class FixtureGibwork implements GibworkSource {
  readonly mode = 'fixtures' as const;
  readonly canWrite = false;
  readonly wallet: string;
  constructor(
    private readonly data: FixtureFile,
    readonly environment: 'production' | 'stage' = 'production',
  ) {
    this.wallet = data.wallet ?? 'fixture-wallet';
  }

  static fromFile(path: string, environment?: 'production' | 'stage'): FixtureGibwork {
    return new FixtureGibwork(JSON.parse(readFileSync(path, 'utf8')) as FixtureFile, environment);
  }

  async getTask(taskId: string): Promise<TaskView> {
    const t = this.data.tasks[taskId];
    if (!t) throw new Error(`Fixture has no task ${taskId}`);
    return { ...t, url: t.url ?? taskUrl(taskId, this.environment) };
  }

  async listOpenSubmissions(taskId: string): Promise<SubmissionView[]> {
    return (this.data.submissions[taskId] ?? []).filter((s) => s.status === 'OPEN');
  }

  async listAvailable(): Promise<AvailableTask[]> {
    return [];
  }
}
