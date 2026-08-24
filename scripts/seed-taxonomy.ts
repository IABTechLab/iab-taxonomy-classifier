/**
 * Seed script: reads the IAB Content Taxonomy TSV, generates embeddings via
 * the Cloudflare Workers AI REST API, and writes results to NDJSON.
 *
 * Run from the project root:
 *   npx tsx scripts/seed-taxonomy.ts
 *   npx tsx scripts/seed-taxonomy.ts --model=@cf/baai/bge-base-en-v1.5 --dimensions=768
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import {
	parseTaxonomyTsv,
	embedText as embedTextWithOptions,
	taxonomyVectorsPathForModel,
	DEFAULT_EMBEDDING_MODEL,
	DEFAULT_EMBEDDING_DIMENSIONS,
} from './lib/workers-ai';

// ---------------------------------------------------------------------------
// Fixed paths (not configurable via environment variables)
// ---------------------------------------------------------------------------

const TAXONOMY_TSV_PATH = 'data/content-taxonomy-3.1.tsv';

// ---------------------------------------------------------------------------
// Load .env before reading process.env
// ---------------------------------------------------------------------------

dotenv.config();

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID as string;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN as string;

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

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

type FailedRow = {
	id: string;
	name: string;
	reason: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
	const modelArg = process.argv.find((a) => a.startsWith('--model='));
	const dimensionsArg = process.argv.find((a) => a.startsWith('--dimensions='));

	return {
		model: modelArg ? modelArg.split('=')[1] : DEFAULT_EMBEDDING_MODEL,
		dimensions: dimensionsArg ? Number(dimensionsArg.split('=')[1]) : DEFAULT_EMBEDDING_DIMENSIONS,
	};
}

function embedText(text: string, model: string, dimensions: number): Promise<number[] | null> {
	return embedTextWithOptions(text, {
		model,
		dimensions,
		accountId: CLOUDFLARE_ACCOUNT_ID,
		apiToken: CLOUDFLARE_API_TOKEN,
	});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
		console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env');
		process.exit(1);
	}

	const { model, dimensions } = parseArgs();
	// Named by model so vectors from different embedding models never collide —
	// matches the cache naming in scripts/classify-synthetic-data.ts.
	const outputPath = taxonomyVectorsPathForModel(model);

	console.log(`Model: ${model} (${dimensions}d)`);

	// Step 1: Read and parse the TSV file
	console.log(`Reading taxonomy from ${TAXONOMY_TSV_PATH}...`);
	const tsvContent = await readFile(TAXONOMY_TSV_PATH, 'utf-8');
	const rows = parseTaxonomyTsv(tsvContent);
	const total = rows.length;
	console.log(`Found ${total} taxonomy rows to embed.`);

	// Prepare a fresh output file
	await writeFile(outputPath, '');

	const failed: FailedRow[] = [];
	let processed = 0;

	// Step 2–8: Process each row sequentially — embed, validate, write
	for (const row of rows) {
		const textToEmbed = `${row.name}: ${row.description}`;

		try {
			const values = await embedText(textToEmbed, model, dimensions);

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
			await appendFile(outputPath, JSON.stringify(result) + '\n');

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
	console.log(`Output written to: ${outputPath}`);

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
