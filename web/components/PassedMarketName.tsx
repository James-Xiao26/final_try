"use client";

import { useSearchParams } from "next/navigation";

// Shows the market name the linking page passed in (?m=...) — e.g. the acoustic-log feed knows the
// name but not the slug. Read on the client so the market page itself stays statically ISR-cached
// (reading searchParams in the server component would force per-request dynamic rendering).
export default function PassedMarketName() {
  const name = useSearchParams().get("m")?.trim();
  if (!name) return null;
  return <p className="ma-title" style={{ marginTop: 6 }}>{name}</p>;
}
