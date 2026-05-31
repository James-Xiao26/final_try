interface SkillScoreBadgeProps {
  score: number | null;
}

export default function SkillScoreBadge({ score }: SkillScoreBadgeProps) {
  // Score is the 0–10 statistical-edge score (see scripts/metrics.ts computeSkillScore).
  const color = score === null
    ? "var(--muted)"
    : score >= 7
      ? "var(--green)"
      : score >= 4
        ? "var(--yellow)"
        : "var(--red)";

  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        minWidth: 72,
        justifyContent: "center",
        border: `1px solid ${color}`,
        color,
        padding: "5px 8px",
        fontWeight: 700
      }}
    >
      {score === null ? "N/A" : score.toFixed(2)}
    </span>
  );
}
