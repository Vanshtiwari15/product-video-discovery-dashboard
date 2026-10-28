import sharp from 'sharp';
import { cosine } from './imageUtils.js';
import { buildSearchPlan } from './plan.js';
import { createVlm } from './vlm.js';

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const pct = (value) => Math.round(value * 100);
const round3 = (value) => Math.round(value * 1000) / 1000;

export const mapCosine = (cos, [low, high]) => clamp01((cos - low) / (high - low));

// Verdicts the verifier can return, and which of them count as a relevant match for each scope.
export const VERDICTS = ['exact', 'variant', 'same_brand', 'same_category', 'different', 'unclear'];
export const ACCEPTED_VERDICTS = {
  exact: new Set(['exact', 'variant']),
  brand: new Set(['exact', 'variant', 'same_brand']),
  category: new Set(['exact', 'variant', 'same_brand', 'same_category']),
};
const VERDICT_ALIASES = { close: 'variant', 'close variant': 'variant', 'same category': 'same_category', 'same brand': 'same_brand', match: 'exact' };

// Local relevance (0..1) from three free signals. Weights were checked on 316 hand-labelled real Instagram/Meta
// candidates (cross-validated precision@20 0.90 for the exact product; see README "Relevance").
// For a generic (category) search the reference photo is only one example of the category, so similarity to it
// matters less than "is this a <product type>" (CLIP text match) and the caption naming the product type.
export function combineLocal({ image, text, evidence, scope = 'exact' }) {
  if (scope === 'category' && image !== null && text !== null) return 0.2 * image + 0.35 * text + 0.45 * evidence;
  if (image !== null && text !== null) return 0.45 * image + 0.2 * text + 0.35 * evidence;
  if (image !== null) return 0.6 * image + 0.4 * evidence;
  if (text !== null) return 0.45 * text + 0.55 * evidence;
  return 0.75 * evidence;
}

// Verified matches are scored mostly on the verifier's verdict; the local score breaks ties.
export function vlmComponent(vlm, scope) {
  const accepted = ACCEPTED_VERDICTS[scope] || ACCEPTED_VERDICTS.exact;
  return accepted.has(vlm.verdict) ? 55 + 0.45 * vlm.confidence : Math.min(40, 0.4 * vlm.confidence);
}

export function finalScore(local, vlm, scope = 'exact') {
  if (local === null || local === undefined) return vlm ? Math.round(vlmComponent(vlm, scope)) : null;
  return vlm ? Math.round(0.75 * vlmComponent(vlm, scope) + 25 * local) : Math.round(100 * local);
}

export function classifyScore(score, threshold, verdict = null, scope = 'exact') {
  if (score === null || score === undefined) return 'unscored';
  if (verdict && !(ACCEPTED_VERDICTS[scope] || ACCEPTED_VERDICTS.exact).has(verdict)) return 'low_match';
  return score >= threshold ? 'accepted' : 'low_match';
}

export function captionMatches(caption, terms) {
  const text = (caption || '').toLowerCase();
  return [...new Set(terms.filter(Boolean).map((t) => t.toLowerCase()))].filter((term) => term.length > 2 && text.includes(term));
}

