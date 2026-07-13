/**
 * Seed script: reads the IAB Content Taxonomy TSV, generates embeddings via
 * the Cloudflare Workers AI REST API, and writes results to NDJSON.
 *
 * Run from the project root:
 *   npx tsx scripts/seed-taxonomy.ts
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';

// ---------------------------------------------------------------------------
// Fixed paths (not configurable via environment variables)
// ---------------------------------------------------------------------------

const TAXONOMY_TSV_PATH = 'data/content-taxonomy-3.1.tsv';
const OUTPUT_NDJSON_PATH = 'data/vectors.ndjson';

// ---------------------------------------------------------------------------
// Load .env before reading process.env
// ---------------------------------------------------------------------------

dotenv.config();

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL as string;
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS);
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID as string;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN as string;

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

type TaxonomyRow = {
	id: string;
	parentId: string;
	name: string;
	tier1: string;
	description: string;
};

type EmbeddingResult = {
	id: string;
	values: number[];
	metadata: {
		name: string;
		parentId: string;
		tier1: string;
		description: string;
	};
};

/** Shape of the Cloudflare Workers AI embedding API response. */
type CloudflareAiEmbeddingResponse = {
	success: boolean;
	result: {
		data: number[][];
	};
	errors: { message: string }[];
};

type FailedRow = {
	id: string;
	name: string;
	reason: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse the IAB taxonomy TSV.
 * Line 1 is a banner row, line 2 is the column header — both are skipped.
 * Handles \r\n line endings and trims trailing \r from the last column.
 */
function parseTaxonomyTsv(content: string): TaxonomyRow[] {
	const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

	// Skip banner row (index 0) and header row (index 1)
	const dataLines = lines.slice(2);

	return dataLines.map((line) => {
		const cols = line.split('\t');

		// Trim trailing \r from the last column (common with \r\n files)
		if (cols.length > 0) {
			cols[cols.length - 1] = cols[cols.length - 1].replace(/\r$/, '');
		}

		const [id, parentId, name, tier1, tier2, tier3, tier4] = cols;

		// Build description from non-empty tier columns joined with " > "
		const tiers = [tier1, tier2, tier3, tier4].filter((t) => t && t.trim() !== '');
		const description = tiers.join(' > ');

		return {
			id: id.trim(),
			parentId: (parentId ?? '').trim(),
			name: name.trim(),
			tier1: tier1.trim(),
			description,
		};
	});
}

/**
 * Call the Cloudflare Workers AI REST API to embed a single text string.
 * Retries up to 3 times on HTTP 429 (rate limit) with exponential backoff.
 * Returns null if all retries are exhausted.
 */
async function embedText(text: string): Promise<number[] | null> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;
	const maxRetries = 3;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ text: [text] }),
		});

		// Rate limited — wait and retry
		if (response.status === 429 && attempt < maxRetries) {
			const delayMs = Math.pow(2, attempt) * 1000;
			console.warn(`Rate limited (429). Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
			await sleep(delayMs);
			continue;
		}

		if (response.status === 429) {
			return null;
		}

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`API request failed (${response.status}): ${body}`);
		}

		const json = (await response.json()) as CloudflareAiEmbeddingResponse;

		if (!json.success || !json.result?.data?.[0]) {
			throw new Error(`Unexpected API response for "${text}": ${JSON.stringify(json)}`);
		}

		const vector = json.result.data[0];

		// Fail fast if dimensions don't match — prevents writing bad vectors
		if (vector.length !== EMBEDDING_DIMENSIONS) {
			throw new Error(
				`Model ${EMBEDDING_MODEL} returned ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. Check your .env or your Vectorize index config.`,
			);
		}

		return vector;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	// Step 1: Read and parse the TSV file
	console.log(`Reading taxonomy from ${TAXONOMY_TSV_PATH}...`);
	const tsvContent = await readFile(TAXONOMY_TSV_PATH, 'utf-8');
	const rows = parseTaxonomyTsv(tsvContent);
	const total = rows.length;
	console.log(`Found ${total} taxonomy rows to embed.`);

	// Prepare a fresh output file
	await writeFile(OUTPUT_NDJSON_PATH, '');

	const failed: FailedRow[] = [];
	let processed = 0;

	// Step 2–8: Process each row sequentially — embed, validate, write
	for (const row of rows) {
		const textToEmbed = `${row.name}: ${row.description}`;

		try {
			const values = await embedText(textToEmbed);

			if (values === null) {
				failed.push({ id: row.id, name: row.name, reason: 'Rate limited (429) after 3 retries' });
				console.warn(`[skip] ${row.id} — ${row.name}: rate limited (429) after 3 retries`);
				continue;
			}

			const result: EmbeddingResult = {
				id: row.id,
				values,
				metadata: {
					name: row.name,
					parentId: row.parentId,
					tier1: row.tier1,
					description: row.description,
				},
			};

			// Append one NDJSON line immediately — don't buffer in memory
			await appendFile(OUTPUT_NDJSON_PATH, JSON.stringify(result) + '\n');

			processed++;
			console.log(`[${processed}/${total}] ${row.id} — ${row.name}: ${row.description}`);
			console.log(`  embedding (${values.length}d):`, values);
		} catch (error) {
			// Dimension mismatches are fatal — stop immediately rather than writing bad vectors
			if (
				error instanceof Error &&
				error.message.includes('dimensions, expected')
			) {
				throw error;
			}

			const reason = error instanceof Error ? error.message : String(error);
			failed.push({ id: row.id, name: row.name, reason });
			console.warn(`[skip] ${row.id} — ${row.name}: ${reason}`);
			continue;
		}
	}

	// Step 9: Print summary
	console.log('\n--- Summary ---');
	console.log(`Total rows processed: ${processed}/${total}`);
	console.log(`Output written to: ${OUTPUT_NDJSON_PATH}`);

	if (failed.length > 0) {
		console.log(`\nFailed rows (${failed.length}):`);
		for (const f of failed) {
			console.log(`  [${f.id}] ${f.name} — ${f.reason}`);
		}
	} else {
		console.log('All rows embedded successfully.');
	}
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
