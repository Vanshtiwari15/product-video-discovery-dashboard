// Builds the search plan from what the user typed (authoritative), the product page and, when available,
// the vision-language analysis. The local CLIP fallback never decides the product type: on real searches it
// labelled a Stanley tumbler "kitchen appliance" and "mug", which produced hashtags with no relevant videos.

const COLORS = new Set(['black', 'white', 'grey', 'gray', 'red', 'maroon', 'orange', 'yellow', 'olive', 'green', 'teal', 'blue', 'navy', 'purple', 'violet', 'pink', 'rose', 'brown', 'beige', 'cream', 'ivory', 'gold', 'golden', 'silver', 'lilac', 'lavender', 'mint', 'peach', 'coral', 'turquoise', 'multicolor', 'multicolour']);
const MATERIALS = new Set(['plastic', 'metal', 'steel', 'stainless', 'cotton', 'leather', 'glass', 'ceramic', 'wood', 'wooden', 'silicone', 'paper', 'rubber', 'silk', 'wool', 'denim', 'linen', 'bamboo', 'aluminium', 'aluminum']);
const PATTERNS = new Set(['floral', 'paisley', 'striped', 'stripes', 'checked', 'checks', 'plaid', 'geometric', 'polka', 'botanical', 'abstract', 'leopard', 'tropical', 'ikat', 'mughal', 'jaipuri', 'kalamkari', 'dabu', 'bagru', 'indigo']);
const STOP = new Set(['seater', 'the', 'a', 'an', 'and', 'or', 'with', 'without', 'for', 'of', 'in', 'on', 'by', 'to', 'from', 'new', 'original', 'official', 'genuine', 'authentic', 'premium', 'best', 'pack', 'set', 'combo', 'free', 'sale', 'buy', 'online', 'men', 'women', 'mens', 'womens', 'kids', 'unisex', 'size', 'large', 'small', 'medium', 'mini', 'big', 'edition', 'version', 'model', 'item', 'product', 'oz', 'ml', 'litre', 'liter', 'cm', 'mm', 'inch', 'inches', 'pcs', 'piece', 'pieces', 'pc', 'qty']);
// Words that describe a product without naming it; they never become a model name or a standalone hashtag.
const DESCRIPTORS = new Set(['skincare', 'haircare', 'bodycare', 'makeup', 'insulated', 'reusable', 'portable', 'wireless', 'bluetooth', 'organic', 'natural', 'handmade', 'printed', 'hand', 'block', 'print', 'travel', 'kitchen', 'home', 'face', 'facial', 'body', 'hair', 'eye', 'lip', 'baby', 'smart', 'electric', 'digital', 'vacuum', 'leakproof', 'leak', 'proof', 'resistant', 'waterproof', 'non', 'stick', 'brightening', 'hydrating', 'moisturising', 'moisturizing', 'anti', 'aging', 'ageing', 'daily', 'everyday', 'luxury', 'classic', 'pro', 'plus', 'max', 'ultra', 'lite', 'light', 'heavy', 'duty', 'cup', 'holder', 'straw', 'handle', 'lid']);
const PRODUCT_NOUNS = new Set([
  'tumbler', 'bottle', 'flask', 'mug', 'cup', 'thermos', 'jar', 'serum', 'cream', 'moisturizer', 'moisturiser', 'cleanser', 'facewash', 'sunscreen', 'toner', 'lotion', 'mask', 'lipstick', 'lipbalm', 'gloss', 'foundation', 'concealer', 'mascara', 'eyeliner', 'perfume', 'fragrance', 'deodorant', 'shampoo', 'conditioner', 'oil', 'gel', 'balm', 'scrub', 'soap',
  'sneakers', 'sneaker', 'shoes', 'shoe', 'sandals', 'boots', 'heels', 'slippers', 'dress', 'shirt', 'tshirt', 'hoodie', 'sweatshirt', 'jacket', 'jeans', 'trousers', 'pants', 'shorts', 'skirt', 'saree', 'sari', 'kurta', 'kurti', 'dupatta', 'leggings', 'cap', 'hat', 'scarf', 'socks',
  'bag', 'handbag', 'backpack', 'wallet', 'tote', 'purse', 'watch', 'smartwatch', 'sunglasses', 'glasses', 'necklace', 'earrings', 'ring', 'bracelet', 'jewellery', 'jewelry',
  'tablecloth', 'towel', 'towels', 'napkin', 'napkins', 'placemat', 'placemats', 'runner', 'pillow', 'cushion', 'cover', 'bedsheet', 'duvet', 'quilt', 'blanket', 'rug', 'curtain', 'curtains', 'apron', 'diary', 'notebook', 'journal', 'planner',
  'headphones', 'earbuds', 'earphones', 'speaker', 'phone', 'case', 'charger', 'powerbank', 'laptop', 'tablet', 'camera', 'keyboard', 'mouse', 'lamp', 'candle', 'diffuser', 'vase', 'planter', 'pot', 'pan', 'kettle', 'blender', 'mixer', 'toaster', 'airfryer', 'cooker',
  'toy', 'doll', 'puzzle', 'supplement', 'protein', 'powder', 'chocolate', 'snack', 'tea', 'coffee',
]);
const MARKETPLACES = /^(amazon|amazon\.\w+|shopify|etsy|flipkart|myntra|meesho|walmart|ebay|aliexpress|temu)$/i;
const GENERIC_TAGS = new Set([...COLORS, ...MATERIALS, 'love', 'instagood', 'viral', 'reels', 'reel', 'reelsinstagram', 'trending', 'trend', 'explore', 'explorepage', 'fyp', 'foryou', 'foryoupage', 'shopping', 'shop', 'sale', 'new', 'style', 'fashion', 'home', 'homedecor', 'decor', 'kitchen', 'appliance', 'kitchenappliance', 'logo', 'text', 'large', 'gift', 'gifts', 'giftideas', 'product', 'products', 'hydration', 'aesthetic', 'amazonfinds', 'tiktokmademebuyit', 'musthave', 'unboxing', 'review', 'haul', 'drinkware', 'beauty', 'skincare', 'selfcare', 'ootd', 'photooftheday']);

