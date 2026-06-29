export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatPercent(value: number, signed = false): string {
  const percent = value * 100;
  const prefix = signed && percent > 0 ? "+" : "";
  return `${prefix}${percent.toFixed(1)}%`;
}

// Signed percent, compact for large magnitudes (e.g. "+50%", "+1.2K%", "-20%"). Used by the wallet
// equity curve, where a copy-trade return can run from -100% to billions of percent.
export function formatCompactPercent(value: number): string {
  const abs = Math.abs(value);
  const core = abs >= 1000
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
    : value.toFixed(abs < 10 ? 1 : 0);
  return `${value > 0 ? "+" : ""}${core}%`;
}

// Per-position mean forecasting edge, shown in cents per share (e.g. "+4.2¢"). The value is in
// dollars/share, so ×100 gives cents.
export function formatEdge(value: number): string {
  const cents = value * 100;
  const prefix = cents > 0 ? "+" : "";
  return `${prefix}${cents.toFixed(1)}¢`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

// Compact USD for large figures like market liquidity/volume, e.g. "$1.2M", "$840K".
export function formatCompactUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

// A trade's per-share entry price is an implied probability in [0,1] dollars; show it in cents
// (Polymarket's convention), e.g. 0.42 -> "42¢".
export function formatPrice(value: number): string {
  return `${(value * 100).toFixed(1)}¢`;
}

export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Display label for a Polymarket PnL-board chip code ("pnl-all"/"pnl-month"/"pnl-week"). Unknown codes
// return null so the UI can skip them (forward-compatible if new board codes are added ingest-side).
const PNL_BOARD_LABELS: Record<string, string> = {
  "pnl-all": "All-Time PnL",
  "pnl-month": "Monthly PnL",
  "pnl-week": "Weekly PnL"
};
export function pnlBoardLabel(code: string): string | null {
  return PNL_BOARD_LABELS[code] ?? null;
}
