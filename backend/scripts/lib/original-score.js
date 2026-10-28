import { claudeJson, imageBlock } from '../../src/brain/anthropic.js';
import { geminiJson } from '../../src/brain/gemini.js';
import { colorHistogram, cosine, histogramIntersection } from '../../src/brain/imageUtils.js';

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const pct = (value) => Math.round(value * 100);

export const mapCosine = (cos, [low, high]) => clamp01((cos - low) / (high - low));

// Visual score in 0..1. Weights are documented in the README.
export function combineVisual({ embedKind, embedScore, colourScore, hasReferenceImage }) {
  if (!hasReferenceImage) return embedKind === 'clip' ? embedScore : null;
  return embedKind === 'clip' ? 0.8 * embedScore + 0.2 * colourScore : 0.55 * colourScore + 0.45 * embedScore;
}

export function finalScore(visual, vlm) {
  if (visual === null || visual === undefined) return vlm ? Math.round(vlm.score) : null;
  return vlm ? Math.round(35 * visual + 0.65 * vlm.score) : Math.round(100 * visual);
}

export const classifyScore = (score, threshold, verdict = null) => {
  if (score === null || score === undefined) return 'unscored';
  if (['different', 'same_category', 'unclear'].includes(verdict)) return 'low_match';
  return score >= threshold ? 'accepted' : 'low_match';
};

const strength = (value) => (value >= 0.75 ? 'strong' : value >= 0.5 ? 'moderate' : value >= 0.25 ? 'weak' : 'very weak');
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export function captionMatches(caption, terms) {
  const text = (caption || '').toLowerCase();
  return [...new Set(terms.filter(Boolean).map((t) => t.toLowerCase()))].filter((term) => term.length > 2 && text.includes(term));
}

// Turns stored score components into readable evidence. Every number shown is a stored component.
export function explain(detail, score) {
  if (detail.visual === undefined && !detail.vlm) return { summary: detail.note, reasons: [detail.note] };
  const reasons = [];
  if (detail.vlm) reasons.push(`${capitalise(detail.vlm.verdict.replace('_', ' '))}: ${detail.vlm.reason}`);
  if (['different', 'same_category', 'unclear'].includes(detail.vlm?.verdict)) {
    reasons.push(`Rejected: verifier did not confirm the exact product (${detail.vlm.verdict.replace('_', ' ')}).`);
  }
  if (detail.reference === 'text') {
    reasons.push(`No product photo: compared with the text "${detail.referenceText}" (CLIP text-to-image, ${strength(detail.visual)})`);
  } else if (detail.visual !== null && detail.visual !== undefined) {
    const model = detail.method === 'clip' ? `CLIP image similarity ${strength(detail.embeddingScore)} (cosine ${detail.embeddingCosine})` : `basic structure similarity ${strength(detail.embeddingScore)} (CLIP unavailable)`;
    reasons.push(`${capitalise(strength(detail.visual))} visual match: ${model}, colour overlap ${pct(detail.colourOverlap)}%`);
  }
  if (detail.frame) reasons.push(`Scored on the frame at about ${detail.frame.second} s (best of ${detail.frame.sampled} sampled); the cover image scored ${detail.frame.coverScore}`);
  if (detail.framesError) reasons.push(`Frame sampling failed (${detail.framesError}); scored on the cover image`);
  if (detail.vlmSkipped) reasons.push(detail.vlmSkipped);
  if (detail.captionMentions?.length) reasons.push(`Caption mentions ${detail.captionMentions.map((m) => `"${m}"`).join(', ')} (text only, not part of the score)`);
  if (score !== null && score !== undefined) {
    // detail.vlmLabel is injected by createScorer so the name is provider-specific ("Claude"/"Gemini").
    const lbl = detail.vlmLabel || 'VLM';
    reasons.push(detail.vlm && detail.visual !== null ? `Score ${score} = 0.35 × visual ${pct(detail.visual)} + 0.65 × ${lbl} ${detail.vlm.score}` : detail.vlm ? `Score ${score} = ${lbl} ${detail.vlm.score}` : `Score ${score} = visual ${pct(detail.visual)}`);
  }
  return { summary: reasons[0], reasons };
}

