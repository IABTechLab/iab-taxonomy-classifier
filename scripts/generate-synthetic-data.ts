import "dotenv/config";
import fs from "node:fs";
import Anthropic, { APIError, AuthenticationError, PermissionDeniedError } from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

const TAXONOMY_PATH = "data/content-taxonomy-3.1-vectors.ndjson";
const OUTPUT_PATH = "data/synthetic-content.ndjson";
const FAILURES_PATH = "data/synthetic-content.failures.ndjson";
const DEFAULT_MODEL = "claude-haiku-4-5";
const CONCURRENCY = 8;

const SyntheticContentSchema = z.object({
  publisher_name: z
    .string()
    .describe("A plausible, entirely fictional publisher or website name"),
  title: z.string().describe("Headline/title for the page"),
  body: z
    .string()
    .describe("2-4 paragraphs of body content, 120-300 words"),
});

interface TaxonomyEntry {
  id: string;
  name: string;
  parentId: string;
  tier1: string;
  description: string;
}

interface SyntheticRecord {
  category_id: string;
  category_name: string;
  parent_id: string;
  tier1: string;
  taxonomy_path: string;
  publisher_name: string;
  title: string;
  body: string;
}

const SYSTEM_PROMPT = `You generate short, fictional synthetic web content used to build and evaluate a content-classification system based on the IAB Content Taxonomy 3.1. For a given taxonomy category, write one realistic snippet of publisher website content (a news article, blog post, product page, or forum post) that a classifier would confidently label under that exact category.

Rules:
- All publishers, people, organizations, products, and events must be entirely fictional. Never reference real people, brands, companies, or real-world news events.
- Write in a neutral, informational style appropriate for a mainstream publisher website.
- For categories under "Sensitive Topics", "Crime", "War and Conflicts", or other sensitive subject matter: describe the topic from a factual, third-person, non-graphic point of view (e.g. as a news report, policy discussion, age-verification notice, or informational page). Do not include graphic violence, explicit sexual content, hateful language, instructions for wrongdoing, or content that glorifies harm. The goal is topical relevance for classification, not graphic depiction.
- Keep the body between 120 and 300 words.
- Output only the requested structured fields.`;

function readTaxonomy(): TaxonomyEntry[] {
  const lines = fs.readFileSync(TAXONOMY_PATH, "utf-8").split("\n").filter(Boolean);
  return lines.map((line) => {
    const obj = JSON.parse(line);
    const m = obj.metadata ?? {};
    return {
      id: obj.id,
      name: m.name ?? "",
      parentId: m.parentId ?? "",
      tier1: m.tier1 ?? "",
      description: m.description ?? m.name ?? "",
    };
  });
}

function readDoneIds(): Set<string> {
  const done = new Set<string>();
  if (!fs.existsSync(OUTPUT_PATH)) return done;
  const lines = fs.readFileSync(OUTPUT_PATH, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.category_id) done.add(obj.category_id);
    } catch {
      // ignore malformed trailing line
    }
  }
  return done;
}

async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<void> {
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

async function generateForCategory(
  client: Anthropic,
  entry: TaxonomyEntry,
  model: string,
): Promise<SyntheticRecord | null> {
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Taxonomy category path: ${entry.description}\nCategory name: ${entry.name}\nTier 1: ${entry.tier1}\n\nGenerate one synthetic publisher webpage sample for this exact category.`,
      },
    ],
    output_format: betaZodOutputFormat(SyntheticContentSchema),
  });

  if (response.stop_reason === "refusal") {
    console.warn(`[refused] ${entry.id} ${entry.description}`);
    return null;
  }

  if (!response.parsed_output) {
    console.warn(`[unparsed] ${entry.id} ${entry.description}`);
    return null;
  }

  return {
    category_id: entry.id,
    category_name: entry.name,
    parent_id: entry.parentId,
    tier1: entry.tier1,
    taxonomy_path: entry.description,
    publisher_name: response.parsed_output.publisher_name,
    title: response.parsed_output.title,
    body: response.parsed_output.body,
  };
}

function isFatalAuthError(err: unknown): err is APIError {
  return err instanceof AuthenticationError || err instanceof PermissionDeniedError;
}

async function assertApiKeyWorks(client: Anthropic, model: string): Promise<void> {
  try {
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  } catch (err) {
    if (isFatalAuthError(err)) {
      console.error(`Anthropic rejected the API key: ${err.message}`);
      console.error("Fix ANTHROPIC_API_KEY in .env and re-run.");
      process.exit(1);
    }
    if (err instanceof Anthropic.NotFoundError) {
      console.error(`Unknown model "${model}": ${err.message}`);
      process.exit(1);
    }
    // Any other error (rate limit, transient 5xx, etc.) isn't a reason to
    // block startup — the real run will surface it per-category.
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      "No ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) found in the environment. Add one to .env and re-run.",
    );
    process.exit(1);
  }

  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;

  const modelArg = process.argv.find((a) => a.startsWith("--model="));
  const model = modelArg ? modelArg.split("=")[1] : process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const taxonomy = readTaxonomy();
  const doneIds = readDoneIds();
  let pending = taxonomy.filter((e) => !doneIds.has(e.id));
  if (limit) pending = pending.slice(0, limit);

  console.log(
    `${taxonomy.length} categories total, ${doneIds.size} already done, ${pending.length} to generate using ${model}.`,
  );

  if (pending.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const client = new Anthropic();
  await assertApiKeyWorks(client, model);

  const outStream = fs.createWriteStream(OUTPUT_PATH, { flags: "a" });
  const failStream = fs.createWriteStream(FAILURES_PATH, { flags: "a" });

  let completed = 0;
  let failed = 0;

  await pMap(pending, CONCURRENCY, async (entry) => {
    try {
      const record = await generateForCategory(client, entry, model);
      if (record) {
        outStream.write(JSON.stringify(record) + "\n");
      } else {
        failStream.write(
          JSON.stringify({ category_id: entry.id, reason: "refused_or_unparsed" }) + "\n",
        );
        failed++;
      }
    } catch (err) {
      if (isFatalAuthError(err)) {
        console.error(`Anthropic rejected the API key mid-run: ${err.message}`);
        console.error("Stopping immediately — fix ANTHROPIC_API_KEY in .env and re-run.");
        outStream.close();
        failStream.close();
        process.exit(1);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[error] ${entry.id} ${entry.description}: ${message}`);
      failStream.write(JSON.stringify({ category_id: entry.id, reason: message }) + "\n");
      failed++;
    }
    completed++;
    if (completed % 25 === 0 || completed === pending.length) {
      console.log(`${completed}/${pending.length} processed (${failed} failed)`);
    }
  });

  outStream.close();
  failStream.close();
  console.log(`Done. ${completed - failed} written to ${OUTPUT_PATH}, ${failed} failed (see ${FAILURES_PATH}).`);
}

main();
