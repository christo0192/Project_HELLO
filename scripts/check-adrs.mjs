#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const adrDir = path.join(process.cwd(), "docs/adr");
const index = await readFile(path.join(adrDir, "README.md"), "utf8");
const entries = await readdir(adrDir, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && /^\d{4}-[a-z0-9-]+\.md$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const requiredSections = ["Context", "Decision", "Consequences", "Evidence", "Supersession"];
const allowedStatuses = new Set(["Proposed", "Accepted", "Rejected", "Superseded"]);
const ids = new Set();
const errors = [];

for (const file of files) {
  const content = await readFile(path.join(adrDir, file), "utf8");
  const id = file.slice(0, 4);
  if (ids.has(id)) errors.push(`${file}: duplicate ADR id ${id}`);
  ids.add(id);

  if (!content.startsWith(`# ADR-${id}: `)) errors.push(`${file}: heading must match ADR-${id}`);
  const status = content.match(/^\*\*Status:\*\* (.+)$/m)?.[1];
  if (!allowedStatuses.has(status)) errors.push(`${file}: invalid or missing status`);
  if (!/^\*\*Decision owner:\*\* .+$/m.test(content)) errors.push(`${file}: missing decision owner`);
  if (!/^\*\*Plan references:\*\* .+$/m.test(content)) errors.push(`${file}: missing plan references`);
  for (const section of requiredSections) {
    if (!content.includes(`## ${section}\n`)) errors.push(`${file}: missing ${section} section`);
  }
  if (!index.includes(`(${file})`)) errors.push(`${file}: missing from ADR index`);
}

if (!files.length) errors.push("no ADR files found");
if (errors.length) {
  console.error(`ADR validation failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validated ${files.length} architecture decision records.`);
