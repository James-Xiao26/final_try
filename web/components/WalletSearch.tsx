"use client";

import { Search } from "lucide-react";

interface WalletSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export default function WalletSearch({ value, onChange }: WalletSearchProps) {
  return (
    <label style={{ position: "relative", minWidth: 260, flex: "0 1 340px" }}>
      <Search size={16} style={{ position: "absolute", left: 10, top: 12, color: "var(--muted)" }} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter address prefix"
        className="mono"
        style={{
          width: "100%",
          border: "1px solid var(--line)",
          background: "#0D0F14",
          color: "var(--text)",
          padding: "10px 10px 10px 34px",
          outline: "none"
        }}
      />
    </label>
  );
}
