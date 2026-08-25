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

import { classifyHomepage } from './classify';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname, searchParams } = new URL(request.url);
		console.log(`[fetch] ${request.method} ${pathname}`);

		if (request.method === 'GET' && pathname === '/classify') {
			const target = searchParams.get('url');
			if (!target) {
				return new Response('Missing ?url= query parameter', { status: 400 });
			}

			try {
				const result = await classifyHomepage(target, env);
				return Response.json(result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return Response.json({ error: message, url: target }, { status: 502 });
			}
		}

		console.log(`pathname = ${pathname}`);
		return new Response("Hello World!");
	},
} satisfies ExportedHandler<Env>;
