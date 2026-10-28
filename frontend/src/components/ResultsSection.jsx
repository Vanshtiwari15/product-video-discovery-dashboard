import { useMemo, useState } from 'react';
import VideoCard from './VideoCard.jsx';
import Notice from './Notice.jsx';

const SOURCES = [
  ['instagram', 'Instagram Reels'],
  ['meta', 'Meta Ad Library'],
];
const DATE_WINDOWS = { any: null, '30': 30, '90': 90, '365': 365 };

function shortfallText(stats) {
  if (stats.status === 'not_configured' || stats.status === 'failed') return `${stats.accepted} accepted; ${stats.fetched} fetched. ${stats.error} Retry possible: ${stats.retryPossible ? 'yes' : 'no'}.`;
  if (stats.accepted === 0) return `No matching videos found. ${stats.fetched} candidates were collected and checked across ${stats.rounds} rounds.`;
  const parts = [`${stats.rounds} query round${stats.rounds === 1 ? '' : 's'} returned ${stats.fetched} videos`];
  if (stats.duplicates + stats.nearDuplicates) parts.push(`${stats.duplicates + stats.nearDuplicates} duplicates removed`);
  if (stats.previouslySeen) parts.push(`${stats.previouslySeen} already seen in earlier searches`);
  if (stats.lowMatch) parts.push(`${stats.lowMatch} below the match threshold`);
  if (stats.unscored) parts.push(`${stats.unscored} could not be scored`);
  return `${parts.join(', ')}. Try a broader product name, a clearer product photo, or a repeat search (it starts with queries not used last time).`;
}

function toCsv(videos) {
  const header = ['platform', 'score', 'match_status', 'previously_seen', 'url', 'author', 'published_at', 'caption', 'reason'];
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = videos.map((v) => [v.platform, v.score, v.matchStatus, v.previouslySeen, v.url, v.author, v.publishedAt, v.caption, v.explanation?.summary].map(escape).join(','));
  return [header.join(','), ...rows].join('\n');
}

// What the search actually consumed, as reported by Apify and the Anthropic API.
function RunDetails({ summary }) {
  const runs = (summary.instagram?.providerRuns || 0) + (summary.meta?.providerRuns || 0);
  const cost = (summary.instagram?.providerCostUsd || 0) + (summary.meta?.providerCostUsd || 0);
  const { usage } = summary;
  return (
    <dl className="run-details">
      <dt>Scoring</dt>
      <dd>{summary.scoringMethod}</dd>
      <dt>Apify</dt>
      <dd>{runs ? `${runs} runs${cost ? `, ${cost.toFixed(3)} USD reported` : ''}` : 'no runs'}</dd>
      <dt>Vision-language model</dt>
      <dd>{usage.vlmCalls ? `${usage.vlmCalls} calls, ${usage.vlmInputTokens} in / ${usage.vlmOutputTokens} out tokens` : 'not used'}</dd>
      <dt>Frames</dt>
      <dd>{usage.framesSampled} videos sampled{usage.frameFailures ? `, ${usage.frameFailures} failed` : ''}</dd>
      <dt>Time</dt>
      <dd>{Math.round((summary.durationMs || 0) / 1000)} s</dd>
    </dl>
  );
}

export default function ResultsSection({ results, search, running }) {
  const [tab, setTab] = useState('instagram');
  const [sort, setSort] = useState('score');
  const [minScore, setMinScore] = useState(0);
  const [dateWindow, setDateWindow] = useState('any');
  const [showSeen, setShowSeen] = useState(false);
  const [showLow, setShowLow] = useState(false);

  const summary = search.summary || {};
  const threshold = summary.threshold ?? 55;
  const counts = {
    instagram: results.instagram.filter((v) => v.matchStatus === 'accepted' && !v.previouslySeen).length,
    meta: results.meta.filter((v) => v.matchStatus === 'accepted' && !v.previouslySeen).length,
  };
  const target = summary.instagram?.target ?? 20;

  const visible = useMemo(() => {
    const pool = tab === 'all' ? [...results.instagram, ...results.meta] : results[tab];
    const cutoff = DATE_WINDOWS[dateWindow] ? Date.now() - DATE_WINDOWS[dateWindow] * 86_400_000 : null;
    return pool
      .filter((v) => showSeen || !v.previouslySeen)
      .filter((v) => showLow || v.matchStatus === 'accepted')
      .filter((v) => (v.score === null ? minScore === 0 : v.score >= minScore))
      .filter((v) => !cutoff || (v.publishedAt && Date.parse(v.publishedAt) >= cutoff))
      .sort((a, b) => (sort === 'newest' ? (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0) : (b.score ?? -1) - (a.score ?? -1)));
  }, [results, tab, sort, minScore, dateWindow, showSeen, showLow]);

  const hiddenSeen = (tab === 'all' ? [...results.instagram, ...results.meta] : results[tab]).filter((v) => v.previouslySeen).length;

  function exportCsv() {
    const blob = new Blob([toCsv(visible)], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `videos-${search.id.slice(0, 8)}-${tab}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const shortSources = SOURCES.filter(([key]) => summary[key] && summary[key].accepted < summary[key].target);

  return (
    <section className="results">
      <div className="tabs" role="tablist">
        {SOURCES.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>
            {label}
            <span className={counts[key] >= target ? 'tab-count met' : 'tab-count'}>{counts[key]} / {target}</span>
          </button>
        ))}
        <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'tab active' : 'tab'} onClick={() => setTab('all')}>
          All sources
          <span className="tab-count">{counts.instagram + counts.meta}</span>
        </button>
      </div>

      {!running && shortSources.map(([key, label]) => (
        <Notice key={key} tone={summary[key].status === 'failed' || summary[key].status === 'not_configured' ? 'error' : 'warning'} title={`${label}: ${summary[key].accepted} of ${summary[key].target} new matches`}>
          {shortfallText(summary[key])}
          {summary[key].warnings?.length > 0 && <span className="small"> Source messages: {summary[key].warnings.join('; ')}</span>}
        </Notice>
      ))}
      {!running && summary.notes?.map((note) => <Notice key={note} tone="warning">{note}</Notice>)}
      {!running && summary.usage && <RunDetails summary={summary} />}

      <div className="toolbar">
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="score">Best match first</option>
            <option value="newest">Newest first</option>
          </select>
        </label>
        <label>
          Posted
          <select value={dateWindow} onChange={(e) => setDateWindow(e.target.value)}>
            <option value="any">Any time</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
          </select>
        </label>
        <label className="range">
          Min score <output>{minScore}</output>
          <input type="range" min="0" max="100" step="5" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={showSeen} onChange={(e) => setShowSeen(e.target.checked)} />
          Show previously seen ({hiddenSeen})
        </label>
        <label className="check">
          <input type="checkbox" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} />
          Show below threshold
        </label>
        <button type="button" className="button-secondary small-button" onClick={exportCsv} disabled={!visible.length}>Export CSV</button>
      </div>

      {visible.length === 0 ? (
        <div className="empty-results">
          {running ? 'Collecting and scoring videos. Matches appear here as each batch is checked.' : 'No videos match these filters. Lower the minimum score, include previously seen videos, or show results below the threshold.'}
        </div>
      ) : (
        <div className="grid">
          {visible.map((video) => <VideoCard key={video.key} video={video} threshold={threshold} />)}
        </div>
      )}
    </section>
  );
}
