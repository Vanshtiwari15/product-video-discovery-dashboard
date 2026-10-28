import { useState } from 'react';
import ScoreMeter from './ScoreMeter.jsx';

const PLATFORM_LABEL = { instagram: 'Instagram Reel', meta: 'Meta ad' };

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function VideoCard({ video, threshold }) {
  const [open, setOpen] = useState(false);
  const reasons = video.explanation?.reasons || [];
  const date = formatDate(video.publishedAt);

  return (
    <article className={`video-card ${video.matchStatus !== 'accepted' ? 'dimmed' : ''}`}>
      <a className="thumb" href={video.url || undefined} target="_blank" rel="noreferrer noopener" aria-label={video.url ? 'Open original video' : undefined}>
        {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : <span className="thumb-missing">No thumbnail</span>}
        <span className="badges">
          <span className={`badge badge-${video.platform}`}>{PLATFORM_LABEL[video.platform] || video.platform}</span>
          {video.isDemo && <span className="badge badge-demo">Synthetic</span>}
          {video.previouslySeen && <span className="badge badge-seen">Seen before</span>}
          {video.matchStatus === 'accepted' && video.explanation?.verified === true && <span className="badge badge-verified" title={`Checked by ${video.explanation.vlmLabel || 'the vision model'}`}>Verified</span>}
          {video.matchStatus === 'accepted' && video.explanation?.verified === false && <span className="badge badge-unverified" title="Accepted on image + caption evidence only; no vision-language check">Unverified</span>}
        </span>
      </a>
      <div className="card-body">
        <ScoreMeter score={video.score} threshold={threshold} />
        <p className="reason">{video.explanation?.summary || reasons[0] || 'No explanation available'}</p>
        <p className="caption">{video.caption || <span className="muted">No caption or ad copy</span>}</p>
        <div className="card-meta">
          {video.author && <span>{video.author}</span>}
          {date && <time dateTime={video.publishedAt}>{date}</time>}
        </div>
        {reasons.length > 1 && (
          <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide score details' : 'Why this score'}
          </button>
        )}
        {open && video.explanation?.frameFile && (
          <figure className="matched-frame">
            <img src={`/media/thumbs/${video.explanation.frameFile}`} alt="Video frame that matched best" />
            <figcaption>Best-matching frame</figcaption>
          </figure>
        )}
        {open && (
          <ul className="reasons">
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
            {video.foundBy && <li>Found by {video.foundBy}</li>}
          </ul>
        )}
        <div className="card-links">
          {video.url ? (
            <a href={video.url} target="_blank" rel="noreferrer noopener">{video.platform === 'meta' ? 'Open in Ad Library' : 'Open on Instagram'}</a>
          ) : (
            <span className="muted small">No original link (synthetic record)</span>
          )}
          {video.videoUrl && <a href={video.videoUrl} target="_blank" rel="noreferrer noopener">Video file</a>}
        </div>
      </div>
    </article>
  );
}
