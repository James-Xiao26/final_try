"use client";

import { Fragment, useState } from "react";
import { formatPrice, formatUsd, formatNumber } from "@/lib/format";
import type { WalletFill, WalletPosition, WalletTradeGroup } from "@/lib/types";

interface WalletActivityProps {
  positions: WalletPosition[];
  tradeGroups: WalletTradeGroup[];
}

// Polymarket binary markets index 0/1 as Yes/No; multi-outcome markets carry no label here, so fall
// back to the raw index.
function outcomeLabel(index: number | null): string {
  if (index === 0) return "Yes";
  if (index === 1) return "No";
  if (index === null) return "—";
  return `#${index}`;
}

function sideClass(side: string | null): string {
  const upper = (side ?? "").toUpperCase();
  return upper === "BUY" ? "buy" : upper === "SELL" ? "sell" : "";
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function FillRows({ fills }: { fills: WalletFill[] }) {
  return (
    <table className="wa-fills">
      <thead>
        <tr>
          <th>Side</th>
          <th className="r">Price</th>
          <th className="r">Size</th>
          <th className="r">Value</th>
          <th className="r">Date</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((fill, index) => (
          <tr key={`${fill.transactionHash ?? "fill"}-${index}`}>
            <td><span className={`wa-side ${sideClass(fill.side)}`}>{fill.side ?? "—"}</span></td>
            <td className="r">{fill.price === null ? "—" : formatPrice(fill.price)}</td>
            <td className="r">{fill.size === null ? "—" : formatNumber(fill.size)}</td>
            <td className="r">{fill.usdcSize === null ? "—" : formatUsd(fill.usdcSize)}</td>
            <td className="r" title={fill.tradedAt}>{formatDate(fill.tradedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function WalletActivity({ positions, tradeGroups }: WalletActivityProps) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});

  const toggle = (key: string): void => {
    setOpenKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <>
      <section className="panel wa-section">
        <div className="wa-head">
          <h2>Current <span className="g">Positions</span></h2>
          <span className="meta">open holdings · marked to market</span>
        </div>
        {positions.length === 0 ? (
          <p className="muted" style={{ padding: 24, margin: 0 }}>No open positions on record.</p>
        ) : (
          <table className="wa-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Outcome</th>
                <th className="r">Size</th>
                <th className="r">Avg Entry</th>
                <th className="r">Current</th>
                <th className="r">Value</th>
                <th className="r">Unrealized P/L</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position, index) => {
                const unrealized = position.currentValue - position.initialValue;
                return (
                  <tr key={`${position.asset}-${index}`}>
                    <td className="wa-market"><span title={position.market ?? ""}>{position.market || "—"}</span></td>
                    <td>{outcomeLabel(position.outcomeIndex)}</td>
                    <td className="r">{formatNumber(position.size)}</td>
                    <td className="r">{formatPrice(position.avgPrice)}</td>
                    <td className="r">{formatPrice(position.curPrice)}</td>
                    <td className="r">{formatUsd(position.currentValue)}</td>
                    <td className={`r ${unrealized >= 0 ? "pos" : "neg"}`}>{unrealized >= 0 ? "+" : ""}{formatUsd(unrealized)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel wa-section">
        <div className="wa-head">
          <h2>Trade <span className="g">History</span></h2>
          <span className="meta">grouped by position · click to expand fills</span>
        </div>
        {tradeGroups.length === 0 ? (
          <p className="muted" style={{ padding: 24, margin: 0 }}>No recent trades on record.</p>
        ) : (
          <table className="wa-table">
            <thead>
              <tr>
                <th />
                <th>Market</th>
                <th>Outcome</th>
                <th className="r">Avg Entry</th>
                <th className="r">Avg Exit</th>
                <th className="r">Bought</th>
                <th className="r">Sold</th>
                <th className="r">Last</th>
              </tr>
            </thead>
            <tbody>
              {tradeGroups.map((group, index) => {
                const key = `${group.conditionId}:${group.outcomeIndex}:${index}`;
                const isOpen = Boolean(openKeys[key]);
                return (
                  <Fragment key={key}>
                    <tr className="wa-grouprow" onClick={() => toggle(key)} style={{ cursor: "pointer" }}>
                      <td className="wa-caret">{isOpen ? "▾" : "▸"}</td>
                      <td className="wa-market"><span title={group.market ?? ""}>{group.market || "—"}</span></td>
                      <td>{outcomeLabel(group.outcomeIndex)}</td>
                      <td className="r">{group.avgEntryPrice === null ? "—" : formatPrice(group.avgEntryPrice)}</td>
                      <td className="r">{group.avgExitPrice === null ? "—" : formatPrice(group.avgExitPrice)}</td>
                      <td className="r">{formatNumber(group.totalBoughtSize)}</td>
                      <td className="r">{formatNumber(group.totalSoldSize)}</td>
                      <td className="r" title={group.latestTradedAt}>{formatDate(group.latestTradedAt)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="wa-fillsrow">
                        <td colSpan={8}><FillRows fills={group.fills} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
