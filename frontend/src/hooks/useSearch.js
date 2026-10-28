import { useCallback, useEffect, useRef, useState } from 'react';
import { RUNNING, getSearch, progressUrl } from '../api/client.js';

// Loads one search. While it runs, listens to the SSE progress stream and refetches results
// (throttled) so cards appear as each source collects them.
export function useSearch(id, onFinished) {
  const [data, setData] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const load = useCallback(async () => {
    try {
      const next = await getSearch(id);
      setData(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    let source = null;
    let refreshTimer = null;
    setData(null);
    setProgress(null);

    load().then((initial) => {
      if (cancelled || !initial || !RUNNING.has(initial.search.status)) return;
      setProgress(initial.progress);
      source = new EventSource(progressUrl(id));
      source.onmessage = (event) => {
        const state = JSON.parse(event.data);
        setProgress(state);
        if (!RUNNING.has(state.status)) {
          source.close();
          load().then(() => finishedRef.current?.());
        } else if (!refreshTimer) {
          refreshTimer = setTimeout(() => {
            refreshTimer = null;
            if (!cancelled) load();
          }, 1500);
        }
      };
    });

    return () => {
      cancelled = true;
      source?.close();
      clearTimeout(refreshTimer);
    };
  }, [id, load]);

  return { data, progress: progress ?? data?.progress ?? null, error, reload: load };
}
