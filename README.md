# Product Video Discovery Dashboard

Discover and review product-related video creatives from Instagram Reels and the Meta Ad Library. Enter a product keyword or product-page URL, optionally add a product image, and the dashboard collects candidate videos, scores their relevance, removes duplicates, and explains why each result was ranked.

> **Important:** Source availability and free-tier quotas vary. A search can return partial results when a source reaches its limit. Fetched candidates are not the same as verified product matches.

## Features

- **Flexible input:** Search by product name, product-page URL, or optional image upload.
- **Instagram Reels discovery:** Collect candidate Reels using configured Apify actors.
- **Meta Ad Library discovery:** Collect candidate video ads through the configured source.
- **Product-aware relevance:** Use CLIP-based local ranking with optional Gemini vision-language verification.
- **Explainable results:** Display relevance scores, match status, and reasons for ranking.
- **Duplicate detection:** Identify duplicate and visually similar videos.
- **Live progress:** Track search stages and per-source progress in the dashboard.
- **Search history:** Store search results and status locally using SQLite.
- **Demo mode:** Test the interface with clearly labelled synthetic results without live source credentials.

## How It Works

1. The user enters a product keyword or URL and can upload a reference image.
2. The backend resolves product information and prepares a search plan.
3. The configured Instagram and Meta sources collect candidate videos.
4. The application scores candidates using available product and visual evidence.
5. Duplicate handling removes repeated or near-identical candidates.
6. Optional Gemini vision-language verification evaluates selected candidates.
7. The dashboard presents ranked results, explanations, and search progress.

## Technology Stack

| Component | Technology |
|---|---|
| Frontend | React, Vite, JavaScript, CSS |
| Backend | Node.js, Express, JavaScript ES modules |
| Visual similarity | Transformers.js, CLIP, Sharp |
| Vision-language verification | Google Gemini API |
| Video discovery | Apify actors for Instagram and Meta Ad Library |
| Database | SQLite and `better-sqlite3` |
| Progress updates | Server-Sent Events (SSE) |
| Testing | Node.js test runner and frontend/browser checks |

## Requirements

- Node.js 22 or a compatible project-supported version
- npm
- Git
- An Apify API token for live Instagram and Meta collection
- A Google AI Studio Gemini API key for Gemini-based verification, when enabled

You can use demo mode without live provider credentials. Live collection and AI verification depend on provider access, configuration, and usage quotas.

## Installation and Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/product-video-discovery-dashboard.git
cd product-video-discovery-dashboard
```

Replace `YOUR_USERNAME` with your GitHub username.

### 2. Configure the backend

Open a terminal in the repository root:

```powershell
cd backend
Copy-Item .env.example .env
notepad .env
```

Add your own provider credentials to `backend/.env`. For example:

```env
DEMO_MODE=false
APIFY_TOKEN=your_apify_token
GEMINI_ENDPOINT=aistudio
GEMINI_API_KEY=your_gemini_api_key
VLM_VERIFY=true
MATCH_THRESHOLD=55
```

Keep the other settings from `.env.example` unless you need to change them.

**Security:** Never commit your actual `.env` file or expose API keys in screenshots, logs, videos, or public repositories.

### 3. Install backend dependencies

Run these commands from the `backend` directory:

```powershell
npm install
npm test
npm run dev
```

Keep the backend terminal running. By default, the server listens on port `4000`.

### 4. Start the frontend

Open a second terminal from the repository root:

```powershell
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite, usually:

