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

export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