// Brand / model / product-type mentions in the caption, ad copy or account name.
export function textEvidence({ caption, author, title }, plan) {
  const text = `${caption || ''} ${title || ''}`.toLowerCase();
  const compact = text.replace(/[^a-z0-9]/g, '');
  const authorText = String(author || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const has = (terms) => terms.some((t) => {
    const tc = t.replace(/[^a-z0-9]/g, '');
    return (t.length > 2 && text.includes(t)) || (tc.length > 3 && compact.includes(tc));
  });
  const { brand = [], model = [], type = [] } = plan.terms || {};
  const brandHit = brand.length > 0 && (has(brand) || brand.some((t) => t.replace(/[^a-z0-9]/g, '').length > 3 && authorText.includes(t.replace(/[^a-z0-9]/g, ''))));
  const modelHit = model.length > 0 && has(model);
  const typeHit = type.length > 0 && has(type);
  let score;
  if (plan.scope === 'category') score = typeHit ? 1 : 0.3 * (brandHit || modelHit);
  else if (plan.scope === 'brand') score = 0.6 * brandHit + 0.4 * typeHit;
  else score = 0.45 * brandHit + 0.35 * modelHit + 0.2 * typeHit;
  return { brand: brandHit, model: modelHit, type: typeHit, score: clamp01(score) };
}

// Products are often small in a 9:16 reel, so the thumbnail is compared as a whole and as overlapping crops.
const CANDIDATE_BOXES = [[0, 0, 1, 1], [0.15, 0.15, 0.7, 0.7], [0, 0, 0.6, 0.6], [0.4, 0, 0.6, 0.6], [0, 0.4, 0.6, 0.6], [0.4, 0.4, 0.6, 0.6], [0, 0.25, 1, 0.5]];
// Reference photos are sometimes marketplace collages; the best product panels are picked with CLIP text similarity.
const REFERENCE_BOXES = [[0, 0, 1, 1], [0.1, 0.1, 0.8, 0.8], [0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], [0, 0, 0.34, 0.6], [0.33, 0, 0.34, 0.6], [0.66, 0, 0.34, 0.6]];

export async function cropImage(buffer, boxes) {
  const meta = await sharp(buffer).metadata();
  const W = meta.width || 1;
  const H = meta.height || 1;
  return Promise.all(boxes.map(([x, y, w, h]) => {
    if (x === 0 && y === 0 && w === 1 && h === 1) return buffer;
    const left = Math.round(x * W);
    const top = Math.round(y * H);
    return sharp(buffer).extract({ left, top, width: Math.max(8, Math.min(W - left, Math.round(w * W))), height: Math.max(8, Math.min(H - top, Math.round(h * H))) }).jpeg({ quality: 90 }).toBuffer();
  }));
}

const VERIFY_PROMPT = ({ plan, title, features, scope, count, hasReference }) => {
  const type = plan.productType || 'product';
  const scopeRule = scope === 'category'
    ? `A candidate is relevant when a ${type} is clearly visible as a subject of the video (any brand).`
    : scope === 'brand'
      ? `A candidate is relevant when a ${plan.brand} ${type} is clearly visible.`
      : `A candidate is relevant when the ${[plan.brand, plan.model].filter(Boolean).join(' ')} ${type} itself (or a colour/size variant of it) is clearly visible.`;
  return `You verify products in frames from Instagram Reels and Facebook/Instagram video ads.
${hasReference ? 'The first image is the reference product photo.' : 'There is no reference photo; use the description.'}
Reference product: ${title}${plan.brand ? ` | brand: ${plan.brand}` : ''}${plan.model ? ` | model: ${plan.model}` : ''} | type: ${type}
Distinctive features: ${features || 'see the reference image'}
${scopeRule}
There are ${count} candidates. Captions are hints only; judge from what is visible. Do not infer a logo or text unless it is legible or the shape is unmistakable.
For each candidate choose one verdict:
"exact" = the same product, same look; "variant" = same brand and model in another colour, size or edition; "same_brand" = another ${plan.brand || 'same-brand'} product of the same type; "same_category" = a ${type} of another or unknown brand; "different" = no ${type}, or it is not a subject of the frame; "unclear" = cannot tell (too small, blurred, covered).
Return only a JSON array with one object per candidate, in order:
[{"candidate":1,"verdict":"exact|variant|same_brand|same_category|different|unclear","confidence":0-100,"reason":"max 12 words of visible evidence"}]`;
};

export function parseVerdicts(raw, count) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.candidates) ? raw.candidates : Array.isArray(raw?.results) ? raw.results : [];
  const byIndex = new Map();
  for (const entry of list) {
    const index = Number(entry?.candidate) - 1;
    const rawVerdict = String(entry?.verdict || '').toLowerCase().trim();
    const verdict = VERDICT_ALIASES[rawVerdict] || rawVerdict.replace(/\s+/g, '_');
    const confidence = Number(entry?.confidence ?? entry?.score);
    if (index < 0 || index >= count || !VERDICTS.includes(verdict) || !Number.isFinite(confidence)) continue;
    byIndex.set(index, { verdict, confidence: Math.max(0, Math.min(100, Math.round(confidence))), reason: String(entry.reason || '').slice(0, 160) });
  }
  return byIndex;
}

