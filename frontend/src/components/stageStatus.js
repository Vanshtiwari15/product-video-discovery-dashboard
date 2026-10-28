const LABELS = {
  completed: 'Completed',
  partial: 'Completed with partial results',
  no_matches: 'No matches found',
  failed: 'Failed',
  skipped: 'Skipped',
  active: 'In progress',
  pending: 'Waiting',
  done: 'Completed',
  warning: 'Completed with partial results',
};

const MARKERS = {
  completed: '\u2713',
  partial: '~',
  no_matches: '0',
  failed: '!',
  skipped: '-',
  active: '\u2022',
  pending: '',
};

export function stagePresentation(stage = {}) {
  const status = stage.status === 'done' ? 'completed' : stage.status === 'warning' ? 'partial' : stage.status || 'pending';
  const stats = stage.stats;
  const counts = stats && (stats.target !== undefined || stats.fetched !== undefined)
    ? `${stats.accepted ?? 0} accepted / ${stats.target ?? 0} target; ${stats.fetched ?? 0} fetched`
    : null;
  return {
    status,
    label: LABELS[status] || status,
    marker: MARKERS[status] ?? '',
    counts,
    retryPossible: Boolean(stats?.retryPossible),
  };
}