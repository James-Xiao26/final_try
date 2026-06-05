"use client";

import { useId, useState } from "react";

// Email-capture form for the early-access landing. Posts to our own /api/waitlist proxy (which
// forwards to Waitlister), then swaps the row for a glowing "on the manifest" confirmation —
// matching the hydrophone-console aesthetic of the rest of the app. Used twice on the page (hero +
// final CTA), so footer copy and alignment are props.
type Status = "idle" | "loading" | "ok" | "error";

interface WaitlistFormProps {
  /** Submit-button label. */
  cta: string;
  /** Small line under the form (hidden on success). Pass null to omit. */
  foot?: React.ReactNode;
  /** Center the row + confirmation (used in the final CTA block). */
  centered?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function WaitlistForm({ cta, foot, centered = false }: WaitlistFormProps) {
  const [email, setEmail] = useState("");
  // Honeypot: bots tend to fill every field; humans never see this one. A non-empty value on submit
  // marks the request as spam (the server silently drops it).
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (status === "loading") return;

    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setStatus("error");
      setError("Enter a valid email address.");
      return;
    }

    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, company })
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Something went wrong. Please try again.");
      }
      setStatus("ok");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  }

  if (status === "ok") {
    return (
      <div className={`ea-wait${centered ? " ea-wait-center" : ""}`}>
        <div className="ea-wait-ok" role="status">
          <span className="ping" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <div>
            <div className="t">You&apos;re on the manifest.</div>
            <div className="s">We&apos;ll transmit your boarding pass when the next wave opens.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form className={`ea-wait${centered ? " ea-wait-center" : ""}`} onSubmit={onSubmit} noValidate>
      {/* Honeypot — off-screen and out of the tab/a11y order, so only bots ever fill it. */}
      <div aria-hidden style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}>
        <label htmlFor={`${inputId}-company`}>Company (leave blank)</label>
        <input
          id={`${inputId}-company`}
          type="text"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
      </div>
      <div className="ea-wait-row">
        <input
          id={inputId}
          className="ea-wait-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@deepwater.io"
          aria-label="Email address"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          required
        />
        <button className="ea-wait-btn" type="submit" disabled={status === "loading"}>
          {status === "loading" ? "Transmitting…" : cta}
          {status !== "loading" && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          )}
        </button>
      </div>
      {status === "error" && error ? (
        <div className="ea-wait-err" role="alert">{error}</div>
      ) : (
        foot != null && <div className="ea-wait-foot">{foot}</div>
      )}
    </form>
  );
}