const label = (text) => text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, ' ');
const strength = (value) => (value >= 0.75 ? 'strong' : value >= 0.5 ? 'moderate' : value >= 0.25 ? 'weak' : 'very weak');

// Turns stored score components into readable evidence. Every number shown is a stored component.
export function explain(detail, score) {
  if (detail.local === undefined && !detail.vlm) return { summary: detail.note, reasons: [detail.note] };
  const reasons = [];
  const scope = detail.scope || 'exact';
  if (detail.vlm) {
    reasons.push(`${label(detail.vlm.verdict)} (${detail.vlmLabel || 'verifier'}, ${detail.vlm.confidence}% confident): ${detail.vlm.reason}`);
    if (!(ACCEPTED_VERDICTS[scope] || ACCEPTED_VERDICTS.exact).has(detail.vlm.verdict)) {
      reasons.push(`Rejected: a "${label(detail.vlm.verdict)}" verdict does not count as relevant for ${scope === 'category' ? 'a category search' : scope === 'brand' ? 'a brand search' : 'an exact-product search'}.`);
    }
  }
  if (detail.image !== null && detail.image !== undefined) {
    reasons.push(`${label(strength(detail.image))} visual match: best ${detail.method === 'clip' ? 'CLIP' : 'basic'} crop cosine ${detail.imageCosine}${detail.fullCosine !== undefined ? ` (whole frame ${detail.fullCosine})` : ''}`);
  }
  if (detail.text !== null && detail.text !== undefined) reasons.push(`CLIP text match "${detail.textPrompt}": ${strength(detail.text)}`);
  const ev = detail.evidence;
  if (ev) {
    const hits = [ev.brand && 'brand', ev.model && 'model', ev.type && 'product type'].filter(Boolean);
    reasons.push(hits.length ? `Caption/account mentions the ${hits.join(', ')}` : 'Caption does not mention the brand, model or product type');
  }
  if (detail.frame) reasons.push(`Scored on the frame at about ${detail.frame.second} s (best of ${detail.frame.sampled} sampled); the cover image scored ${detail.frame.coverScore}`);
  if (detail.framesError) reasons.push(`Frame sampling failed (${detail.framesError}); scored on the cover image`);
  if (detail.vlmSkipped) reasons.push(detail.vlmSkipped);
  if (detail.captionMentions?.length) reasons.push(`Caption mentions ${detail.captionMentions.map((m) => `"${m}"`).join(', ')}`);
  if (score !== null && score !== undefined) {
    const lbl = detail.vlmLabel || 'VLM';
    reasons.push(detail.vlm
      ? `Score ${score} = 0.75 × ${lbl} ${Math.round(vlmComponent(detail.vlm, scope))} + 0.25 × local ${pct(detail.local)}`
      : `Score ${score} = local relevance ${pct(detail.local)} (not verified by a vision-language model)`);
  }
  return { summary: reasons[0], reasons };
}

