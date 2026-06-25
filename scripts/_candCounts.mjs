import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: "scripts/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("missing env", { url: !!url, key: !!key }); process.exit(1); }
const supabase = createClient(url, key);

// Page through ALL rows (PostgREST caps a single select at 1000) to count by source + never-scored.
const bySource = new Map();
let total = 0, neverScored = 0;
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from("candidate_wallets")
    .select("discovery_source, last_scored_at, status")
    .eq("status", "candidate")
    .range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  for (const r of data) {
    total++;
    if (r.last_scored_at === null) neverScored++;
    bySource.set(r.discovery_source, (bySource.get(r.discovery_source) || 0) + 1);
  }
  if (data.length < 1000) break;
}

console.log(`total 'candidate' rows paged: ${total}`);
console.log(`never-scored: ${neverScored}`);
console.log("\n=== candidate rows by discovery_source ===");
for (const [src, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(7)}  ${src}`);
}