const VERDICTS = new Set(['exact', 'close', 'same_category', 'different', 'unclear']);
const VERDICT_SCORE_CAP = { exact: 100, close: 84, same_category: 64, different: 29, unclear: 40 };

function parseVerdict(entry, imagesLength) {
  const index = Number(entry.candidate) - 1;
  const score = Number(entry.score);
  if (index < 0 || index >= imagesLength || !Number.isFinite(score) || !VERDICTS.has(entry.verdict)) return null;
  return [index, {
    verdict: entry.verdict,
    score: Math.max(0, Math.min(VERDICT_SCORE_CAP[entry.verdict], score)),
    reason: String(entry.reason || '').slice(0, 160),
  }];
}

async function verifyWithClaude({ reference, images, config, logger, onUsage }) {
  const content = [];
  if (reference.imageBuffer) content.push({ type: 'text', text: 'Reference product:' }, imageBlock(reference.imageBuffer));
  else content.push({ type: 'text', text: `Reference product (no photo available): ${reference.title}` });
  images.forEach((buffer, index) => content.push({ type: 'text', text: `Candidate ${index + 1}:` }, imageBlock(buffer)));
  content.push({
    type: 'text',
    text: `Each candidate is a frame or thumbnail from a short video or video ad. For each, decide whether the reference product itself (the exact item, not just the same category) is visible.
Distinctive features of the reference: ${reference.features || 'see image'}.
Return only a JSON array: [{"candidate": 1, "verdict": "exact"|"close"|"same_category"|"different"|"unclear", "score": 0-100, "reason": "max 15 words of concrete visual evidence"}].
Scoring: exact 85-100, close variant 65-84, same category only 30-64, different 0-29, unclear (product not visible or too small) 0-40.`,
  });
  const raw = await claudeJson({ config, logger, content, maxTokens: 200 + 90 * images.length, label: 'claude-verify', onUsage, system: 'You verify product matches in video frames. Respond with JSON only.' });
  const byIndex = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const verdict = parseVerdict(entry, images.length);
    if (verdict) byIndex.set(...verdict);
  }
  return byIndex;
}

async function verifyWithGemini({ reference, images, config, logger, onUsage }) {
  const imageParts = [];
  if (reference.imageBuffer) imageParts.push({ label: 'Reference product image:', buffer: reference.imageBuffer });
  images.forEach((buffer, index) => imageParts.push({ label: `Candidate ${index + 1} video frame or thumbnail:`, buffer }));
  const prompt = `You verify whether each candidate frame shows the exact reference product, not merely the same category.
Reference title: ${reference.title || 'unknown'}
Distinctive reference features: ${reference.features || 'inspect the reference image'}
For each candidate return a JSON array with objects:
[{"candidate":1,"verdict":"exact|close|same_category|different|unclear","score":0,"reason":"max 15 words of concrete visual evidence"}]
Score exact match 85-100, close variant 65-84, same category 30-64, different 0-29, unclear (product not visible or too small) 0-40. Do not infer a logo or text unless legible.`;
  const raw = await geminiJson({ config, logger, prompt, images: imageParts, label: 'gemini-verify', onUsage });
  const byIndex = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const verdict = parseVerdict(entry, images.length);
    if (verdict) byIndex.set(...verdict);
  }
  return byIndex;
}

