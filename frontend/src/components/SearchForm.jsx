import { useEffect, useRef, useState } from 'react';

const ACCEPTED = 'image/jpeg,image/png,image/webp';

export default function SearchForm({ onSubmit, busy }) {
  const [query, setQuery] = useState('');
  const [image, setImage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [localError, setLocalError] = useState(null);
  const fileInput = useRef(null);

  useEffect(() => {
    if (!image) return setPreview(null);
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  function pickImage(file) {
    setLocalError(null);
    if (!file) return;
    if (!ACCEPTED.split(',').includes(file.type)) return setLocalError('Use a JPEG, PNG or WebP image.');
    if (file.size > 6 * 1024 * 1024) return setLocalError('Image must be 6 MB or smaller.');
    setImage(file);
  }

  function submit(event) {
    event.preventDefault();
    if (query.trim().length < 2) return setLocalError('Enter a product name or a product link.');
    onSubmit(query.trim(), image);
  }

  const isUrl = /^https?:\/\//i.test(query.trim());

  return (
    <form className="search-form" onSubmit={submit}>
      <div className="search-row">
        <label className="sr-only" htmlFor="query">Product name or link</label>
        <input
          id="query"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Product name, e.g. indigo block print tablecloth, or a product link"
          autoComplete="off"
        />
        <button type="button" className="button-secondary" onClick={() => fileInput.current?.click()}>
          {image ? 'Change photo' : 'Add photo'}
        </button>
        <button type="submit" className="button-primary" disabled={busy}>
          {busy ? 'Starting…' : 'Search'}
        </button>
        <input ref={fileInput} type="file" accept={ACCEPTED} hidden onChange={(e) => pickImage(e.target.files?.[0])} />
      </div>
      <div className="search-hints">
        <span className="muted">{query.trim() ? (isUrl ? 'Reads the product page for title, description and main image.' : 'Searches by keyword.') : 'Accepts a keyword or a product URL.'}</span>
        {preview && (
          <span className="upload-chip">
            <img src={preview} alt="" />
            {image.name}
            <button type="button" className="link-button" onClick={() => setImage(null)}>Remove</button>
          </span>
        )}
      </div>
      {localError && <p className="field-error">{localError}</p>}
    </form>
  );
}
