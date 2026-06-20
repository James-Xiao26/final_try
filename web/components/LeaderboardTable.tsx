"use client";

import { Copy } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import HorizonToggle from "@/components/HorizonToggle";
import WalletSearch from "@/components/WalletSearch";
import { formatEdge, formatNumber, formatPercent, shortenAddress } from "@/lib/format";
import { HORIZONS } from "@/lib/types";
import type { HorizonDays, LeaderboardRow } from "@/lib/types";

const LEADERBOARD_HORIZONS: readonly HorizonDays[] = HORIZONS;
const POLL_INTERVAL_MS = 60_000;

interface LeaderboardTableProps {
  initialRows: LeaderboardRow[];
  initialHorizon: HorizonDays;
}

// Whale class by signal strength (skill score). Pure presentation — derived, not stored.
function whaleClass(skill: number): string {
  if (skill >= 9) return "Blue Whale";
  if (skill >= 8) return "Sperm Whale";
  if (skill >= 7) return "Orca";
  if (skill >= 6) return "Humpback";
  if (skill >= 5) return "Beluga";
  if (skill >= 4) return "Narwhal";
  return "Porpoise";
}

const GAUGE_DASH = 326.7; // 2πr for r=52

function displayName(row: LeaderboardRow): string {
  return row.handle ? `@${row.handle}` : shortenAddress(row.address);
}

