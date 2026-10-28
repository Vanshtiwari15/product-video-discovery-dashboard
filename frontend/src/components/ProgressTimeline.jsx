import { stagePresentation } from './stageStatus.js';

const STEPS = [
  ['product', 'Product page'],
  ['analysis', 'Image analysis'],
  ['instagram', 'Instagram Reels'],
  ['meta', 'Meta Ad Library'],
  ['scoring', 'Scoring'],
];

export default function ProgressTimeline({ progress, running }) {
  const stages = progress?.stages;
  if (!stages) return running ? <p className="muted loading-line">Queued…</p> : null;

  return (
    <section className="timeline" aria-label="Search progress" aria-live="polite">
      <ol>
        {STEPS.map(([key, label], index) => {
          const stage = stages[key] || { status: 'pending' };
          const stats = stage.stats;
          const presentation = stagePresentation(stage);
          return (
            <li key={key} className={`step step-${presentation.status}`}>
              <span className="step-marker" aria-hidden="true">{presentation.marker || index + 1}</span>
              <span className="step-body">
                <span className="step-label">{label}</span>
                <span className="step-status">{presentation.label}</span>
                <span className="step-message">{stage.message || (stage.status === 'pending' ? 'Waiting' : '')}</span>
                {presentation.counts && <span className="step-counts">{presentation.counts}</span>}
                {stats?.error && <span className="step-error">{stats.error}</span>}
                {stats && !['active', 'pending'].includes(stage.status) && <span className="step-retry">Automatic retry possible: {presentation.retryPossible ? 'yes' : 'no'}</span>}
                {stats && stats.target && (
                  <span className="step-bar" title={`${stats.accepted} of ${stats.target} new matches`}>
                    <span style={{ width: `${Math.min(100, (stats.accepted / stats.target) * 100)}%` }} />
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
