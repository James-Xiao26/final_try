// Phase 0 probe for the forecasting-edge feature. /closed-positions holds positions the trader
// SOLD before resolution, and our ClosedPosition mapping only gets an `outcome` for them if the raw
// payload already carries a settled price. This script dumps a raw record so we can see whether such
// a field exists. If it does, sold positions get edge coverage for free; if not, we need a separate
// conditionId -> resolution lookup. Read-only, public Data API, no env/creds required.
//
// Run from the repo root:  pnpm --filter edgeboard-scripts probe
import { CONFIG } from "./config.js";
import { discoverTopWallets } from "./polymarket.js";

// Fields that would carry a resolved 0/1 (or a resolved flag) on a closed-position record.
const RESOLUTION_KEYS = [
  "curPrice",
  "outcome",
  "payout",
  "resolvedPrice",
  "price",
  "redeemable",
  "resolved",
  "closed",
  "umaResolutionStatus",
  "outcomeIndex"
];

async function main(): Promise<void> {
  const wallets = await discoverTopWallets();
  const sample = wallets.slice(0, 8);
  console.log(`Probing /closed-positions for up to ${sample.length} discovered wallets...\n`);

  for (const wallet of sample) {
    const url = new URL("/closed-positions", CONFIG.POLYMARKET_API_BASE);
    url.searchParams.set("user", wallet.address);
    url.searchParams.set("limit", "5");
    url.searchParams.set("sortBy", "TIMESTAMP");
    url.searchParams.set("sortDirection", "DESC");

    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "edgeboard-probe/1.0" }
    });
    if (!response.ok) {
      console.log(`  ${wallet.address}: HTTP ${response.status}, skipping`);
      continue;
    }

    const data: unknown = await response.json();
    const records = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    if (records.length === 0) {
      continue;
    }

    const first = records[0]!;
    console.log(`Wallet ${wallet.address} — ${records.length} closed position(s) sampled`);
    console.log(`All keys present: ${Object.keys(first).join(", ")}\n`);
    console.log("Resolution-relevant fields:");
    for (const key of RESOLUTION_KEYS) {
      if (key in first) {
        console.log(`  ${key} = ${JSON.stringify(first[key])}`);
      }
    }
    console.log("\nFull first record:");
    console.log(JSON.stringify(first, null, 2));
    console.log("\nVERDICT: if a settled price (curPrice/outcome/payout ~ 0 or 1) or a resolved flag");
    console.log("appears above, sold positions get edge coverage for free. If not, a conditionId ->");
    console.log("resolution lookup (Gamma markets API) is needed to cover them.");
    return;
  }

  console.log("No closed positions found in the sampled wallets — try a larger sample.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
