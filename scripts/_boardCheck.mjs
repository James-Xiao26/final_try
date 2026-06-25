import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: "scripts/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing env", { url: !!url, key: !!key });
  process.exit(1);
}
const supabase = createClient(url, key);

// 1) What's actually on the live leaderboard (what the site shows), top 15 by rank.
const { data: board, error: bErr } = await supabase
  .from("leaderboard_cache")
  .select("rank,address,skill_score,n_trades,horizon_days")
  .eq("horizon_days", 90)
  .order("rank", { ascending: true })
  .limit(15);
if (bErr) { console.error(bErr); process.exit(1); }

const { data: boardWallets } = await supabase
  .from("wallets")
  .select("address,handle")
  .in("address", board.map((r) => r.address));
const bwmap = new Map((boardWallets || []).map((w) => [w.address, w.handle]));

console.log("=== LIVE LEADERBOARD (90d), top 15 ===");
console.log("rank | skill | trades90 | handle");
console.log("-----|-------|----------|-------");
for (const r of board) {
  console.log(
    String(r.rank).padStart(4) +
    " | " + String(r.skill_score?.toFixed(2) ?? "-").padStart(5) +
    " | " + String(r.n_trades ?? "-").padStart(8) +
    " | " + (bwmap.get(r.address) || r.address.slice(0, 12) + "…")
  );
}

// 2) The biggest churners: are they now flagged as bots?
const { data: stats } = await supabase
  .from("wallet_stats")
  .select("address,n_trades,skill_score")
  .eq("horizon_days", 90)
  .order("n_trades", { ascending: false })
  .limit(20);
const addrs = stats.map((s) => s.address);
const { data: wallets } = await supabase
  .from("wallets")
  .select("address,handle,is_bot_suspected")
  .in("address", addrs);
const wmap = new Map((wallets || []).map((w) => [w.address, w]));

console.log("\n=== TOP 20 CHURNERS — bot-flagged now? ===");
console.log("trades90 | skill | bot? | handle");
console.log("---------|-------|------|-------");
for (const s of stats) {
  const w = wmap.get(s.address) || {};
  console.log(
    String(s.n_trades).padStart(8) +
    " | " + String(s.skill_score?.toFixed(2) ?? "-").padStart(5) +
    " | " + (w.is_bot_suspected ? "BOT " : " no ") +
    " | " + (w.handle || s.address.slice(0, 12) + "…")
  );
}
