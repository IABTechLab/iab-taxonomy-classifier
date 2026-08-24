/**
 * Shared helpers for calling the Cloudflare Workers AI REST API and parsing
 * the IAB taxonomy TSV. Used by scripts/seed-taxonomy.ts and
 * scripts/classify-synthetic-data.ts so both stay consistent as models change.
 */

export type TaxonomyRow = {
	id: string;
	parentId: string;
	name: string;
	tier1: string;
	description: string;
};

/** Shape of the Cloudflare Workers AI embedding API response. */
type CloudflareAiEmbeddingResponse = {
	success: boolean;
	result: {
		data: number[][];
	};
	errors: { message: string }[];
};

export type EmbedTextOptions = {
	model: string;
	dimensions: number;
	accountId: string;
	apiToken: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse the IAB taxonomy TSV.
 * Line 1 is a banner row, line 2 is the column header — both are skipped.
 * Handles \r\n line endings and trims trailing \r from the last column.
 */
export function parseTaxonomyTsv(content: string): TaxonomyRow[] {
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
export async function embedText(text: string, options: EmbedTextOptions): Promise<number[] | null> {
	const { model, dimensions, accountId, apiToken } = options;
	const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
	const maxRetries = 3;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiToken}`,
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
		if (vector.length !== dimensions) {
			throw new Error(
				`Model ${model} returned ${vector.length} dimensions, expected ${dimensions}. Check your .env or your Vectorize index config.`,
			);
		}

		return vector;
	}

	return null;
}

/** Turn a Workers AI model id (e.g. "@cf/google/embeddinggemma-300m") into a filesystem-safe slug. */
export function modelSlug(model: string): string {
	return model
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Cosine similarity between two equal-length vectors, in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
