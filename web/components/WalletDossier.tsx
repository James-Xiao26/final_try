"use client";

import { useEffect, useState } from "react";
import { formatCompactUsd, shortenAddress } from "@/lib/format";

interface WalletDossierProps {
  address: string;
  handle: string | null;
  bio: string | null;
  isBotSuspected: boolean;
  badges: { label: string; horizonDays: number }[];
  skill: number | null;     // 90-day skill score (signal)
  volume: number | null;    // 90-day total volume (≈ mass)
}

const GAUGE_DASH = 326.7; // 2πr for r=52

function whaleClass(skill: number | null): string {
  if (skill === null) return "Unclassed";
  if (skill >= 9) return "Blue Whale";
  if (skill >= 8) return "Sperm Whale";
  if (skill >= 7) return "Orca";
  if (skill >= 6) return "Humpback";
  if (skill >= 5) return "Beluga";
  if (skill >= 4) return "Narwhal";
  return "Porpoise";
}

export default function WalletDossier({ address, handle, bio, isBotSuspected, badges, skill, volume }: WalletDossierProps) {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const offset = skill === null ? GAUGE_DASH : GAUGE_DASH * (1 - skill / 10);

  return (
    <section className="panel wl-dossier">
      <div className="left">
        <span className="ribbon">◆ Contact Dossier</span>
        <div className="desig">{handle ? <><span className="at">@</span>{handle}</> : shortenAddress(address)}</div>
        <div className="addr">
          {address}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1100);
            }}
          >
            {copied ? "COPIED" : "COPY"}
          </button>
        </div>
        {bio ? <div className="bio">“{bio}”</div> : null}
        <div className="tags">
          {badges.map((b) => (
            <span key={`${b.label}-${b.horizonDays}`} className="tag">{b.label}</span>
          ))}
          {isBotSuspected ? <span className="tag warn">Automaton Suspected</span> : null}
        </div>
      </div>
      <div className="right">
        <div className="gauge">
          <svg width="150" height="150" viewBox="0 0 150 150">
            <circle cx="75" cy="75" r="52" fill="none" stroke="rgba(54,236,208,0.12)" strokeWidth="8" />
            <circle
              cx="75" cy="75" r="52" fill="none" stroke="#36ecd0" strokeWidth="8" strokeLinecap="round"
              strokeDasharray={GAUGE_DASH}
              strokeDashoffset={mounted ? offset : GAUGE_DASH}
              style={{ filter: "drop-shadow(0 0 6px rgba(54,236,208,0.6))", transition: "stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)", transform: "rotate(-90deg)", transformOrigin: "center" }}
            />
          </svg>
          <div className="center"><div className="num">{skill === null ? "—" : skill.toFixed(1)}</div><div className="of">/ 10 · 90D</div></div>
        </div>
        <div className="class">{whaleClass(skill)}</div>
        <div className="clsub">{volume === null ? "Class" : `Class · est. size ${formatCompactUsd(volume)}`}</div>
      </div>
    </section>
  );
}