export function createScorer({ embedder, config, logger, product, frameSampler = null, vlm: injectedVlm = null }) {
  const { vision, frames } = config;
  const plan = product.searchPlan?.terms ? product.searchPlan : { ...buildSearchPlan({ title: product.title || '', attributes: product.attributes || {} }), ...(product.searchPlan || {}) };
  const scope = plan.scope || 'exact';
  const hasReferenceImage = Boolean(product.imageBuffer);
  const vlm = vision.verifyWithVlm ? (injectedVlm || createVlm({ config, logger })) : null;
  const useVlm = Boolean(vlm?.configured);
  const threshold = vision.matchThreshold ?? 55;
  const sendFloor = vision.vlmSendFloor ?? 0.3;
  const maxCalls = vision.vlmMaxCallsPerSearch ?? 12;
  const imageRange = vision.clipImageRange || [0.5, 0.78];
  const captionTerms = [...(plan.terms?.brand || []), ...(plan.terms?.model || []), ...(plan.terms?.type || [])];
  const usage = { vlmCalls: 0, vlmInputTokens: 0, vlmOutputTokens: 0, vlmFailures: 0, vlmVerified: 0, framesSampled: 0, frameFailures: 0, scope };
  const onUsage = (u) => {
    usage.vlmCalls += 1;
    usage.vlmInputTokens += u?.input_tokens || 0;
    usage.vlmOutputTokens += u?.output_tokens || 0;
  };
  let lastVlmError = null;
  let reference;

  const embedMany = async (buffers) => {
    if (embedder.embedImages) return embedder.embedImages(buffers);
    const results = await Promise.all(buffers.map((buffer) => embedder.embedImage(buffer)));
    return { kind: results[0]?.kind || 'basic', vectors: results.map((r) => r.vector) };
  };

  async function prepare() {
    if (reference) return reference;
    reference = { vectors: [], specific: null, person: null, kind: null };
    const texts = await embedder.embedTexts?.([plan.prompts?.specific || `a photo of a ${product.title}`, plan.prompts?.category || `a photo of a ${product.title}`, 'a photo of a person']);
    if (texts) [reference.specific, reference.category, reference.person] = texts;
    reference.textVector = scope === 'category' ? reference.category : reference.specific;
    if (hasReferenceImage) {
      const crops = await cropImage(product.imageBuffer, REFERENCE_BOXES);
      const { kind, vectors } = await embedMany(crops);
      reference.kind = kind;
      if (kind === 'clip' && reference.category) {
        // Keep the whole photo plus up to two panels that look at least as much like the product as the whole photo.
        const sims = vectors.map((v) => cosine(v, reference.category));
        const ranked = vectors.map((v, i) => ({ v, i, s: sims[i] })).slice(1).filter((r) => r.s >= sims[0] - 0.005).sort((a, b) => b.s - a.s).slice(0, 2);
        reference.vectors = [vectors[0], ...ranked.map((r) => r.v)];
        reference.panels = ranked.map((r) => r.i);
      } else {
        reference.vectors = [vectors[0]];
      }
    }
    return reference;
  }

  // Local relevance for one image (thumbnail or frame) plus the candidate's text.
  async function localOf(buffer, candidate) {
    const ref = await prepare();
    const crops = await cropImage(buffer, CANDIDATE_BOXES);
    const { kind, vectors } = await embedMany(crops);
    let image = null;
    let imageCosine;
    let fullCosine;
    if (hasReferenceImage && ref.vectors.length) {
      let best = -1;
      for (const r of ref.vectors) for (const v of vectors) best = Math.max(best, cosine(r, v));
      imageCosine = round3(best);
      fullCosine = round3(cosine(ref.vectors[0], vectors[0]));
      image = mapCosine(best, kind === 'clip' ? imageRange : [0.3, 0.95]);
    }
    let text = null;
    if (kind === 'clip' && ref.textVector && ref.person) {
      const spec = Math.max(...vectors.map((v) => cosine(v, ref.textVector)));
      const person = Math.max(...vectors.map((v) => cosine(v, ref.person)));
      text = clamp01((spec - person + 0.01) / 0.05);
    }
    const evidence = textEvidence({ caption: candidate.caption, author: candidate.author, title: candidate.title }, plan);
    const local = combineLocal({ image, text, evidence: evidence.score, scope });
    return { reference: hasReferenceImage ? 'image' : 'text', method: kind, image, imageCosine, fullCosine, text, textPrompt: scope === 'category' ? plan.prompts?.category : plan.prompts?.specific, evidence, local, scope };
  }

  async function improveWithFrames(entries) {
    if (!frames?.enabled || !frameSampler) return;
    const eligible = entries
      .filter((e) => e.candidate.videoUrl && e.detail.local !== undefined && (e.detail.image ?? 0) < (frames.confidentAbove ?? 0.85))
      .sort((a, b) => (b.detail.evidence.score + b.detail.local) - (a.detail.evidence.score + a.detail.local))
      .slice(0, frames.maxPerBatch ?? 8);
    for (const entry of eligible) {
      try {
        const sampled = await frameSampler.sample(entry.candidate.videoUrl);
        usage.framesSampled += 1;
        let best = null;
        for (const frame of sampled) {
          const detail = await localOf(frame.buffer, entry.candidate);
          if (!best || detail.local > best.detail.local) best = { frame, detail };
        }
        if (best && best.detail.local > entry.detail.local) {
          entry.detail = { ...best.detail, frame: { second: best.frame.second, sampled: sampled.length, coverScore: pct(entry.detail.local) } };
          entry.image = best.frame.buffer;
          entry.frameBuffer = best.frame.buffer;
        }
      } catch (error) {
        usage.frameFailures += 1;
        entry.detail.framesError = error.message.slice(0, 120);
      }
    }
  }

  const accepted = (entry) => entry.detail.vlm && (ACCEPTED_VERDICTS[scope] || ACCEPTED_VERDICTS.exact).has(entry.detail.vlm.verdict)
    && finalScore(entry.detail.local, entry.detail.vlm, scope) >= threshold;

  // Best-first verification: stops when enough positives are confirmed or the per-search call budget is spent.
  async function verify(entries, need) {
    if (!useVlm) return;
    const ranked = entries.filter((e) => e.image && !e.candidate.skipVerify && e.detail.local !== undefined && e.detail.local >= sendFloor).sort((a, b) => b.detail.local - a.detail.local);
    for (const entry of entries) {
      if (entry.candidate.skipVerify) {
        entry.detail.vlmSkipped = 'Not verified: shown in an earlier search, so it does not count toward this one';
        continue;
      }
      if (entry.image && entry.detail.local !== undefined && entry.detail.local < sendFloor) {
        entry.detail.vlmSkipped = `Not sent to the verifier: local relevance ${pct(entry.detail.local)} is below ${pct(sendFloor)}`;
      }
    }
    let positives = 0;
    let index = 0;
    while (index < ranked.length) {
      if (positives >= need) {
        ranked.slice(index).forEach((e) => { e.detail.vlmSkipped = 'Not verified: enough confirmed matches were found in this round'; });
        return;
      }
      if (!vlm.available || usage.vlmCalls >= maxCalls) {
        const why = !vlm.available ? `verifier unavailable (${(vlm.disabledReasons()[0] || lastVlmError || 'not configured').slice(0, 140)})` : `per-search verification budget of ${maxCalls} calls used`;
        ranked.slice(index).forEach((e) => { e.detail.vlmSkipped = `Not verified: ${why}`; e.detail.unverifiedBecause = why; });
        return;
      }
      const room = Math.max(1, Math.min(vision.vlmBatchSize || 10, vlm.maxImages() - (hasReferenceImage ? 1 : 0)));
      const chunk = ranked.slice(index, index + room);
      try {
        const { result, provider, used } = await vlm.json({
          prompt: VERIFY_PROMPT({ plan, title: product.title, features: (product.attributes?.distinctiveFeatures || []).join('; '), scope, count: chunk.length, hasReference: hasReferenceImage }),
          imagesFor: (maxImages) => {
            const list = hasReferenceImage ? [{ label: 'Reference product photo:', buffer: product.imageBuffer }] : [];
            chunk.slice(0, Math.max(1, maxImages - list.length)).forEach((e, k) => list.push({ label: `Candidate ${k + 1}${e.candidate.caption ? ` (caption hint: "${String(e.candidate.caption).replace(/\s+/g, ' ').slice(0, 100)}")` : ''}:`, buffer: e.image }));
            return list;
          },
          label: 'verify',
          onUsage,
        });
        const covered = chunk.slice(0, used - (hasReferenceImage ? 1 : 0));
        const verdicts = parseVerdicts(result, covered.length);
        covered.forEach((entry, k) => {
          if (verdicts.has(k)) {
            entry.detail.vlm = verdicts.get(k);
            entry.detail.vlmLabel = provider;
            usage.vlmVerified += 1;
            if (accepted(entry)) positives += 1;
          } else entry.detail.vlmSkipped = 'The verifier returned no verdict for this candidate';
        });
        index += Math.max(1, covered.length);
      } catch (error) {
        lastVlmError = error.message;
        usage.vlmFailures += chunk.length;
        logger?.warn({ err: error.message?.slice(0, 200) }, 'verification failed for batch');
        chunk.forEach((entry) => { entry.detail.vlmSkipped = `Verification failed (${error.message.slice(0, 90)})`; entry.detail.unverifiedBecause = 'verification failed'; });
        index += chunk.length;
      }
    }
  }

  // Unverified candidates are only accepted when no verifier could look at them, and then only on strong local
  // evidence: for brand/exact searches the caption or account must name the brand or model.
  function unverifiedAccept(detail) {
    if (!detail.unverifiedBecause && useVlm) return false;
    const strongText = scope === 'category' ? detail.evidence?.type || (detail.text ?? 0) >= 0.6 : detail.evidence?.brand || detail.evidence?.model;
    return pct(detail.local) >= threshold && Boolean(strongText);
  }

  async function scoreBatch(candidates, { need = Infinity } = {}) {
    const entries = [];
    for (const candidate of candidates) {
      const entry = { candidate, image: candidate.thumbnailBuffer, detail: {} };
      if (candidate.thumbnailBuffer) {
        try {
          entry.detail = await localOf(candidate.thumbnailBuffer, candidate);
        } catch (error) {
          logger?.warn({ err: error.message }, 'thumbnail scoring failed');
          entry.detail = { note: `Scoring failed: ${error.message}` };
          entry.image = null;
        }
      } else {
        entry.detail = { note: 'No thumbnail available from the source, so the video could not be checked visually' };
      }
      entries.push(entry);
    }
    await improveWithFrames(entries);
    await verify(entries, need);

    return entries.map(({ candidate, detail, frameBuffer }) => {
      const score = detail.local === undefined ? null : finalScore(detail.local, detail.vlm, scope);
      detail.captionMentions = captionMatches(candidate.caption, captionTerms);
      detail.vlmLabel ??= vlm?.label;
      let matchStatus = classifyScore(score, threshold, detail.vlm?.verdict, scope);
      if (!detail.vlm && score !== null) {
        matchStatus = unverifiedAccept(detail) ? 'accepted' : 'low_match';
        detail.verified = false;
      } else if (detail.vlm) detail.verified = true;
      const { summary, reasons } = explain(detail, score);
      return { score, detail: { ...detail, summary, reasons }, matchStatus, frameBuffer: frameBuffer ?? null };
    });
  }

  scoreBatch.usage = usage;
  scoreBatch.plan = plan;
  scoreBatch.describe = () => `${useVlm ? `local relevance + ${vlm.names.join(' → ')} verification` : 'local relevance only (no verifier configured)'} · scope ${scope}`;
  return scoreBatch;
}
