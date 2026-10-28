// Score bar with the threshold marked, so "how close to the cut-off" is visible at a glance.
export default function ScoreMeter({ score, threshold }) {
  if (score === null || score === undefined) return <span className="score-meter unscored">Not scored</span>;
  const band = score >= 75 ? 'high' : score >= threshold ? 'mid' : 'low';
  return (
    <span className={`score-meter score-${band}`} aria-label={`Match score ${score} of 100, threshold ${threshold}`}>
      <span className="score-value">{score}</span>
      <span className="score-track" aria-hidden="true">
        <span className="score-fill" style={{ width: `${score}%` }} />
        <span className="score-threshold" style={{ left: `${threshold}%` }} />
      </span>
    </span>
  );
}
