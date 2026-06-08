import type { Metadata } from "next";
import LaunchCountdown from "@/components/LaunchCountdown";
import WaitlistForm from "@/components/WaitlistForm";

export const metadata: Metadata = {
  title: "WhaleWatcher — Early Access",
  description:
    "Join the WhaleWatcher waitlist. Rank Polymarket traders by a 0–10 Skill Score — pure forecasting edge, Bayesian-shrunk for sample size."
};

// Marketing landing for early access. Renders inside the shared shell (topnav + ocean scene from
// app/layout.tsx), so it inherits the hydrophone-console atmosphere for free; everything below is
// landing-specific (styles namespaced `ea-` in globals.css).
export default function EarlyAccessPage() {
  return (
    <div className="ea">
      {/* hero */}
      <section className="ea-wrap ea-hero">
        <div>
          <span className="ea-status reveal" style={{ animationDelay: ".05s" }}>
            <span className="dot" /> Private beta · Boarding now
          </span>
          <h1 className="reveal" style={{ animationDelay: ".12s" }}>
            Surface the traders<br />
            who <span className="g">actually</span> <span className="o">see ahead.</span>
          </h1>
          <p className="ea-sub reveal" style={{ animationDelay: ".2s" }}>
            WhaleWatcher ranks Polymarket traders by a single <b>0–10 Skill Score</b> — pure
            forecasting edge, not loud PnL. We measure how reliably a wallet&apos;s entry prices beat
            the market&apos;s eventual resolution, then Bayesian-shrink it for sample size.{" "}
            <b>Early access opens in waves.</b>
          </p>

          <div className="ea-wait-wrap reveal" style={{ animationDelay: ".28s" }}>
            <div className="ea-wait-lbl">Join the waitlist · Get a boarding pass</div>
            <WaitlistForm
              cta="Request access"
              source="hero"
              foot={
                <>
                  <span className="cnt">2,847</span> traders already on the manifest · No spam, one
                  launch email.
                </>
              }
            />
          </div>
        </div>

        {/* sonar scope */}
        <div className="ea-scope-card reveal" style={{ animationDelay: ".34s" }}>
          <div className="ea-scope-head">
            <span className="t">Contact Scope</span>
            <span className="d">SECTOR 7 · LIVE</span>
          </div>
          <div className="ea-scope">
            <svg viewBox="0 0 200 200" aria-hidden>
              <circle cx="100" cy="100" r="96" fill="none" stroke="rgba(54,236,208,0.16)" />
              <circle cx="100" cy="100" r="68" fill="none" stroke="rgba(54,236,208,0.12)" />
              <circle cx="100" cy="100" r="40" fill="none" stroke="rgba(54,236,208,0.1)" />
              <circle cx="100" cy="100" r="12" fill="none" stroke="rgba(54,236,208,0.18)" />
              <line x1="100" y1="4" x2="100" y2="196" stroke="rgba(54,236,208,0.08)" />
              <line x1="4" y1="100" x2="196" y2="100" stroke="rgba(54,236,208,0.08)" />
              <line x1="29" y1="29" x2="171" y2="171" stroke="rgba(54,236,208,0.06)" />
              <line x1="171" y1="29" x2="29" y2="171" stroke="rgba(54,236,208,0.06)" />
            </svg>
            <div className="ea-sweep" />
            <div className="ea-blip apex" style={{ left: "62%", top: "34%" }}>
              <span className="tag">@whale.eth · 9.4</span>
            </div>
            <div className="ea-blip" style={{ left: "38%", top: "58%" }}>
              <span className="tag">8.1</span>
            </div>
            <div className="ea-blip" style={{ left: "70%", top: "66%" }}>
              <span className="tag">7.6</span>
            </div>
            <div className="ea-blip" style={{ left: "48%", top: "30%" }}>
              <span className="tag">7.2</span>
            </div>
            <div className="ea-blip" style={{ left: "30%", top: "42%" }} />
          </div>
          <div className="ea-scope-foot">
            <span>Tracking 2.4k wallets</span>
            <span>Edge &gt; market</span>
          </div>
        </div>
      </section>

      {/* launch countdown */}
      <section className="ea-wrap reveal" style={{ animationDelay: ".38s" }}>
        <LaunchCountdown />
      </section>

      {/* stat strip */}
      <section className="ea-wrap reveal" style={{ animationDelay: ".46s", marginTop: "18px" }}>
        <div className="ea-strip">
          <div className="cell">
            <div className="k">Skill range</div>
            <div className="v">0–10</div>
            <div className="s">Bayesian-shrunk edge</div>
          </div>
          <div className="cell">
            <div className="k">Wallets scanned</div>
            <div className="v">2,412</div>
            <div className="s">Refreshed daily</div>
          </div>
          <div className="cell">
            <div className="k">Bot wallets filtered</div>
            <div className="v alt">38%</div>
            <div className="s">Heuristic-screened</div>
          </div>
          <div className="cell">
            <div className="k">Edge horizon</div>
            <div className="v alt">30 / 90d</div>
            <div className="s">Resolved positions</div>
          </div>
        </div>
      </section>

      {/* features */}
      <div className="ea-wrap">
        <div className="ea-rule">
          <span className="orn">◇</span> What the console gives you <span className="line" />
        </div>
        <section className="ea-feat-grid">
          <article className="ea-feat">
            <div className="icn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            </div>
            <h3>
              Edge, not <span className="g">noise</span>
            </h3>
            <p>
              A wallet can be up millions on one lucky longshot. The Skill Score ignores PnL theater
              and measures forecasting edge per share — how far entry prices beat eventual
              resolution.
            </p>
          </article>
          <article className="ea-feat">
            <div className="icn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 17l5-5 4 3 7-8" />
                <path d="M16 7h4v4" />
              </svg>
            </div>
            <h3>
              Shrunk for <span className="g">sample</span>
            </h3>
            <p>
              Three good calls aren&apos;t a track record. Every score is Bayesian-shrunk toward zero
              until a wallet earns its confidence — so a hot streak can&apos;t out-rank a proven
              forecaster.
            </p>
          </article>
          <article className="ea-feat">
            <div className="icn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <h3>
              Bots <span className="g">screened</span>
            </h3>
            <p>
              Market-makers and arbitrage bots are flagged by trade cadence, simultaneous markets and
              tiny average size — then excluded from the board, so you watch humans with conviction.
            </p>
          </article>
        </section>
      </div>

      {/* final CTA */}
      <section className="ea-wrap" style={{ marginTop: "78px" }}>
        <div className="ea-final">
          <h2>
            Get your <span className="g">boarding pass.</span>
          </h2>
          <p>
            Waves open in batches. Reserve your spot and we&apos;ll transmit access the moment your
            sector clears.
          </p>
          <WaitlistForm
            cta="Join waitlist"
            centered
            source="cta"
            foot={
              <>
                <span className="cnt">2,847</span> already aboard · Built on Polymarket&apos;s public
                data.
              </>
            }
          />
        </div>
      </section>

      {/* footer */}
      <footer className="ea-foot">
        <div className="ea-foot-inner">
          <div className="c">
            <span className="g">WHALE</span>WATCHER · Hydrophone Console · © 2026
          </div>
          <nav className="ea-foot-links">
            <a href="https://polymarket.com" target="_blank" rel="noreferrer">
              Polymarket
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
