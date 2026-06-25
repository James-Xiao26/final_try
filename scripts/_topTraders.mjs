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

const { data: stats, error } = await supabase
  .from("wallet_stats")
  .select("address,n_trades,n_resolved,skill_score,pct_return")
  .eq("horizon_days", 90)
  .order("n_trades", { ascending: false })
  .limit(20);
if (error) {
  console.error(error);
  process.exit(1);
}

const addrs = stats.map((s) => s.address);
const { data: wallets } = await supabase
  .from("wallets")
  .select("address,handle,is_bot_suspected")
  .in("address", addrs);
const wmap = new Map((wallets || []).map((w) => [w.address, w]));

console.log("rank | trades90 | resolved | skill | pctRet  | handle / address");
console.log("-----|----------|----------|-------|---------|------------------");
stats.forEach((s, i) => {
  const w = wmap.get(s.address) || {};
  const handle = w.handle || s.address.slice(0, 12) + "…";
  const skill = s.skill_score == null ? " - " : s.skill_score.toFixed(2);
  const pr = s.pct_return == null ? "-" : s.pct_return.toFixed(1) + "%";
  console.log(
    String(i + 1).padStart(4) +
      " | " + String(s.n_trades).padStart(8) +
      " | " + String(s.n_resolved).padStart(8) +
      " | " + String(skill).padStart(5) +
      " | " + String(pr).padStart(7) +
      " | " + handle
  );
});
