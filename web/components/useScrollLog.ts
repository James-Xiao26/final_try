"use client";

import { useEffect, useRef, useState } from "react";

// Shared "hover-to-lock" scroll behavior for the in-panel data tables (Acoustic Log, Closed Trades,
// Convergence participants, …): the inner log scrolls while the cursor is inside it — CSS
// `overscroll-behavior: contain` keeps the wheel from chaining into the page — and the page scrolls
// when the cursor is outside. `locked` drives the hover glow; the effect toggles the shell's
// at-top/at-bottom edge-fade classes. Pass whatever changes when the rows change (e.g. the rows
// array) as `rowsDep` so the fades re-evaluate after data loads.
export function useScrollLog(rowsDep: unknown) {
  const [locked, setLocked] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

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
  }, [rowsDep]);

  return {
    locked,
    shellRef,
    logRef,
    // Spread onto the scroll container to wire the hover lock.
    hoverProps: {
      onMouseEnter: (): void => setLocked(true),
      onMouseLeave: (): void => setLocked(false)
    }
  };
}
