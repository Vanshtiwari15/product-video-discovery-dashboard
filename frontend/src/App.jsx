import { useCallback, useEffect, useState } from 'react';
import { createSearch, getHealth, getHistory } from './api/client.js';
import { useSearch } from './hooks/useSearch.js';
import Sidebar from './components/Sidebar.jsx';
import SearchForm from './components/SearchForm.jsx';
import ProgressTimeline from './components/ProgressTimeline.jsx';
import ProductPanel from './components/ProductPanel.jsx';
import ResultsSection from './components/ResultsSection.jsx';
import Notice from './components/Notice.jsx';

const idFromHash = () => (window.location.hash.match(/^#search\/(.+)$/) || [])[1] || null;

export default function App() {
  const [searchId, setSearchId] = useState(idFromHash);
  const [history, setHistory] = useState([]);
  const [health, setHealth] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const refreshHistory = useCallback(() => getHistory().then((h) => setHistory(h.searches)).catch(() => {}), []);
  const { data, progress, error } = useSearch(searchId, refreshHistory);

  useEffect(() => {
    refreshHistory();
    getHealth().then(setHealth).catch(() => setHealth({ unreachable: true }));
    const onHash = () => setSearchId(idFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [refreshHistory]);

  async function handleSearch(query, imageFile) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { id } = await createSearch(query, imageFile);
      window.location.hash = `search/${id}`;
      refreshHistory();
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const search = data?.search;
  const running = search && ['queued', 'running'].includes(search.status);

  return (
    <div className="shell">
      <Sidebar history={history} activeId={searchId} health={health} />
      <main className="workspace">
        <SearchForm onSubmit={handleSearch} busy={submitting} />
        {submitError && <Notice tone="error" title="Search not started">{submitError}</Notice>}
        {health?.unreachable && <Notice tone="error" title="Backend unreachable">Start it with npm run dev in backend/.</Notice>}

        {!searchId && <EmptyWorkspace health={health} />}
        {searchId && error && !data && <Notice tone="error" title="Could not load this search">{error}</Notice>}
        {searchId && !data && !error && <p className="muted loading-line">Loading search…</p>}

        {search && (
          <>
            {search.isDemo && (
              <Notice tone="demo" title="Demo data">
                This search ran in DEMO_MODE. Every video below is a synthetic record generated locally, not a real Instagram Reel or Meta ad.
              </Notice>
            )}
            {(running || progress?.stages) && <ProgressTimeline progress={progress} running={running} />}
            {search.status === 'failed' && <Notice tone="error" title="Search failed">{search.error}</Notice>}
            {search.status === 'interrupted' && <Notice tone="warning" title="Search interrupted">{search.error} Run it again from the search bar.</Notice>}
            {data.product && <ProductPanel product={data.product} search={search} />}
            {data.product && <ResultsSection results={data.results} search={search} running={running} />}
          </>
        )}
      </main>
    </div>
  );
}

function EmptyWorkspace({ health }) {
  return (
    <section className="empty-workspace">
      <h1>Find short videos that show a specific product</h1>
      <p>
        Paste a product link (Shopify, Amazon or a brand site) or type a product name. Add a product photo for exact-match scoring.
        Each search collects Instagram Reels and Meta Ad Library video ads, checks every thumbnail against the product image and skips
        videos you have already seen.
      </p>
      {health && !health.unreachable && !health.demoMode && (!health.sources?.instagram?.configured || !health.sources?.meta?.configured) && (
        <Notice tone="warning" title="Video sources are not configured">
          Add APIFY_TOKEN to backend/.env to collect real videos, or set DEMO_MODE=true to try the pipeline with synthetic data.
        </Notice>
      )}
    </section>
  );
}