export default function LeaderboardTable({ initialRows, initialHorizon }: LeaderboardTableProps) {
  const [horizon, setHorizon] = useState<HorizonDays>(initialHorizon);
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [locked, setLocked] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (horizon === initialHorizon) {
      setRows(initialRows);
      return;
    }

    let active = true;
    setLoading(true);
    fetch(`/api/leaderboard?horizon=${horizon}`)
      .then((response) => response.ok ? response.json() as Promise<LeaderboardRow[]> : Promise.reject(new Error("Leaderboard request failed")))
      .then((nextRows) => {
        if (active) {
          setRows(nextRows);
        }
      })
      .catch(() => {
        if (active) {
          setRows([]);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [horizon, initialHorizon, initialRows]);

  // Live refresh: re-pull the current horizon on an interval (and when the tab regains focus) so an
  // open tab tracks the scheduled ingest without a manual reload. Mirrors the Activity feed's poll.
  useEffect(() => {
    let active = true;
    const poll = (): void => {
      if (document.hidden) {
        return;
      }
      fetch(`/api/leaderboard?horizon=${horizon}`)
        .then((response) => response.ok ? response.json() as Promise<LeaderboardRow[]> : Promise.reject(new Error("Leaderboard request failed")))
        .then((nextRows) => {
          if (active) {
            setRows(nextRows);
          }
        })
        .catch(() => {
          /* keep last good data */
        });
    };
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);
    poll(); // fetch immediately so empty SSR data hydrates without waiting 60 s
    const onVisibility = (): void => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [horizon]);

  const apex = useMemo(() => rows.find((row) => row.rank === 1) ?? rows[0], [rows]);

  const normalized = query.trim().toLowerCase();
  const matches = (row: LeaderboardRow): boolean =>
    !normalized ||
    row.address.toLowerCase().startsWith(normalized) ||
    (row.handle?.toLowerCase().includes(normalized) ?? false);

  const contactRows = useMemo(
    () => rows.filter((row) => row !== apex && matches(row)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, apex, normalized]
  );

  // Edge fades: hide the top/bottom gradient at the scroll extremes (mirrors the Activity log).
  useEffect(() => {
    const log = logRef.current;
    const shell = shellRef.current;
    if (!log || !shell) return;
    const update = (): void => {
      shell.classList.toggle("at-top", log.scrollTop <= 2);
      shell.classList.toggle("at-bottom", log.scrollTop + log.clientHeight >= log.scrollHeight - 2);
    };
    update();
    log.addEventListener("scroll", update);
    return () => log.removeEventListener("scroll", update);
  }, [contactRows, loading]);

  // Top-3 sonar blips, positioned by signal (stronger = nearer the core), like the console scope.
  const blips = rows.slice(0, 3).map((row, i) => {
    const radius = 8 + (10 - row.skillScore) * 3.6;
    const ang = ((-58 + i * 46) * Math.PI) / 180;
    return {
      row,
      apex: i === 0,
      x: 50 + Math.cos(ang) * radius,
      y: 50 + Math.sin(ang) * radius
    };
  });

  const apexVisible = !normalized || (apex ? matches(apex) : false);

  return (
    <>
      <div className="lb-controls">
        <div className="lb-range">
          <span className="lb-range-lbl">Scan Range</span>
          <HorizonToggle value={horizon} onChange={setHorizon} horizons={LEADERBOARD_HORIZONS} />
        </div>
        <WalletSearch value={query} onChange={setQuery} />
      </div>

      {/* hero: sonar scope + apex dossier */}
      <section className="lb-hero">
        <div className="panel lb-scope-panel">
          <div className="lb-scope-head">
            <span className="t">Sonar Scope</span>
            <span className="d">RANGE · {horizon}D</span>
          </div>
          <div className="lb-scope">
            <svg viewBox="0 0 200 200" aria-hidden>
              <defs>
                <radialGradient id="lbScope" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#0a3346" />
                  <stop offset="100%" stopColor="#04161f" />
                </radialGradient>
              </defs>
              <circle cx="100" cy="100" r="98" fill="url(#lbScope)" stroke="#36ecd0" strokeOpacity="0.25" />
              <circle cx="100" cy="100" r="72" fill="none" stroke="#36ecd0" strokeOpacity="0.14" />
              <circle cx="100" cy="100" r="46" fill="none" stroke="#36ecd0" strokeOpacity="0.14" />
              <circle cx="100" cy="100" r="20" fill="none" stroke="#36ecd0" strokeOpacity="0.14" />
              <line x1="100" y1="2" x2="100" y2="198" stroke="#36ecd0" strokeOpacity="0.1" />
              <line x1="2" y1="100" x2="198" y2="100" stroke="#36ecd0" strokeOpacity="0.1" />
              <line x1="30" y1="30" x2="170" y2="170" stroke="#36ecd0" strokeOpacity="0.06" />
              <line x1="170" y1="30" x2="30" y2="170" stroke="#36ecd0" strokeOpacity="0.06" />
            </svg>
            <div className="lb-sweep" />
            {blips.map((b) => (
              <div
                key={b.row.address}
                className={`lb-blip${b.apex ? " apex" : ""}`}
                style={{ left: `${b.x}%`, top: `${b.y}%` }}
              >
                <span className="tag">{displayName(b.row)}</span>
              </div>
            ))}
          </div>
          <div className="lb-scope-foot">
            <span>Brighter = stronger forecasting edge</span>
            <span>{blips.length} strong returns</span>
          </div>
        </div>

        <div className="panel lb-dossier" style={{ opacity: apexVisible ? 1 : 0.25 }}>
          {apex ? (
            <>
              <span className="lb-ribbon">◆ Apex Contact · Pos 01</span>
              <div className="lb-dossier-top">
                <div className="lb-who">
                  <div className="desig">
                    {apex.handle ? <><span className="at">@</span>{apex.handle}</> : shortenAddress(apex.address)}
                  </div>
                  <div className="id">
                    {shortenAddress(apex.address)}
                    <button type="button" onClick={() => void navigator.clipboard.writeText(apex.address)}>COPY</button>
                  </div>
                  <div className="cls">
                    {whaleClass(apex.skillScore)}
                    {apex.specialty ? <span className="lb-spec" title={`Strongest forecasting edge in ${apex.specialty} markets`}>{apex.specialty}</span> : null}
                    <Link href={`/wallet/${apex.address}?horizon=${horizon}`} className="full">View dossier →</Link>
                  </div>
                </div>
                <div className="lb-gauge">
                  <div className="ring">
                    <svg width="124" height="124" viewBox="0 0 124 124">
                      <circle cx="62" cy="62" r="52" fill="none" stroke="rgba(54,236,208,0.12)" strokeWidth="7" />
                      <circle
                        cx="62" cy="62" r="52" fill="none" stroke="#36ecd0" strokeWidth="7" strokeLinecap="round"
                        strokeDasharray={GAUGE_DASH}
                        strokeDashoffset={mounted ? GAUGE_DASH * (1 - apex.skillScore / 10) : GAUGE_DASH}
                        style={{ filter: "drop-shadow(0 0 6px rgba(54,236,208,0.6))", transition: "stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)", transform: "rotate(-90deg)", transformOrigin: "center" }}
                      />
                    </svg>
                    <div className="center"><div className="num">{apex.skillScore.toFixed(1)}</div><div className="of">/ 10 signal</div></div>
                  </div>
                  <div className="glbl">Skill Score</div>
                </div>
              </div>
              <div className="lb-readouts">
                <div className="ro"><div className="k">Edge / Share</div><div className={`v ${apex.avgEdgePerShare >= 0 ? "pos" : "neg"}`}>{formatEdge(apex.avgEdgePerShare)}</div><div className="s">vs. resolution</div></div>
                <div className="ro"><div className="k">Hit Rate</div><div className="v">{formatPercent(apex.winRate)}</div><div className="s">win rate</div></div>
                <div className="ro"><div className="k">Returns</div><div className="v">{formatNumber(apex.nTrades)}</div><div className="s">resolved trades</div></div>
              </div>
            </>
          ) : null}
        </div>
      </section>

      {/* contact log */}
      <section className="lb-log">
        <div className="lb-log-head">
          <h2>Contact <span className="g">Log</span></h2>
          <span className="log-head-right">
            <span className="meta">
              {normalized ? `${contactRows.length} return${contactRows.length === 1 ? "" : "s"} on scan` : `Returns 02–${String(rows.length).padStart(2, "0")} · sorted by signal strength`}
            </span>
            <span className={`af-scroll-state ${locked ? "locked" : ""}`}>
              <span className="pip" />
              {locked ? "Log scroll · locked" : "Page scroll · hover log to lock"}
            </span>
          </span>
        </div>
        <div className="panel log-shell at-top" ref={shellRef}>
          <div
            className={`lb-log-panel log-scroll ${locked ? "hovered" : ""}`}
            ref={logRef}
            onMouseEnter={() => setLocked(true)}
            onMouseLeave={() => setLocked(false)}
          >
            <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Trader</th>
                <th className="lb-hide-md">Class</th>
                <th className="lb-hide-md lb-signal">Skill Score</th>
                <th>Edge / Share</th>
                <th className="r">Win Rate</th>
                <th className="r">Trades</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 7 }).map((__, c) => (
                      <td key={c}><div className="skeleton" style={{ height: 16, width: c === 1 ? 150 : 64 }} /></td>
                    ))}
                  </tr>
                ))
              ) : contactRows.length === 0 ? (
                <tr><td colSpan={7} className="muted" style={{ padding: 36, textAlign: "center" }}>No contact matches that designation on this scan.</td></tr>
              ) : (
                contactRows.map((row) => {
                  const seg = Math.round(row.skillScore);
                  const apexRow = row.rank === 1;
                  const edgePct = Math.min(100, (Math.abs(row.avgEdgePerShare) / 0.12) * 100);
                  return (
                    <tr key={row.address}>
                      <td className={`lb-cid${apexRow ? " apex" : ""}`}><span className="hex">#{row.rank}</span></td>
                      <td className="lb-desig">
                        <Link href={`/wallet/${row.address}?horizon=${horizon}`} className="name">
                          {row.handle ? <><span className="at">@</span>{row.handle}</> : shortenAddress(row.address)}
                        </Link>
                        {row.specialty ? <span className="lb-spec" title={`Strongest forecasting edge in ${row.specialty} markets`}>{row.specialty}</span> : null}
                        <div className="meta">
                          {shortenAddress(row.address)}
                          <button type="button" aria-label={`Copy ${row.address}`} onClick={() => void navigator.clipboard.writeText(row.address)}>
                            <Copy size={11} />
                          </button>
                        </div>
                      </td>
                      <td className={`lb-class lb-hide-md${apexRow ? " apex" : ""}`}>
                        <span className="chip">{whaleClass(row.skillScore)}</span>
                      </td>
                      <td className="lb-signal lb-hide-md">
                        <div className="sig-wrap">
                          <span className="sig-num">{row.skillScore.toFixed(1)}</span>
                          <span className="bars">
                            {Array.from({ length: 10 }).map((_, k) => (
                              <i key={k} className={k < seg ? "on" : ""} style={{ height: 8 + k * 1.8, transform: mounted ? "scaleY(1)" : "scaleY(0.08)" }} />
                            ))}
                          </span>
                        </div>
                      </td>
                      <td className="lb-edge">
                        <div className={`v ${row.avgEdgePerShare >= 0 ? "pos" : "neg"}`}>{formatEdge(row.avgEdgePerShare)}</div>
                        <div className="track"><i className={row.avgEdgePerShare >= 0 ? "" : "neg"} style={{ width: mounted ? `${edgePct}%` : 0 }} /></div>
                      </td>
                      <td className="lb-win"><div className="v">{formatPercent(row.winRate)}</div></td>
                      <td className="lb-sample"><div className="v">{formatNumber(row.nTrades)}</div><div className="s">resolved</div></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        </div>
      </section>
    </>
  );
}

