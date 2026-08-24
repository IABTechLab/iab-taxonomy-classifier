/**
 * Classifies each synthetic content sample against the IAB taxonomy, purely
 * offline: no URL is fetched and no Vectorize index is queried. This is an
 * evaluation script — it embeds every record in data/synthetic-content.ndjson
 * with a Workers AI embedding model, compares it against the (cached) taxonomy
 * embeddings for that same model via cosine similarity, and writes out the
 * top-N matches so classification quality can be checked against the known
 * ground-truth category.
 *
 * Run from the project root:
 *   npx tsx scripts/classify-synthetic-data.ts
 *   npx tsx scripts/classify-synthetic-data.ts --model=@cf/baai/bge-base-en-v1.5 --top-n=3 --min-score=0.6
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { parseTaxonomyTsv, embedText, modelSlug, cosineSimilarity } from './lib/workers-ai';

// ---------------------------------------------------------------------------
// Fixed paths (not configurable via environment variables)
// ---------------------------------------------------------------------------

const SYNTHETIC_CONTENT_PATH = 'data/synthetic-content.ndjson';
const TAXONOMY_TSV_PATH = 'data/content-taxonomy-3.1.tsv';

// Legacy path written by seed-taxonomy.ts — reused as-is when the requested
// model matches EMBEDDING_MODEL, so switching models doesn't force a
// re-embed of the taxonomy that's already been seeded.
const LEGACY_TAXONOMY_VECTORS_PATH = 'data/content-taxonomy-3.1-vectors.ndjson';
const LEGACY_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

const DEFAULT_MODEL = '@cf/google/embeddinggemma-300m';
const DEFAULT_TOP_N = 5;

/**
 * Minimum cosine similarity for a taxonomy match to be kept.
 *
 * embeddinggemma-300m's cosine scores run much lower than bge-base-en-v1.5's
 * (top-1 match score p10=0.34 / p50=0.45 / p90=0.56 across the synthetic
 * dataset, vs. bge's ~0.65 threshold in src/classify.ts). 0.3 keeps ~96% of
 * records with at least one match while dropping the weakest tail; sweeping
 * thresholds against data/synthetic-content.ndjson's known categories showed
 * 0.3 -> 90% top-5 accuracy, 0.4 -> 63%, 0.5 -> 23%. Re-tune if you change
 * models via --model=.
 */
const DEFAULT_MIN_SCORE = 0.3;
const CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Load .env before reading process.env
// ---------------------------------------------------------------------------

dotenv.config();

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID as string;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN as string;
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 768);

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

type TaxonomyVector = {
	id: string;
	values: number[];
	metadata: {
		name: string;
		parentId: string;
		tier1: string;
		description: string;
	};
};

type SyntheticRecord = {
	category_id: string;
	category_name: string;
	title: string;
	body: string;
	keywords?: string[];
};

type TaxonomyMatch = {
	id: string;
	name: string;
	score: number;
};

