# Brain benchmark

Generated 2026-10-27T10:25:04.615Z with `npm run benchmark:brain`.
Backend: **basic** (fallback: VISION_BACKEND=basic).
Images: https://hydrogen-preview.myshopify.com (Shopify's public demo catalogue). Reference = packshot. Exact = other photos of the same board.
Similar = other boards (in-scene photos and packshots). Unrelated = wax products.

| Class | n | Mean | Min | Max | Accepted at threshold 55 |
|--|--|--|--|--|--|
| exact | 16 | 49 | 18 | 76 | 44% |
| similar | 64 | 61 | 21 | 92 | 70% |
| unrelated | 16 | 39 | 26 | 47 | 0% |

- Top-1 retrieval (an exact photo ranked first among that reference's candidates): **3/8**
- Best single threshold on this set: **68** (balanced accuracy 54%)

## All scores

| Reference | Class | Candidate | Score | CLIP cosine | Claude | Explanation |
|--|--|--|--|--|--|--|
| the-red-hydrogen-snowboard | exact | the-red-hydrogen-snowboard photo 2 | 18 | -0.026 | - | Very weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 33% |
| the-red-hydrogen-snowboard | exact | the-red-hydrogen-snowboard photo 3 | 20 | 0.066 | - | Very weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 36% |
| the-red-hydrogen-snowboard | similar | the-zenith in-scene photo | 22 | 0.108 | - | Very weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 40% |
| the-red-hydrogen-snowboard | similar | the-xtreme in-scene photo | 23 | 0.025 | - | Very weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 42% |
| the-red-hydrogen-snowboard | similar | the-wildfire in-scene photo | 21 | 0.059 | - | Very weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 39% |
| the-red-hydrogen-snowboard | similar | the-ultimatum in-scene photo | 23 | 0.019 | - | Very weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 43% |
| the-red-hydrogen-snowboard | similar | the-thunderbolt in-scene photo | 24 | 0.016 | - | Very weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 43% |
| the-red-hydrogen-snowboard | similar | the-storm in-scene photo | 21 | 0.113 | - | Very weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 39% |
| the-red-hydrogen-snowboard | similar | the-stealth packshot | 25 | -0.104 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 45% |
| the-red-hydrogen-snowboard | similar | the-savage packshot | 29 | -0.07 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 54% |
| the-red-hydrogen-snowboard | unrelated | shopify-retro-wax | 35 | 0.273 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 55% |
| the-red-hydrogen-snowboard | unrelated | shopify-wax | 42 | 0.275 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 67% |
| the-zenith | exact | the-zenith photo 2 | 36 | 0.065 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 66% |
| the-zenith | exact | the-zenith photo 3 | 73 | 0.706 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 74% |
| the-zenith | similar | the-xtreme in-scene photo | 77 | 0.761 | - | Strong visual match: basic structure similarity strong (CLIP unavailable), colour overlap 74% |
| the-zenith | similar | the-wildfire in-scene photo | 74 | 0.746 | - | Moderate visual match: basic structure similarity strong (CLIP unavailable), colour overlap 70% |
| the-zenith | similar | the-ultimatum in-scene photo | 75 | 0.75 | - | Strong visual match: basic structure similarity strong (CLIP unavailable), colour overlap 72% |
| the-zenith | similar | the-thunderbolt in-scene photo | 77 | 0.763 | - | Strong visual match: basic structure similarity strong (CLIP unavailable), colour overlap 74% |
| the-zenith | similar | the-storm in-scene photo | 70 | 0.703 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 69% |
| the-zenith | similar | the-stealth in-scene photo | 69 | 0.71 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 66% |
| the-zenith | similar | the-savage packshot | 87 | 0.976 | - | Strong visual match: basic structure similarity strong (CLIP unavailable), colour overlap 77% |
| the-zenith | similar | the-revolution packshot | 92 | 0.922 | - | Strong visual match: basic structure similarity strong (CLIP unavailable), colour overlap 85% |
| the-zenith | unrelated | shopify-retro-wax | 43 | 0.352 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 61% |
| the-zenith | unrelated | shopify-wax | 47 | 0.347 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 69% |
| the-xtreme | exact | the-xtreme photo 2 | 40 | -0.016 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 73% |
| the-xtreme | exact | the-xtreme photo 3 | 76 | 0.74 | - | Strong visual match: basic structure similarity strong (CLIP unavailable), colour overlap 75% |
| the-xtreme | similar | the-wildfire in-scene photo | 74 | 0.732 | - | Moderate visual match: basic structure similarity strong (CLIP unavailable), colour overlap 72% |
| the-xtreme | similar | the-ultimatum in-scene photo | 75 | 0.729 | - | Moderate visual match: basic structure similarity strong (CLIP unavailable), colour overlap 74% |
| the-xtreme | similar | the-thunderbolt in-scene photo | 76 | 0.741 | - | Strong visual match: basic structure similarity strong (CLIP unavailable), colour overlap 76% |
| the-xtreme | similar | the-storm in-scene photo | 70 | 0.7 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 70% |
| the-xtreme | similar | the-stealth in-scene photo | 70 | 0.704 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 68% |
| the-xtreme | similar | the-savage in-scene photo | 74 | 0.724 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 73% |
| the-xtreme | similar | the-revolution packshot | 92 | 0.939 | - | Strong visual match: basic structure similarity strong (CLIP unavailable), colour overlap 85% |
| the-xtreme | similar | the-quicksilver packshot | 51 | 0.729 | - | Moderate visual match: basic structure similarity strong (CLIP unavailable), colour overlap 31% |
| the-xtreme | unrelated | shopify-retro-wax | 41 | 0.369 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 55% |
| the-xtreme | unrelated | shopify-wax | 43 | 0.365 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 59% |
| the-wildfire | exact | the-wildfire photo 2 | 30 | -0.007 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 55% |
| the-wildfire | exact | the-wildfire photo 3 | 71 | 0.734 | - | Moderate visual match: basic structure similarity strong (CLIP unavailable), colour overlap 67% |
| the-wildfire | similar | the-ultimatum in-scene photo | 68 | 0.736 | - | Moderate visual match: basic structure similarity strong (CLIP unavailable), colour overlap 62% |
| the-wildfire | similar | the-thunderbolt in-scene photo | 71 | 0.747 | - | Moderate visual match: basic structure similarity strong (CLIP unavailable), colour overlap 65% |
| the-wildfire | similar | the-storm in-scene photo | 64 | 0.697 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 58% |
| the-wildfire | similar | the-stealth in-scene photo | 64 | 0.702 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 57% |
| the-wildfire | similar | the-savage in-scene photo | 66 | 0.724 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 59% |
| the-wildfire | similar | the-revolution in-scene photo | 66 | 0.706 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 61% |
| the-wildfire | similar | the-quicksilver packshot | 44 | 0.707 | - | Weak visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 20% |
| the-wildfire | similar | the-phoenix packshot | 44 | 0.707 | - | Weak visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 20% |
| the-wildfire | unrelated | shopify-retro-wax | 33 | 0.364 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 41% |
| the-wildfire | unrelated | shopify-wax | 35 | 0.359 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 45% |
| the-ultimatum | exact | the-ultimatum photo 2 | 39 | 0.066 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 72% |
| the-ultimatum | exact | the-ultimatum photo 3 | 70 | 0.666 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 74% |
| the-ultimatum | similar | the-thunderbolt in-scene photo | 71 | 0.676 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 73% |
| the-ultimatum | similar | the-storm in-scene photo | 67 | 0.639 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 70% |
| the-ultimatum | similar | the-stealth in-scene photo | 66 | 0.642 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 68% |
| the-ultimatum | similar | the-savage in-scene photo | 70 | 0.66 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 74% |
| the-ultimatum | similar | the-revolution in-scene photo | 69 | 0.644 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 73% |
| the-ultimatum | similar | the-quicksilver in-scene photo | 68 | 0.651 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 71% |
| the-ultimatum | similar | the-phoenix packshot | 54 | 0.712 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 38% |
| the-ultimatum | similar | the-odyssey packshot | 45 | 0.609 | - | Weak visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 34% |
| the-ultimatum | unrelated | shopify-retro-wax | 40 | 0.381 | - | Weak visual match: basic structure similarity weak (CLIP unavailable), colour overlap 51% |
| the-ultimatum | unrelated | shopify-wax | 45 | 0.376 | - | Weak visual match: basic structure similarity weak (CLIP unavailable), colour overlap 62% |
| the-thunderbolt | exact | the-thunderbolt photo 2 | 35 | -0.011 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 65% |
| the-thunderbolt | exact | the-thunderbolt photo 3 | 72 | 0.721 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 70% |
| the-thunderbolt | similar | the-storm in-scene photo | 66 | 0.684 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 63% |
| the-thunderbolt | similar | the-stealth in-scene photo | 65 | 0.688 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 61% |
| the-thunderbolt | similar | the-savage in-scene photo | 69 | 0.706 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 66% |
| the-thunderbolt | similar | the-revolution in-scene photo | 69 | 0.689 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 69% |
| the-thunderbolt | similar | the-quicksilver in-scene photo | 67 | 0.697 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 64% |
| the-thunderbolt | similar | the-phoenix in-scene photo | 66 | 0.691 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 62% |
| the-thunderbolt | similar | the-odyssey packshot | 49 | 0.661 | - | Weak visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 36% |
| the-thunderbolt | similar | the-nirvana-2 packshot | 54 | 0.604 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 50% |
| the-thunderbolt | unrelated | shopify-retro-wax | 46 | 0.396 | - | Weak visual match: basic structure similarity weak (CLIP unavailable), colour overlap 60% |
| the-thunderbolt | unrelated | shopify-wax | 44 | 0.392 | - | Weak visual match: basic structure similarity weak (CLIP unavailable), colour overlap 58% |
| the-storm | exact | the-storm photo 2 | 35 | 0.08 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 63% |
| the-storm | exact | the-storm photo 3 | 68 | 0.672 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 69% |
| the-storm | similar | the-stealth in-scene photo | 67 | 0.679 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 66% |
| the-storm | similar | the-savage in-scene photo | 70 | 0.703 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 69% |
| the-storm | similar | the-revolution in-scene photo | 68 | 0.685 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 66% |
| the-storm | similar | the-quicksilver in-scene photo | 69 | 0.689 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 69% |
| the-storm | similar | the-phoenix in-scene photo | 69 | 0.682 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 69% |
| the-storm | similar | the-odyssey in-scene photo | 67 | 0.701 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 63% |
| the-storm | similar | the-nirvana-2 packshot | 45 | 0.496 | - | Weak visual match: basic structure similarity weak (CLIP unavailable), colour overlap 47% |
| the-storm | similar | the-nirvana packshot | 45 | 0.494 | - | Weak visual match: basic structure similarity weak (CLIP unavailable), colour overlap 47% |
| the-storm | unrelated | shopify-retro-wax | 32 | 0.349 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 40% |
| the-storm | unrelated | shopify-wax | 42 | 0.345 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 60% |
| the-stealth | exact | the-stealth photo 2 | 30 | 0.041 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 55% |
| the-stealth | exact | the-stealth photo 3 | 69 | 0.67 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 70% |
| the-stealth | similar | the-savage in-scene photo | 67 | 0.694 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 64% |
| the-stealth | similar | the-revolution in-scene photo | 65 | 0.676 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 63% |
| the-stealth | similar | the-quicksilver in-scene photo | 67 | 0.682 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 65% |
| the-stealth | similar | the-phoenix in-scene photo | 67 | 0.673 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 67% |
| the-stealth | similar | the-odyssey in-scene photo | 66 | 0.691 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 62% |
| the-stealth | similar | the-nirvana-2 in-scene photo | 68 | 0.709 | - | Moderate visual match: basic structure similarity moderate (CLIP unavailable), colour overlap 64% |
| the-stealth | similar | the-nirvana packshot | 44 | 0.498 | - | Weak visual match: basic structure similarity weak (CLIP unavailable), colour overlap 45% |
| the-stealth | similar | the-mythos packshot | 42 | 0.531 | - | Weak visual match: basic structure similarity weak (CLIP unavailable), colour overlap 38% |
| the-stealth | unrelated | shopify-retro-wax | 26 | 0.338 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 32% |
| the-stealth | unrelated | shopify-wax | 35 | 0.334 | - | Weak visual match: basic structure similarity very weak (CLIP unavailable), colour overlap 48% |
