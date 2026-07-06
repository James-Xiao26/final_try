"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-fetches the server component on an interval. Rendered only while the market is still loading (its
// data wasn't cached yet, so the first render timed out); once the data arrives the parent stops
// rendering this and the interval is torn down. Capped so a genuinely missing market can't loop forever.
// ponytail: router.refresh() re-runs the RSC without a full page reload.
export default function AutoRefresh({ intervalMs = 3000, maxAttempts = 6 }: { intervalMs?: number; maxAttempts?: number }) {
  const router = useRouter();
  useEffect(() => {
    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      router.refresh();
      if (attempts >= maxAttempts) clearInterval(id);
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs, maxAttempts]);
  return null;
}