const unique = (values) => [...new Set(values.filter(Boolean))];
const lower = (text) => String(text || '').toLowerCase();
export const toTag = (...parts) => parts.join('').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

function tokenize(text) {
  return String(text || '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[|,–—:/+&]/g, ' ')
    .split(/\s+/)
    .map((raw) => ({ raw, word: lower(raw).replace(/^[^a-z0-9]+|[^a-z0-9.]+$/g, '').replace(/\.$/, '') }))
    .filter((t) => t.word);
}

const isUnit = (word) => /^\d+(\.\d+)?(oz|ml|l|g|kg|cm|mm|in|inch|pcs|pc|x|pack|gb|tb|w|mah)?$/.test(word) || /^x\d+$/.test(word);
const hasDigit = (word) => /\d/.test(word);
const singular = (word) => (word.endsWith('es') && PRODUCT_NOUNS.has(word.slice(0, -2)) ? word.slice(0, -2) : word.endsWith('s') && PRODUCT_NOUNS.has(word.slice(0, -1)) ? word.slice(0, -1) : word);

function typeFromText(text) {
  const words = tokenize(text).map((t) => singular(t.word)).filter((w) => !isUnit(w));
  for (let i = words.length - 1; i >= 0; i -= 1) if (PRODUCT_NOUNS.has(words[i])) return words[i];
  return null;
}

// "insulated tumbler with handle" -> "tumbler"; keeps short multi-word types such as "pillow cover".
function normaliseType(value) {
  if (!value) return null;
  const known = typeFromText(value);
  if (known) return known;
  const words = tokenize(value).map((t) => t.word).filter((w) => !STOP.has(w) && !COLORS.has(w) && !MATERIALS.has(w) && !isUnit(w));
  return words.length ? words.slice(-2).join(' ') : null;
}

function brandFromTitle(tokens, productType) {
  if (tokens.length < 2) return null;
  const first = tokens[0];
  const word = first.word;
  if (!/^[A-Z]/.test(first.raw) || hasDigit(word) || word.length < 2) return null;
  if (STOP.has(word) || COLORS.has(word) || MATERIALS.has(word) || DESCRIPTORS.has(word) || PRODUCT_NOUNS.has(singular(word)) || word === productType) return null;
  return first.raw.replace(/[^A-Za-z0-9&'-]/g, '');
}

function cleanHandle(handle) {
  const value = lower(handle).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9._]{2,30}$/.test(value) ? value : null;
}

// plan = { scope, brand, model, productType, queries, hashtags, accounts, terms, prompts }
export function buildSearchPlan({ title, attributes = {}, suggestions = {}, page = {}, scope = 'auto', fromVlm = false }) {
  const tokens = tokenize(title);
  const productType = typeFromText(title) || (fromVlm ? normaliseType(attributes.productType) : null) || normaliseType(page.category)
    || (tokens.length ? singular(tokens.filter((t) => !isUnit(t.word) && !STOP.has(t.word)).at(-1)?.word || '') || null : null);

  const pageBrand = page.brand && !MARKETPLACES.test(page.brand) ? page.brand : null;
  const vlmBrand = fromVlm ? (suggestions.brand || null) : null;
  const titleBrand = brandFromTitle(tokens, productType);
  const logoBrand = fromVlm ? (attributes.logos || []).find((logo) => logo && logo.length <= 24 && lower(title).includes(lower(logo))) : null;
  const tidy = (value) => (value && /^[A-Z0-9&' -]{4,}$/.test(value) ? value.charAt(0) + value.slice(1).toLowerCase() : value);
  const brand = tidy((pageBrand || titleBrand || vlmBrand || logoBrand || '').trim()) || null;
  const brandWords = new Set(tokenize(brand).map((t) => t.word));

  // Model = remaining name words from the title (e.g. "Quencher"), never colours, materials, units or descriptors.
  const modelWords = [];
  for (const { word, raw } of tokens) {
    if (brandWords.has(word) || singular(word) === productType || STOP.has(word) || COLORS.has(word) || MATERIALS.has(word) || DESCRIPTORS.has(word) || PATTERNS.has(word) || isUnit(word)) continue;
    if (hasDigit(word) || word.length < 3 || PRODUCT_NOUNS.has(singular(word))) continue;
    modelWords.push(/^[a-z]/.test(raw) ? word : raw.replace(/[^A-Za-z0-9'-]/g, ''));
  }
  let model = modelWords.slice(0, 3).join(' ') || null;
  if (!model && fromVlm && suggestions.modelName) {
    const vlmModel = tokenize(suggestions.modelName).map((t) => t.word).filter((w) => !brandWords.has(w) && singular(w) !== productType && !STOP.has(w) && !isUnit(w) && w.length >= 3);
    model = vlmModel.slice(0, 3).join(' ') || null;
  }
  const words = tokens.map((t) => t.word);
  const descriptors = unique([
    /block\s*print/.test(lower(title)) ? 'block print' : null,
    ...words.filter((w) => PATTERNS.has(w)),
    ...words.filter((w) => DESCRIPTORS.has(w) && !['cup', 'holder', 'straw', 'handle', 'lid', 'hand', 'block', 'print', 'printed'].includes(w)),
  ]).slice(0, 3);

  const resolvedScope = ['exact', 'brand', 'category'].includes(scope) ? scope : brand && model ? 'exact' : brand ? 'brand' : 'category';
  const modelFirst = model?.split(' ')[0] || null;
  const typeTag = productType ? toTag(productType) : null;

  // Hashtags people actually use: compact brand+model forms first, broad category tags last (category scope only).
  const isUsefulTag = (tag) => tag && tag.length >= 3 && tag.length <= 24 && !GENERIC_TAGS.has(tag) && !/^\d+$/.test(tag);
  const anchors = [toTag(brand || ''), ...(model ? model.split(' ').map((w) => toTag(w)) : [])].filter((a) => a.length >= 3);
  const modelLower = model ? lower(model) : null;
  const vlmTags = (suggestions.hashtags || []).map((t) => toTag(t)).filter(isUsefulTag);
  const anchoredVlmTags = vlmTags.filter((tag) => anchors.some((a) => tag.includes(a)));
  const typedVlmTags = typeTag ? vlmTags.filter((tag) => tag.includes(typeTag) && !anchoredVlmTags.includes(tag) && !COLORS.has(tag.replace(typeTag, ''))) : [];
  let hashtags;
  if (resolvedScope === 'category') {
    // Descriptor tags (e.g. #blockprinttablecloth) are closer to the user's product, so they run before the bare category.
    hashtags = [...descriptors.map((d) => toTag(d, productType)), typeTag, ...typedVlmTags, typeTag && `${typeTag}s`, ...anchoredVlmTags];
  } else {
    hashtags = [
      model && toTag(brand, model),
      modelFirst && model !== modelFirst && toTag(brand, modelFirst),
      productType && toTag(brand, productType),
      ...anchoredVlmTags,
      model && productType && toTag(model, productType),
      modelLower && modelLower.length >= 5 && !DESCRIPTORS.has(modelLower) && toTag(model),
      toTag(brand),
    ];
  }
  hashtags = unique(hashtags.filter(isUsefulTag)).slice(0, 14);

  // Meta Ad Library keyword searches (unordered words). Brand-level searches come before the bare brand.
  const vlmQueries = (suggestions.queries || [])
    .map((q) => String(q).replace(/\s+/g, ' ').trim())
    .filter((q) => q && q.split(' ').length <= 5)
    .filter((q) => {
      const ql = lower(q);
      return resolvedScope === 'category' ? productType && ql.includes(productType) : anchors.some((a) => toTag(ql).includes(a));
    })
    .filter((q) => !tokenize(q).some((t) => COLORS.has(t.word)));
  let queries;
  if (resolvedScope === 'category') {
    queries = [...descriptors.map((d) => `${d} ${productType}`), productType, ...vlmQueries];
  } else {
    queries = [
      model && `${brand} ${model}`,
      model && productType && `${brand} ${model} ${productType}`,
      productType && `${brand} ${productType}`,
      ...vlmQueries,
      brand,
    ];
  }
  queries = unique(queries.filter(Boolean).map((q) => q.replace(/\s+/g, ' ').trim())).slice(0, 8);

  const brandKey = toTag(brand || '').slice(0, 5);
  const accounts = resolvedScope === 'category' ? [] : unique((suggestions.instagramHandles || []).map(cleanHandle))
    .filter((handle) => brandKey.length >= 3 && handle.replace(/[._]/g, '').includes(brandKey))
    .slice(0, 2);

  const terms = {
    brand: unique([lower(brand), toTag(brand || ''), ...accounts]).filter((t) => t && t.length >= 3),
    model: modelLower ? unique([modelLower, ...modelLower.split(' ').filter((w) => w.length >= 4)]) : [],
    type: productType ? unique([productType, `${productType}s`, ...(productType === 'tumbler' ? ['tumblers'] : [])]) : [],
  };
  const specificName = [brand, model, productType].filter(Boolean).join(' ') || title;
  const prompts = {
    specific: `a photo of a ${specificName}`,
    category: `a photo of a ${productType || title}`,
  };
  return { scope: resolvedScope, brand, model, productType, queries, hashtags, accounts, terms, prompts };
}
