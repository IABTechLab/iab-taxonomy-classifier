import { scrapeHomepage } from './scrape';

/** Metadata stored on taxonomy vectors during seeding (see scripts/seed-taxonomy.ts). */
export type TaxonomyVectorMetadata = {
	name: string;
	tier1: string;
	parentId?: string;
	description?: string;
};

/** A taxonomy category match returned to API clients. */
export type TaxonomyMatch = {
	id: string;
	score: number;
	name: string;
	tier1: string;
};

/** Compact { id, score } pair stored on content vectors to keep metadata small. */
export type StoredTopMatch = {
	id: string;
	score: number;
};

export type ClassifyResponse = {
	url: string;
	title: string;
	allMatches: TaxonomyMatch[];
	confidentMatches: TaxonomyMatch[];
	contentId: string;
};

/**
 * Minimum cosine similarity for a taxonomy match to be considered confident.
 *
 * 0.65 is a practical starting point for @cf/baai/bge-base-en-v1.5 on IAB
 * taxonomy labels: high enough to filter weak/noisy neighbors, low enough
 * that genuinely relevant categories are not dropped. Tune with real traffic.
 */
export const CONFIDENCE_THRESHOLD = 0.65;

type WorkersAiEmbeddingResult = {
	data: number[][];
};

function parseTaxonomyMatch(match: VectorizeMatch): TaxonomyMatch {
	const metadata = match.metadata ?? {};
	const name = typeof metadata.name === 'string' ? metadata.name : '';
	const tier1 = typeof metadata.tier1 === 'string' ? metadata.tier1 : '';

	return {
		id: match.id,
		score: match.score,
		name,
		tier1,
	};
}

function extractEmbeddingVector(result: unknown): number[] {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		Array.isArray((result as WorkersAiEmbeddingResult).data)
	) {
		const vector = (result as WorkersAiEmbeddingResult).data[0];
		if (!vector?.length) {
			throw new Error('Embedding model returned empty vector');
		}
		return vector;
	}

	throw new Error('Unexpected embedding model response shape');
}

/**
 * Derive a stable Vectorize document ID from a normalized page URL.
 *
 * SHA-256 over the normalized URL (hex-encoded) ensures the same homepage
 * always maps to the same ID, so repeated classifications upsert in place
 * instead of creating duplicate content vectors.
 */
async function contentIdFromUrl(normalizedUrl: string): Promise<string> {
	const encoded = new TextEncoder().encode(normalizedUrl);
	const digest = await crypto.subtle.digest('SHA-256', encoded);

	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export async function classifyHomepage(url: string, env: Env): Promise<ClassifyResponse> {
	const scraped = await scrapeHomepage(url);

	const embedding = await env.AI.run(env.EMBEDDING_MODEL, {
		text: [scraped.combinedText],
	});
	const vector = extractEmbeddingVector(embedding);

	const matches = await env.TAXONOMY_INDEX.query(vector, {
		topK: 5,
		returnMetadata: true,
	});

	const allMatches = matches.matches.map(parseTaxonomyMatch);
	const confidentMatches = allMatches.filter(
		(match) => match.score >= CONFIDENCE_THRESHOLD,
	);

	const contentId = await contentIdFromUrl(scraped.url);

	const topMatches: StoredTopMatch[] = allMatches.map(({ id, score }) => ({
		id,
		score,
	}));

	await env.CONTENT_INDEX.upsert([
		{
			id: contentId,
			values: vector,
			metadata: {
				url: scraped.url,
				scrapedAt: new Date().toISOString(),
				topMatches: JSON.stringify(topMatches),
			},
		},
	]);

	return {
		url: scraped.url,
		title: scraped.title,
		allMatches,
		confidentMatches,
		contentId,
	};
}
