const STATUS_LABEL = { queued: 'Queued', running: 'Running', complete: 'Targets met', partial: 'Partial', failed: 'Failed', interrupted: 'Interrupted' };

function SourceCount({ label, stats }) {
  if (!stats) return null;
  const met = stats.accepted >= stats.target;
  return (
    <span className={met ? 'count count-met' : 'count'}>
      {label} {stats.accepted}/{stats.target}
    </span>
  );
}

export default function Sidebar({ history, activeId, health }) {
  return (
    <aside className="sidebar">
      <a className="brand" href="#">Product video discovery</a>
      <a className="new-search" href="#">New search</a>

      <h2 className="sidebar-heading">History</h2>
      {history.length === 0 && <p className="muted small">Searches you run appear here.</p>}
      <ul className="history">
        {history.map((item) => (
          <li key={item.id}>
            <a href={`#search/${item.id}`} className={item.id === activeId ? 'history-item active' : 'history-item'}>
              {item.productImageUrl ? <img src={item.productImageUrl} alt="" /> : <span className="thumb-placeholder" aria-hidden="true" />}
              <span className="history-text">
                <span className="history-title">{item.productTitle || item.input}</span>
                <span className="history-meta">
                  <span className={`status status-${item.status}`}>{STATUS_LABEL[item.status] || item.status}</span>
                  <SourceCount label="IG" stats={item.summary?.instagram} />
                  <SourceCount label="Meta" stats={item.summary?.meta} />
                  {item.isDemo && <span className="tag-demo">Demo</span>}
                </span>
                <time className="history-time">{new Date(item.createdAt).toLocaleString()}</time>
              </span>
            </a>
          </li>
        ))}
      </ul>

      {health && !health.unreachable && (
        <div className="setup">
          <h2 className="sidebar-heading">Setup</h2>
          <dl>
            <dt>Instagram</dt>
            <dd className={health.sources.instagram.configured ? '' : 'warn'}>{health.sources.instagram.configured ? health.sources.instagram.provider : 'not configured'}</dd>
            <dt>Meta</dt>
            <dd className={health.sources.meta.configured ? '' : 'warn'}>{health.sources.meta.configured ? health.sources.meta.provider : 'not configured'}</dd>
            <dt>Vision</dt>
            <dd className={health.vision.fallbackReason ? 'warn' : ''}>{health.vision.fallbackReason ? 'basic fallback' : health.vision.backend}</dd>
            <dt>Claude</dt>
            <dd>{health.vision.verification ? 'attributes + verification' : health.vision.claude ? 'attributes only' : 'off'}</dd>
            <dt>Threshold</dt>
            <dd>{health.threshold}</dd>
          </dl>
          {health.vision.fallbackReason && <p className="small warn">{health.vision.fallbackReason}</p>}
        </div>
      )}
    </aside>
  );
}
