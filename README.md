# IAB Taxonomy Classifier

A [Cloudflare Workers](https://developers.cloudflare.com/workers/) service that classifies websites using the [IAB Tech Lab Content Taxonomy](https://iabtechlab.com/standards/content-taxonomy/). The worker fetches a URL, analyzes its content with [Workers AI](https://developers.cloudflare.com/workers-ai/), and returns matching IAB content categories.

## Overview

The IAB Content Taxonomy is an industry-standard classification system for digital content. It provides a consistent vocabulary for categorizing publishers, pages, and apps across the advertising ecosystem — used in brand safety, contextual targeting, reporting, and supply-path transparency.

This project exposes that taxonomy as a simple HTTP API: send a website URL, get back IAB category labels (with IDs and confidence scores).

```
Client  →  Cloudflare Worker  →  Fetch page content
                             →  Workers AI embeddings
                             →  Vectorize similarity search
                             →  IAB Content Taxonomy labels
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (included as a dev dependency)

## Getting started

```bash
npm install
```

Log in to Cloudflare (first time only):

```bash
npx wrangler login
```

### Create the Vectorize indexes

Before running or deploying the worker, create the two [Vectorize](https://developers.cloudflare.com/vectorize/) indexes configured in `wrangler.jsonc`. Index names must match `index_name` for each binding.

**IAB content taxonomy** (`TAXONOMY_INDEX`) — stores embeddings for IAB taxonomy categories:

```bash
npx wrangler vectorize create iab-content-taxonomy --dimensions=768 --metric=cosine
```

**Classified content** (`CONTENT_INDEX`) — stores embeddings for previously classified page content:

```bash
npx wrangler vectorize create classified-content --dimensions=768 --metric=cosine
```

The 768 dimensions match the embedding model used by Workers AI. Cosine similarity is used to find the closest taxonomy categories for a given page.

### Seed the taxonomy

The worker needs vector embeddings for every IAB taxonomy category. A seed script reads the official taxonomy TSV, calls the Cloudflare Workers AI API to generate embeddings, and writes them to `data/vectors.ndjson`.

**1. Configure environment variables**

Copy `.env.example` to `.env` and fill in your Cloudflare credentials and embedding settings:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | API token with Workers AI permissions |
| `EMBEDDING_MODEL` | Workers AI embedding model (e.g. `@cf/baai/bge-base-en-v1.5`) |
| `EMBEDDING_DIMENSIONS` | Must match your Vectorize index dimensions (`768`) |

**2. Run the seed script**

The taxonomy file is already included at `data/content-taxonomy-3.1.tsv` (IAB Content Taxonomy v3.1). Run:

```bash
npm run seed-taxonomy
```

Or directly:

```bash
npx tsx scripts/seed-taxonomy.ts
```

The script processes each taxonomy row sequentially, embedding the category name and tier path (e.g. `Amusement and Theme Parks: Attractions > Amusement and Theme Parks`). Each entry and its embedding vector are logged to the console as it completes. Output is written incrementally to `data/vectors.ndjson` as newline-delimited JSON.

> **Note:** With ~700 categories and one API call per row, the full run takes several minutes. Rate-limit responses (HTTP 429) are retried automatically; any rows that still fail are listed in the summary at the end.

**3. Load embeddings into Vectorize**

Once `data/vectors.ndjson` has been generated, insert the vectors into the `iab-content-taxonomy` index:

```bash
npx wrangler vectorize insert iab-content-taxonomy --file=data/vectors.ndjson
```

Verify the import:

```bash
npx wrangler vectorize get iab-content-taxonomy
```

### Local development

```bash
npm run dev
```

The worker runs at `http://localhost:8787`.

### Test the scraper locally

A temporary debug route (`GET /debug-scrape`) lets you exercise the homepage scraper in isolation before wiring up classification.

**1. Start the dev server**

```bash
npx wrangler dev
```

**2. Scrape a URL**

```bash
curl "http://localhost:8787/debug-scrape?url=https://example.com" | jq
```

Returns JSON with `title`, `description`, `headings`, `combinedText`, and the normalized `url`. On failure, the route responds with `502` and an `{ error, url }` body.

> **Note:** Remove or gate the `/debug-scrape` route before deploying to production.

### Deploy

```bash
npm run deploy
```

## API

> The worker is under active development. The endpoints below describe the intended interface.

### Classify a URL

```
POST /classify
Content-Type: application/json

{
  "url": "https://example.com"
}
```

**Response**

```json
{
  "url": "https://example.com",
  "categories": [
    {
      "id": "123",
      "name": "Technology & Computing",
      "tier": 1,
      "confidence": 0.92
    }
  ]
}
```

### Health check

```
GET /
```

Returns a simple status response.

## Project structure

```
data/
  content-taxonomy-3.1.tsv   # Official IAB Content Taxonomy v3.1 (input)
  vectors.ndjson               # Generated taxonomy embeddings (output from seed script)
scripts/
  seed-taxonomy.ts             # Embeds taxonomy categories via Workers AI
src/
  index.ts                     # Worker entry point — request routing and classification logic
  scrape.ts                    # Homepage fetch and HTML text extraction
test/
  index.spec.ts                # Vitest tests (unit and integration via Miniflare)
wrangler.jsonc                 # Cloudflare Worker configuration
```

## Testing

```bash
npm test
```

Tests run with [Vitest](https://vitest.dev/) and the [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) pool, which executes workers in the Miniflare runtime.

## Related resources

- [IAB Tech Lab Content Taxonomy](https://iabtechlab.com/standards/content-taxonomy/)
- [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers AI documentation](https://developers.cloudflare.com/workers-ai/)
- [Cloudflare Vectorize documentation](https://developers.cloudflare.com/vectorize/)
- [Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/)

## License

See repository license. The IAB Content Taxonomy is maintained by [IAB Tech Lab](https://iabtechlab.com/).
