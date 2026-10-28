async function request(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('Cannot reach the backend. Check that it is running on port 4000.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `Request failed with HTTP ${response.status}`);
  return body;
}

export function createSearch(query, imageFile) {
  const form = new FormData();
  form.set('query', query);
  if (imageFile) form.set('image', imageFile);
  return request('/api/search', { method: 'POST', body: form });
}

export const getSearch = (id) => request(`/api/search/${encodeURIComponent(id)}`);
export const getHistory = () => request('/api/history');
export const getHealth = () => request('/api/health');
export const progressUrl = (id) => `/api/search/${encodeURIComponent(id)}/events`;

export const RUNNING = new Set(['queued', 'running']);
