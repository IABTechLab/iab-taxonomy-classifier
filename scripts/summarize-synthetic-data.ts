import fs from "node:fs";

const PATH = "data/synthetic-content.ndjson";
const SNIPPET_LENGTH = 100;

const lines = fs.readFileSync(PATH, "utf-8").split("\n").filter(Boolean);

for (const line of lines) {
  const record = JSON.parse(line);
  const snippet = record.body.replace(/\s+/g, " ").slice(0, SNIPPET_LENGTH);
  console.log(`${record.category_id}\t${record.category_name}\t${snippet}...`);
}

console.log(`\n${lines.length} records total`);
