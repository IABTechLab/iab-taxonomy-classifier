export type ScrapedContent = {
	url: string;
	title: string;
	description: string;
	headings: string;
	combinedText: string; // title + description + headings + truncated body, joined
};

/** Collapse runs of whitespace to a single space and trim ends. */
function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/**
 * Append a text-node chunk with a trailing space so adjacent HTML elements
 * (e.g. </h1><p>) don't glue together when the source has no whitespace.
 */
function appendTextChunk(target: string, chunk: string): string {
	if (!chunk) return target;
	return target + chunk + ' ';
}

/** Prefix https:// when the caller passes a bare hostname or path-less domain. */
function normalizeUrl(url: string): string {
	const trimmed = url.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		return trimmed;
	}
	return `https://${trimmed}`;
}

/**
 * Fetch a homepage and extract text signal suitable for embedding.
 *
 * @param url - Page URL to scrape (http/https optional; bare domains get https://)
 * @param maxBodyChars - Maximum body text characters to include in combinedText.
 *   Defaults to 6000; callers can raise or lower it per request.
 */
export async function scrapeHomepage(
	url: string,
	maxBodyChars: number = 6000,
): Promise<ScrapedContent> {
	const normalizedUrl = normalizeUrl(url);

	// Step 2: Fetch with timeout, bot User-Agent, and redirect following
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 8000);

	let response: Response;
	try {
		response = await fetch(normalizedUrl, {
			signal: controller.signal,
			headers: {
				'User-Agent': 'IABTaxonomyClassifierBot/1.0',
			},
			cf: { redirect: 'follow' },
		});
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error(`Request timed out after 8 seconds: ${normalizedUrl}`);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Network error fetching ${normalizedUrl}: ${message}`);
	} finally {
		clearTimeout(timeoutId);
	}

	// Step 3: Fail on non-2xx responses — no partial results
	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${normalizedUrl}: HTTP ${response.status} ${response.statusText}`,
		);
	}

	// Step 4: Only parse HTML responses
	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.includes('text/html')) {
		throw new Error(
			`Expected text/html from ${normalizedUrl}, got content-type: ${contentType || '(missing)'}`,
		);
	}

	// Step 5: Extract text via HTMLRewriter
	let title = '';
	let description = '';
	let descriptionFound = false;
	const headingTexts: string[] = [];
	let currentHeading: string | null = null;
	let bodyText = '';

	const rewriter = new HTMLRewriter();

	// Strip noisy elements FIRST so their text never reaches the body handler.
	// HTMLRewriter processes the document in order; removing these tags early
	// prevents script/style/noscript/iframe contents from being collected as body text.
	for (const tag of ['script', 'style', 'noscript', 'iframe'] as const) {
		rewriter.on(tag, {
			element(element) {
				element.remove();
			},
		});
	}

	rewriter.on('title', {
		text(text) {
			title = appendTextChunk(title, text.text);
		},
	});

	// Use whichever meta description appears first in the document
	const metaDescriptionHandler = {
		element(element: Element) {
			if (descriptionFound) return;
			const content = element.getAttribute('content');
			if (content) {
				description = content;
				descriptionFound = true;
			}
		},
	};

	rewriter.on('meta[name="description"]', metaDescriptionHandler);
	rewriter.on('meta[property="og:description"]', metaDescriptionHandler);

	// Collect h1/h2/h3 text in document order, joined later with " | "
	const headingHandler = {
		element(element: Element) {
			currentHeading = '';
			element.onEndTag(() => {
				if (currentHeading !== null) {
					const collapsed = collapseWhitespace(currentHeading);
					if (collapsed) headingTexts.push(collapsed);
				}
				currentHeading = null;
			});
		},
		text(text: Text) {
			if (currentHeading !== null) {
				currentHeading = appendTextChunk(currentHeading, text.text);
			}
		},
	};

	rewriter.on('h1', headingHandler);
	rewriter.on('h2', headingHandler);
	rewriter.on('h3', headingHandler);

	rewriter.on('body', {
		text(text) {
			bodyText = appendTextChunk(bodyText, text.text);
		},
	});

	// Step 6: Drain the response stream so all handlers fire
	const transformed = rewriter.transform(response);
	await transformed.text();

	// Step 7: Normalize whitespace on every collected field
	title = collapseWhitespace(title);
	description = collapseWhitespace(description);
	const headings = headingTexts.join(' | ');
	bodyText = collapseWhitespace(bodyText);

	// Step 8: Cap body text length; title/description/headings stay uncapped
	const truncatedBody =
		bodyText.length > maxBodyChars ? bodyText.slice(0, maxBodyChars) : bodyText;

	// Step 9: Join non-empty sections with blank lines
	const combinedText = [title, description, headings, truncatedBody]
		.filter((section) => section.length > 0)
		.join('\n\n');

	return {
		url: normalizedUrl,
		title,
		description,
		headings,
		combinedText,
	};
}
