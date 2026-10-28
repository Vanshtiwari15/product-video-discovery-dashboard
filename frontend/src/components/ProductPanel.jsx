function AttributeRow({ label, value }) {
  const text = Array.isArray(value) ? value.join(', ') : value;
  return (
    <>
      <dt>{label}</dt>
      <dd className={text ? '' : 'muted'}>{text || 'Not reported'}</dd>
    </>
  );
}

export default function ProductPanel({ product }) {
  const attributes = product.attributes || {};
  const plan = { queries: [], hashtags: [], accounts: [], ...(product.searchPlan || {}) };
  const SCOPE_TEXT = {
    exact: 'Exact product (colour/size variants count)',
    brand: 'Any product of this type from this brand',
    category: 'Any product of this type',
  };

  return (
    <section className="product-panel">
      <div className="product-image">
        {product.imageUrl ? <img src={product.imageUrl} alt={product.title || 'Product'} /> : <div className="no-image">No product photo. Scores use text matching only.</div>}
      </div>
      <div className="product-body">
        <h1>{product.title || 'Untitled product'}</h1>
        {product.sourceUrl && (
          <a className="source-link" href={product.sourceUrl} target="_blank" rel="noreferrer noopener">
            {new URL(product.sourceUrl).hostname}
          </a>
        )}
        {product.description && <p className="product-description">{product.description}</p>}

        <div className="product-columns">
          <dl className="attributes">
            <AttributeRow label="Product type" value={attributes.productType} />
            <AttributeRow label="Colours" value={attributes.colors} />
            <AttributeRow label="Print or graphic" value={attributes.printOrGraphic} />
            <AttributeRow label="Logos" value={attributes.logos} />
            <AttributeRow label="Text on product" value={attributes.textOnProduct} />
            <AttributeRow label="Material" value={attributes.material} />
            <AttributeRow label="Shape" value={attributes.shape} />
            {attributes.brand && <AttributeRow label="Brand" value={attributes.brand} />}
            {attributes.distinctiveFeatures?.length > 0 && <AttributeRow label="Distinctive" value={attributes.distinctiveFeatures} />}
          </dl>
          <div className="plan">
            <h2>Search plan</h2>
            <p className="small muted">Analysis: {product.analysisMethod}. Extraction: {attributes.extraction}.</p>
            {plan.scope && <p className="small"><strong>Counts as relevant:</strong> {SCOPE_TEXT[plan.scope] || plan.scope}{plan.brand ? ` · brand ${plan.brand}` : ''}{plan.model ? ` · model ${plan.model}` : ''}</p>}
            <div className="chips">
              {plan.queries.map((q) => <span key={q} className="chip">{q}</span>)}
            </div>
            <div className="chips">
              {plan.hashtags.map((h) => <span key={h} className="chip chip-tag">#{h}</span>)}
            </div>
            {plan.accounts.length > 0 && (
              <div className="chips">
                {plan.accounts.map((a) => <span key={a} className="chip chip-tag">@{a} reels</span>)}
              </div>
            )}
          </div>
        </div>

        {attributes.warnings?.length > 0 && (
          <ul className="warnings">
            {attributes.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