type ClassifiedRecord = {
	taxonomy_id: string;
	taxonomy_name: string;
	matches: TaxonomyMatch[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
	const modelArg = process.argv.find((a) => a.startsWith('--model='));
	const topNArg = process.argv.find((a) => a.startsWith('--top-n='));
	const minScoreArg = process.argv.find((a) => a.startsWith('--min-score='));
	const limitArg = process.argv.find((a) => a.startsWith('--limit='));

	return {
		model: modelArg ? modelArg.split('=')[1] : DEFAULT_MODEL,
		topN: topNArg ? parseInt(topNArg.split('=')[1], 10) : DEFAULT_TOP_N,
		minScore: minScoreArg ? Number(minScoreArg.split('=')[1]) : DEFAULT_MIN_SCORE,
		limit: limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined,
	};
}

function outputPathForModel(model: string): string {
	return `data/synthetic-content.classified.${modelSlug(model)}.ndjson`;
}

function taxonomyVectorsPathForModel(model: string): string {
	return `data/content-taxonomy-3.1-vectors.${modelSlug(model)}.ndjson`;
}

async function readNdjson<T>(path: string): Promise<T[]> {
	const raw = await readFile(path, 'utf-8');
	return raw
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** Embed every taxonomy row with `model` and cache the vectors at `outputPath`. */
async function generateTaxonomyVectors(model: string, outputPath: string): Promise<TaxonomyVector[]> {
	console.log(`No cached taxonomy vectors for ${model} — embedding ${TAXONOMY_TSV_PATH} now (one-time)...`);
	const tsvContent = await readFile(TAXONOMY_TSV_PATH, 'utf-8');
	const rows = parseTaxonomyTsv(tsvContent);

	await writeFile(outputPath, '');
	const vectors: TaxonomyVector[] = [];

	let processed = 0;
	for (const row of rows) {
		const values = await embedText(`${row.name}: ${row.description}`, {
			model,
			dimensions: EMBEDDING_DIMENSIONS,
			accountId: CLOUDFLARE_ACCOUNT_ID,
			apiToken: CLOUDFLARE_API_TOKEN,
		});

		if (values === null) {
			throw new Error(`Failed to embed taxonomy row ${row.id} (${row.name}) with model ${model} — rate limited after retries`);
		}

		const vector: TaxonomyVector = {
			id: row.id,
			values,
			metadata: { name: row.name, parentId: row.parentId, tier1: row.tier1, description: row.description },
		};
		vectors.push(vector);
		await appendFile(outputPath, JSON.stringify(vector) + '\n');

		processed++;
		if (processed % 50 === 0 || processed === rows.length) {
			console.log(`  embedded ${processed}/${rows.length} taxonomy rows`);
		}
	}

	console.log(`Cached ${vectors.length} taxonomy vectors to ${outputPath}`);
	return vectors;
}

/** Load taxonomy vectors for `model`, reusing a cache or the legacy seed output where possible. */
async function loadTaxonomyVectors(model: string): Promise<TaxonomyVector[]> {
	const legacyModel = process.env.EMBEDDING_MODEL || LEGACY_EMBEDDING_MODEL;

	if (model === legacyModel && fs.existsSync(LEGACY_TAXONOMY_VECTORS_PATH)) {
		console.log(`Using existing taxonomy vectors from ${LEGACY_TAXONOMY_VECTORS_PATH} (model ${model})`);
		return readNdjson<TaxonomyVector>(LEGACY_TAXONOMY_VECTORS_PATH);
	}

	const cachedPath = taxonomyVectorsPathForModel(model);
	if (fs.existsSync(cachedPath)) {
		console.log(`Using cached taxonomy vectors from ${cachedPath}`);
		return readNdjson<TaxonomyVector>(cachedPath);
	}

	return generateTaxonomyVectors(model, cachedPath);
}

function topMatches(
	contentVector: number[],
	taxonomyVectors: TaxonomyVector[],
	topN: number,
	minScore: number,
): TaxonomyMatch[] {
	return taxonomyVectors
		.map((tv) => ({ id: tv.id, name: tv.metadata.name, score: cosineSimilarity(contentVector, tv.values) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, topN)
		.filter((match) => match.score >= minScore);
}

async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<void> {
	let cursor = 0;
	async function worker() {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			await fn(items[index], index);
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
		console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env');
		process.exit(1);
	}

	const { model, topN, minScore, limit } = parseArgs();
	const outputPath = outputPathForModel(model);

	console.log(`Model: ${model}`);
	console.log(`Top-N: ${topN}, min score: ${minScore}`);

	const taxonomyVectors = await loadTaxonomyVectors(model);
	console.log(`Loaded ${taxonomyVectors.length} taxonomy vectors.`);

	let records = await readNdjson<SyntheticRecord>(SYNTHETIC_CONTENT_PATH);
	if (limit) records = records.slice(0, limit);
	const total = records.length;
	console.log(`Classifying ${total} synthetic content records...`);

	const outStream = fs.createWriteStream(outputPath, { flags: 'w' });

	let processed = 0;
	let skipped = 0;

	await pMap(records, CONCURRENCY, async (record) => {
		const text = `${record.title}\n\n${record.body}`;

		const values = await embedText(text, {
			model,
			dimensions: EMBEDDING_DIMENSIONS,
			accountId: CLOUDFLARE_ACCOUNT_ID,
			apiToken: CLOUDFLARE_API_TOKEN,
		});

		if (values === null) {
			console.warn(`[skip] ${record.category_id} — ${record.category_name}: rate limited after retries`);
			skipped++;
		} else {
			const classified: ClassifiedRecord = {
				taxonomy_id: record.category_id,
				taxonomy_name: record.category_name,
				matches: topMatches(values, taxonomyVectors, topN, minScore),
			};
			outStream.write(JSON.stringify(classified) + '\n');
		}

		processed++;
		if (processed % 25 === 0 || processed === total) {
			console.log(`${processed}/${total} processed (${skipped} skipped)`);
		}
	});

	await new Promise<void>((resolve) => outStream.end(resolve));

	console.log('\n--- Summary ---');
	console.log(`Classified: ${total - skipped}/${total} (${skipped} skipped)`);
	console.log(`Output written to: ${outputPath}`);
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
