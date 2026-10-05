import { AzureDevOpsClient, syncIteration } from "../adapters/azure/client.ts";
import { FetchHttpClient } from "../adapters/http.ts";
import { azurePat } from "../config/load.ts";
import type { AppConfig } from "../config/types.ts";
import { nowIso } from "../domain/time.ts";
import type { Db } from "../storage/db.ts";

export const SYNC_INTERVAL_MS = 60 * 60 * 1000;

export interface SyncLast {
  ok: boolean;
  finishedAt: string;
  count: number | null;
  error: string | null;
}

export interface SyncStatus {
  running: boolean;
  intervalMs: number;
  last: SyncLast | null;
}

export interface SyncTriggerResult {
  ok: boolean;
  busy: boolean;
  running: boolean;
  count?: number;
  syncRunId?: string;
  error?: string;
  finishedAt?: string;
}

type Runner = () => Promise<{ count: number; syncRunId?: string }>;

export interface AutoSync {
  trigger: () => Promise<SyncTriggerResult>;
  status: () => SyncStatus;
  start: () => void;
  stop: () => void;
}

export function createAutoSync(opts: {
  db: Db;
  config: AppConfig;
  intervalMs?: number;
  run?: Runner;
}): AutoSync {
  const intervalMs = opts.intervalMs ?? SYNC_INTERVAL_MS;
  const run = opts.run ?? (() => syncWithEnvPat(opts.db, opts.config));
  let running = false;
  let last: SyncLast | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function trigger(): Promise<SyncTriggerResult> {
    if (running) {
      return { ok: false, busy: true, running: true, error: "Ya hay una sincronización en curso." };
    }
    running = true;
    try {
      const result = await run();
      const finishedAt = nowIso();
      last = { ok: true, finishedAt, count: result.count, error: null };
      return {
        ok: true,
        busy: false,
        running: false,
        count: result.count,
        syncRunId: result.syncRunId,
        finishedAt
      };
    } catch (error) {
      const finishedAt = nowIso();
      const message = publicSyncError(error);
      last = { ok: false, finishedAt, count: null, error: message };
      return { ok: false, busy: false, running: false, error: message, finishedAt };
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void trigger().then((result) => {
        if (result.busy) return;
        console.log(
          result.ok
            ? `[tl-control] sync automático ok (${result.count ?? 0} ítems)`
            : `[tl-control] sync automático: ${result.error ?? "error"}`
        );
      });
    }, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    trigger,
    status: () => ({ running, intervalMs, last }),
    start,
    stop
  };
}

async function syncWithEnvPat(db: Db, config: AppConfig): Promise<{ count: number; syncRunId: string }> {
  const pat = azurePat();
  if (!pat) {
    throw new Error("Sin PAT. Definí AZURE_DEVOPS_EXT_PAT o AZURE_DEVOPS_PAT en la terminal, o en un .env local (no se sube a Git).");
  }
  const client = new AzureDevOpsClient(config, new FetchHttpClient(), { pat });
  const result = await syncIteration(db, config, client, config.azure.iterationPath);
  return { count: result.count, syncRunId: result.syncRunId };
}

function publicSyncError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[A-Za-z0-9+/=_-]{24,}/g, "[redacted]").slice(0, 300);
}