[http://localhost:5173](http://localhost:5173)

### 5. Check backend health

In another PowerShell window, run:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/api/health |
ConvertTo-Json -Depth 6
```

Review the source and vision configuration. Restart the backend whenever you change `.env`.

## Demo Mode

To explore the interface without making live source requests, set:

```env
DEMO_MODE=true
```

Restart the backend and use the frontend as usual.

Demo records are synthetic. They must not be represented as live Instagram or Meta results, or as evidence of real-world matching accuracy.

To resume live collection, configure the required provider credentials and set `DEMO_MODE=false`.

## Configuration

The backend loads environment variables from `backend/.env`.

| Variable | Purpose |
|---|---|
| `DEMO_MODE` | Enables synthetic demonstration data when set to `true`. |
| `APIFY_TOKEN` | Authenticates live collection through Apify. |
| `GEMINI_API_KEY` | Enables Gemini-based visual analysis. |
| `GEMINI_ENDPOINT` | Selects the Gemini endpoint; use `aistudio` for a Google AI Studio API key. |
| `GEMINI_MODEL` | Selects the Gemini model to request. |
| `VLM_VERIFY` | Enables vision-language verification when configured. |
| `MATCH_THRESHOLD` | Sets the relevance threshold. |
| `MIN_RESULTS_PER_SOURCE` | Sets the target number of accepted results per source. |
| `JOB_CONCURRENCY` | Controls concurrent search jobs. |

The target result count is not guaranteed. Source availability, filtering, deduplication, timeouts, and provider quotas can reduce the final number of results.

Apify and Gemini have separate usage limits. Lowering retries and concurrency can reduce repeated calls, but it cannot restore exhausted credits or quotas.

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/search` | Starts a search using a query and optional image. |
| `GET` | `/api/search/:id` | Retrieves the status and results of a search. |
| `GET` | `/api/search/:id/events` | Streams search progress using Server-Sent Events. |
| `GET` | `/api/history?limit=50` | Lists recent searches. |
| `GET` | `/api/health` | Reports source and vision configuration. |
| `GET` | `/media/products/*` | Serves cached product images. |
| `GET` | `/media/thumbs/*` | Serves cached video thumbnails. |

Errors are returned using a JSON response containing an error code and message.

## Tests and Verification

### Backend tests

Run from `backend/`:

```powershell
npm test
```

### Frontend production build

Run from `frontend/`:

```powershell
npm run build
```

### Frontend stage-status tests

Run from `frontend/`:

```powershell
node --test src/components/stageStatus.test.js
```

### CLIP verification

Run from `backend/`:

```powershell
npm run verify:clip
```

### Source verification

Run from `backend/`:

```powershell
npm run verify:sources -- --schema
```

This check may require a valid Apify token.

### Live search evaluation

Run from `backend/`:

```powershell
node scripts/live-check.mjs "A product name" --image "C:\path\to\product.jpg"
```

This command uses live provider resources and may consume usage quota. Run live evaluations sparingly.

Record the product input, date, source counts, accepted candidates, visual-verification outcomes, errors, and manual relevance judgments. Only report results that were actually observed.

## Evaluation

The project should be evaluated using five different product searches. For each search, record:

- Product name and reference image, if used
- Number of candidates fetched from Instagram
- Number of candidates fetched from Meta
- Number of relevant matches after filtering
- Number of duplicates removed, if available
- Gemini verification status
- Provider errors or quota interruptions
- Manual assessment of the final matches

Store the actual results in `evaluation/results.md`.

Do not invent missing measurements or substitute synthetic demo data for live evaluation evidence. Explain any incomplete searches and their limitations.

## Repository Structure

```text
.
├── backend/
│   ├── src/
│   │   ├── brain/        # Product analysis, scoring, CLIP and VLM
│   │   ├── db/           # SQLite schema and repository layer
│   │   ├── http/         # Request helpers and safety handling
│   │   ├── pipeline/     # Search orchestration and deduplication
│   │   ├── product/      # Product-page extraction
│   │   ├── routes/       # HTTP routes
│   │   └── sources/      # Apify, Instagram, Meta and demo adapters
│   ├── scripts/          # Verification and evaluation scripts
│   ├── test/             # Backend tests
│   └── .env.example      # Safe environment template
├── frontend/
│   └── src/              # React application and components
├── e2e/                  # Browser checks
├── evaluation/           # Evaluation records and reports
├── docs/                 # Project and verification notes
├── .gitignore
└── README.md
```

## Limitations

- The target of 20 results per source depends on availability, filtering, deduplication, timeouts, and provider quotas.
- A fetched candidate is not necessarily a verified exact-product match.
- Without successful vision-language verification, claims about exact logos and on-product text are less reliable.
- Gemini can be rate-limited, unavailable for a particular model, or subject to request timeouts.
- Instagram video URLs may expire, and automated product-page fetching may fail on some sites.
- Cached thumbnails do not guarantee that the original video remains accessible.
- SQLite and the in-process job queue are designed for local or single-instance use.

## Security

- Keep API keys in `backend/.env`.
- Commit `backend/.env.example` with placeholders, never actual credentials.
- Ensure `.env`, local databases, private logs, and generated local data are excluded by `.gitignore`.
- Rotate any credential accidentally committed or shared publicly.
- Review `git status` and staged changes before every push.

## Future Improvements

- Improve visual verification and confidence calibration.
- Expand duplicate detection and source coverage.
- Improve resilience to provider timeouts and quota exhaustion.
- Add more comprehensive evaluation metrics and reproducible test reports.
- Improve reporting for partial results and failed source collection.

## License

Add the license required by the project owner or assignment before publishing the repository.