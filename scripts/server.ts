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
const running: Record<string, boolean> = { feed: false, markets: false };

function runJob(mode: "feed" | "markets"): boolean {
  if (running[mode]) return false;
  running[mode] = true;
  const flag = mode === "feed" ? "--feed-only" : "--markets-only";
  const child = spawn("pnpm", [`ingest:${mode}`], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  child.on("close", (code) => {
    running[mode] = false;
    console.log(`[${mode}] finished (exit ${code ?? "?"})`);
  });
  child.on("error", (err) => {
    running[mode] = false;
    console.error(`[${mode}] spawn error:`, err);
  });
  return true;
}

const ROUTES: Record<string, "feed" | "markets"> = {
  "/refresh/feed": "feed",
  "/refresh/markets": "markets",
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

  const started = runJob(mode);
  res.writeHead(started ? 202 : 409).end(started ? "Accepted" : "Already running");
});

server.listen(PORT, () => {
  console.log(`Cron webhook server listening on port ${PORT}`);
});
