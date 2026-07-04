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

type JobMode = "feed" | "markets" | "rescore" | "forward:record" | "forward:score";

// mode -> the root package.json script it runs. Most are ingest:<mode>; the forward-alpha jobs are
// their own scripts, so the mapping is explicit rather than a string-concatenated "ingest:" prefix.
const COMMAND: Record<JobMode, string> = {
  feed: "ingest:feed",
  markets: "ingest:markets",
  rescore: "ingest:rescore",
  "forward:record": "forward:record",
  "forward:score": "forward:score",
};

// Single global guard: only ONE job runs at a time, regardless of mode. The jobs share this dyno's
// 512MB, so letting feed + markets + rescore run concurrently (as a per-mode guard would) stacks
// their memory and triggers R14. A request that arrives while any job runs gets 409 and is skipped;
// the external cron will retry on its next tick.
let busy: JobMode | null = null;

function runJob(mode: JobMode): boolean {
  if (busy) return false;
  busy = mode;
  const child = spawn("pnpm", [COMMAND[mode]], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, WALLET_CONCURRENCY: PARTIAL_WALLET_CONCURRENCY },
  });
  child.on("close", (code) => {
    busy = null;
    console.log(`[${mode}] finished (exit ${code ?? "?"})`);
  });
  child.on("error", (err) => {
    busy = null;
    console.error(`[${mode}] spawn error:`, err);
  });
  return true;
}

const ROUTES: Record<string, JobMode> = {
  "/refresh/feed": "feed",
  "/refresh/markets": "markets",
  "/refresh/rescore": "rescore",
  "/refresh/forward-record": "forward:record",
  "/refresh/forward-score": "forward:score",
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
  res.writeHead(started ? 202 : 409).end(started ? "Accepted" : `Busy: ${blockedBy} job running`);
});

server.listen(PORT, () => {
  console.log(`Cron webhook server listening on port ${PORT}`);
});
