export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatPercent(value: number, signed = false): string {
  const percent = value * 100;
  const prefix = signed && percent > 0 ? "+" : "";
  return `${prefix}${percent.toFixed(1)}%`;
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

// Compact relative time for the activity feed, e.g. "now", "3m", "5h", "2d". Input is an ISO string.
// nowMs is injectable for testing.
export function formatTimeAgo(iso: string, nowMs: number = Date.now()): string {
  const diffMs = nowMs - Date.parse(iso);
  if (!Number.isFinite(diffMs) || diffMs < 60_000) {
    return "now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
