/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { scrapeHomepage } from './scrape';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname, searchParams } = new URL(request.url);

		// TEMPORARY: local scraper testing only — remove or gate behind an env check before production deploy.
		if (request.method === 'GET' && pathname === '/debug-scrape') {
			const target = searchParams.get('url');
			if (!target) {
				return new Response('Missing ?url= query parameter', { status: 400 });
			}

			try {
				const result = await scrapeHomepage(target);
				return Response.json(result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return Response.json({ error: message, url: target }, { status: 502 });
			}
		}

		return new Response("Hello World!");
	},
} satisfies ExportedHandler<Env>;
