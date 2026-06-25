import { Lock } from "lucide-react";
import SignInButton from "./SignInButton";

// The "sign in to unlock" card shown in place of a gated panel for logged-out visitors.
export default function LockedPanel({
  title,
  accent,
  blurb,
  next = "/"
}: {
  title: string;
  accent: string;
  blurb: string;
  next?: string;
}) {
  return (
    <section className="cv-section">
      <div className="cv-head">
        <h2>
          {title} <span className="g">{accent}</span>
        </h2>
      </div>
      <div className="panel locked-panel">
        <span className="locked-icon">
          <Lock size={20} />
        </span>
        <p className="locked-blurb">{blurb}</p>
        <SignInButton next={next} />
      </div>
    </section>
  );
}
