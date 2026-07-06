import { config as loadEnv } from "dotenv";
import { createServer } from "http";
import { spawn } from "child_process";
import { resolve } from "path";
import { fileURLToPath } from "url";

loadEnv({ path: "../.env.local" });
loadEnv();

const PORT = process.env.PORT ?? "3001";
const SECRET = process.env.CRON_SECRET;

if (!SECRET) {
  console.error("CRON_SECRET env var is required");
  process.exit(1);
}

const ROOT = resolve(fileURLToPath(import.meta.url), "../../");

// Wallets processed concurrently by jobs spawned here. These partial refreshes run *inside* this
// 512MB web dyno (not a dedicated dyno), so we cap concurrency well below the ingest default of 24
// to keep in-flight /activity payloads from exhausting memory (R14). Override per-deploy via env.
const PARTIAL_WALLET_CONCURRENCY = process.env.PARTIAL_WALLET_CONCURRENCY ?? "8";

type JobMode = "feed" | "markets" | "rescore" | "forward:record" | "forward:score" | "copylist:record" | "copylist:score";

// mode -> the root package.json script it runs. Most are ingest:<mode>; the forward-alpha and copylist
// jobs are their own scripts, so the mapping is explicit rather than a string-concatenated prefix.
const COMMAND: Record<JobMode, string> = {
  feed: "ingest:feed",
  markets: "ingest:markets",
  rescore: "ingest:rescore",
  "forward:record": "forward:record",
  "forward:score": "forward:score",
  "copylist:record": "copylist:record",
  "copylist:score": "copylist:score",
};

// Single global guard: only ONE job runs at a time, regardless of mode. The jobs share this dyno's
// 512MB, so letting feed + markets + rescore run concurrently (as a per-mode guard would) stacks
// their memory and triggers R14.
//
// A request that arrives while another job runs is QUEUED, not dropped: markets and rescore are both
// scheduled at the top of the hour, so a straight reject 409'd rescore every hour (its cron marked it
// failed). Queued modes are coalesced in a Set (a second feed request while feed waits runs once, not
// twice) and drained one at a time when the current job finishes — the lock still serializes, so
// memory never stacks; the collision just costs a ~30s delay instead of a lost run.
let busy: JobMode | null = null;
const pending = new Set<JobMode>();

function runJob(mode: JobMode): boolean {
  if (busy) {
    pending.add(mode);
    return false;
  }
  busy = mode;
  const child = spawn("pnpm", [COMMAND[mode]], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, WALLET_CONCURRENCY: PARTIAL_WALLET_CONCURRENCY },
  });
  const done = (): void => {
    busy = null;
    const next = pending.values().next().value; // FIFO drain of the coalesced queue
    if (next !== undefined) {
      pending.delete(next);
      runJob(next);
    }
  };
  child.on("close", (code) => {
    console.log(`[${mode}] finished (exit ${code ?? "?"})`);
    done();
  });
  child.on("error", (err) => {
    console.error(`[${mode}] spawn error:`, err);
    done();
  });
  return true;
}

const ROUTES: Record<string, JobMode> = {
  "/refresh/feed": "feed",
  "/refresh/markets": "markets",
  "/refresh/rescore": "rescore",
  "/refresh/forward-record": "forward:record",
  "/refresh/forward-score": "forward:score",
  "/refresh/copylist-record": "copylist:record",
  "/refresh/copylist-score": "copylist:score",
};

const server = createServer((req, res) => {
  if (req.headers["authorization"] !== `Bearer ${SECRET}`) {
    res.writeHead(401).end("Unauthorized");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end("Method Not Allowed");
    return;
  }

  const mode = ROUTES[req.url ?? ""];
  if (!mode) {
    res.writeHead(404).end("Not Found");
    return;
  }

  const blockedBy = busy;
  const started = runJob(mode);
  // Queued still returns 202 so the external cron sees success — the job will run, just after the
  // current one finishes. Only a same-mode request already queued is a true no-op.
  res.writeHead(202).end(started ? "Accepted" : `Queued behind ${blockedBy} job`);
});

server.listen(PORT, () => {
  console.log(`Cron webhook server listening on port ${PORT}`);
});
