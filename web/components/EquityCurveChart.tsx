"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import HorizonToggle from "@/components/HorizonToggle";
import { formatUsd } from "@/lib/format";
import type { EquityPoint, HorizonDays } from "@/lib/types";

interface EquityCurveChartProps {
  equityCurves: Record<HorizonDays, EquityPoint[]>;
}

export default function EquityCurveChart({ equityCurves }: EquityCurveChartProps) {
  const [horizon, setHorizon] = useState<HorizonDays>(90);
  const data = equityCurves[horizon];
  const endingPnl = data[data.length - 1]?.cumulativePnl ?? 0;
  const stroke = endingPnl >= 0 ? "var(--green)" : "var(--red)";
  const gradientId = useMemo(() => `equityFill${horizon}`, [horizon]);

  return (
    <section className="panel" style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <div className="mono muted">TOTAL P/L</div>
          <div className={endingPnl >= 0 ? "mono positive" : "mono negative"} style={{ fontSize: 24, marginTop: 4 }}>
            {formatUsd(endingPnl)}
          </div>
        </div>
        <HorizonToggle value={horizon} onChange={setHorizon} />
      </div>

      <div style={{ height: 360, minWidth: 0 }}>
        {data.length === 0 ? (
          <div className="skeleton" style={{ height: "100%" }} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 12, right: 18, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={stroke} stopOpacity={0.32} />
                  <stop offset="95%" stopColor={stroke} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="ts" tick={{ fill: "#8D95A3", fontSize: 12 }} stroke="#262A33" />
              <YAxis tick={{ fill: "#8D95A3", fontSize: 12 }} stroke="#262A33" tickFormatter={formatUsd} width={78} />
              <Tooltip
                contentStyle={{ background: "#101217", border: "1px solid #262A33", color: "#F2F5F7" }}
                formatter={(value) => [formatUsd(Number(value)), "Total P/L"]}
                labelStyle={{ color: "#8D95A3" }}
              />
              <Area
                type="monotone"
                dataKey="cumulativePnl"
                stroke={stroke}
                fill={`url(#${gradientId})`}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