export function createScorer({ embedder, config, logger, product, frameSampler = null }) {
  const { vision, frames } = config;
  const hasReferenceImage = Boolean(product.imageBuffer);
  const vlmProvider = vision.geminiKey ? 'gemini' : vision.anthropicKey ? 'claude' : null;
  // Human-readable label for the VLM in score explanations ("Gemini" / "Claude")
  const vlmLabel = vlmProvider === 'gemini' ? 'Gemini' : vlmProvider === 'claude' ? 'Claude' : 'VLM';
  const useVlm = Boolean(vlmProvider && vision.verifyWithVlm);
  const [bandLow, bandHigh] = vision.vlmBand;
  const captionTerms = [product.attributes?.productType, product.attributes?.printOrGraphic, ...(product.attributes?.colors || []).slice(0, 2), ...(product.searchPlan?.queries || []).slice(0, 2)];
  const usage = { vlmCalls: 0, vlmInputTokens: 0, vlmOutputTokens: 0, vlmFailures: 0, framesSampled: 0, frameFailures: 0 };
  const onUsage = (u) => {
    usage.vlmCalls += 1;
    usage.vlmInputTokens += u?.input_tokens || 0;
    usage.vlmOutputTokens += u?.output_tokens || 0;
  };
  let verifierUnavailable = null;
  let reference;

  async function prepare() {
    if (reference) return reference;
    reference = { imageVector: null, textVector: null, histogram: null };
    if (hasReferenceImage) {
      reference.imageVector = (await embedder.embedImage(product.imageBuffer)).vector;
      reference.histogram = await colorHistogram(product.imageBuffer);
    } else {
      reference.textVector = (await embedder.embedTexts([`a photo of ${product.title}`]))?.[0] ?? null;
    }
    return reference;
  }

  async function visualOf(buffer) {
    const ref = await prepare();
    const embedded = await embedder.embedImage(buffer);
    if (hasReferenceImage) {
      const cos = cosine(ref.imageVector, embedded.vector);
      const embeddingScore = mapCosine(cos, embedded.kind === 'clip' ? vision.clipImageRange : [0.2, 0.9]);
      const colourOverlap = histogramIntersection(ref.histogram, await colorHistogram(buffer));
      return {
        reference: 'image', method: embedded.kind, embeddingCosine: Math.round(cos * 1000) / 1000, embeddingScore,
        colourOverlap: Math.round(colourOverlap * 100) / 100,
        visual: combineVisual({ embedKind: embedded.kind, embedScore: embeddingScore, colourScore: colourOverlap, hasReferenceImage: true }),
      };
    }
    if (ref.textVector && embedded.kind === 'clip') {
      const cos = cosine(ref.textVector, embedded.vector);
      return { reference: 'text', referenceText: product.title, method: 'clip', embeddingCosine: Math.round(cos * 1000) / 1000, visual: mapCosine(cos, vision.clipTextRange) };
    }
    return { reference: 'none', method: embedded.kind, visual: null, note: 'Not scored: no product photo and no CLIP model for text-to-image comparison' };
  }

  // Cover images often show a title card; for videos that are not already a confident match,
  // sample frames and keep the best one.
  async function improveWithFrames(entries) {
    if (!frames.enabled || !frameSampler) return;
    const eligible = entries
      .filter((e) => e.candidate.videoUrl && (e.detail.visual === undefined || (e.detail.visual ?? 0) < frames.confidentAbove))
      .sort((a, b) => (b.detail.visual ?? -1) - (a.detail.visual ?? -1))
      .slice(0, frames.maxPerBatch);
    for (const entry of eligible) {
      try {
        const sampled = await frameSampler.sample(entry.candidate.videoUrl);
        usage.framesSampled += 1;
        let best = null;
        for (const frame of sampled) {
          const detail = await visualOf(frame.buffer);
          if (detail.visual !== null && (!best || detail.visual > best.detail.visual)) best = { frame, detail };
        }
        const coverVisual = entry.detail.visual;
        if (best && (coverVisual === undefined || coverVisual === null || best.detail.visual > coverVisual)) {
          entry.detail = { ...best.detail, frame: { second: best.frame.second, sampled: sampled.length, coverScore: coverVisual === undefined || coverVisual === null ? 'n/a' : pct(coverVisual) } };
          entry.image = best.frame.buffer;
          entry.frameBuffer = best.frame.buffer;
        }
      } catch (error) {
        usage.frameFailures += 1;
        entry.detail.framesError = error.message.slice(0, 120);
      }
    }
  }

  async function verify(entries) {
    if (!useVlm) return;
    const toVerify = [];
    for (const entry of entries) {
      const visual = entry.detail.visual;
      if (!entry.image || visual === undefined) continue;
      const v = visual ?? 0.3;
      if (v < bandLow) entry.detail.vlmSkipped = `Not sent to VLM: visual score ${pct(v)} is below the verification band (${pct(bandLow)}-${pct(bandHigh)})`;
      else if (vision.vlmMode === 'ambiguous' && v > bandHigh) entry.detail.vlmSkipped = `Not sent to VLM: visual score ${pct(v)} is above the verification band, accepted on visual evidence`;
      else toVerify.push(entry);
    }
    for (let start = 0; start < toVerify.length; start += vision.vlmBatchSize) {
      const chunk = toVerify.slice(start, start + vision.vlmBatchSize);
      if (verifierUnavailable) {
        usage.vlmFailures += chunk.length;
        chunk.forEach((entry) => {
          entry.detail.vlmSkipped = `${vlmLabel} verification unavailable for this search (${verifierUnavailable}); visual score retained`;
        });
        continue;
      }
      try {
        const verifier = vlmProvider === 'gemini' ? verifyWithGemini : verifyWithClaude;
        const verdicts = await verifier({
          reference: { imageBuffer: product.imageBuffer, title: product.title, features: (product.attributes?.distinctiveFeatures || []).join('; ') },
          images: chunk.map((e) => e.image),
          config,
          logger,
          onUsage,
        });
        chunk.forEach((entry, k) => {
          if (verdicts.has(k)) entry.detail.vlm = verdicts.get(k);
          else entry.detail.vlmSkipped = 'VLM returned no verdict for this candidate; score is visual only';
        });
      } catch (error) {
        logger.warn({ provider: vlmProvider, err: error.message }, 'VLM verification failed for batch');
        usage.vlmFailures += chunk.length;
        if (!error.retryable || ['GEMINI_QUOTA_EXHAUSTED', 'GEMINI_BILLING_REQUIRED', 'GEMINI_PERMISSION_DENIED', 'GEMINI_INVALID_REQUEST'].includes(error.code)) {
          verifierUnavailable = error.message.slice(0, 120);
        }
        chunk.forEach((entry) => {
          entry.detail.vlmSkipped = `${vlmLabel} verification failed (${error.message.slice(0, 80)}); score is visual only`;
        });
      }
    }
  }

  async function scoreBatch(candidates) {
    const entries = [];
    for (const candidate of candidates) {
      const entry = { candidate, image: candidate.thumbnailBuffer, detail: {} };
      if (candidate.thumbnailBuffer) {
        try {
          entry.detail = await visualOf(candidate.thumbnailBuffer);
        } catch (error) {
          logger.warn({ err: error.message }, 'thumbnail scoring failed');
          entry.detail = { note: `Scoring failed: ${error.message}` };
        }
      } else {
        entry.detail = { note: 'No thumbnail available from the source, so the video could not be checked visually' };
      }
      entries.push(entry);
    }
    await improveWithFrames(entries);
    await verify(entries);

    return entries.map(({ candidate, detail, frameBuffer }) => {
      const score = detail.visual === undefined && !detail.vlm ? null : finalScore(detail.visual, detail.vlm);
      detail.captionMentions = captionMatches(candidate.caption, captionTerms);
      // Inject the provider label so explain() can name it specifically.
      detail.vlmLabel = vlmLabel;
      const { summary, reasons } = explain(detail, score);
      return { score, detail: { ...detail, summary, reasons }, matchStatus: classifyScore(score, vision.matchThreshold, detail.vlm?.verdict), frameBuffer: frameBuffer ?? null };
    });
  }

  scoreBatch.usage = usage;
  return scoreBatch;
}
