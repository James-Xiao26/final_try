interface SkillScoreBadgeProps {
  score: number | null;
}

export default function SkillScoreBadge({ score }: SkillScoreBadgeProps) {
  const color = score === null
    ? "var(--muted)"
    : score > 500
      ? "var(--green)"
      : score >= 200
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
      {score === null ? "N/A" : score.toFixed(1)}
    </span>
  );
}
