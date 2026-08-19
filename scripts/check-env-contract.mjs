#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const schemaPath = path.join(root, "config/environment.schema.json");
const errors = [];

function fail(message) {
  errors.push(message);
}

async function filesUnder(target) {
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".venv", "node_modules", "__pycache__", "dist"].includes(entry.name)) continue;
    const item = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(item));
    else if (/\.(?:js|mjs|cjs|ts|tsx|py)$/.test(entry.name)) files.push(item);
  }
  return files;
}

/**
 * Is this file a TEST rather than runtime code?
 *
 * This distinction matters in ONE direction only. A test that reads a variable
 * still proves that variable is exercised, so tests keep counting toward "is
 * this declared variable actually read". But a variable read ONLY by a test is
 * not part of the component's environment CONTRACT — `CI`, set by the runner
 * so a test can fail loudly instead of skipping, is not application
 * configuration and declaring it in the schema (and therefore in
 * `.env.example`) would tell developers to set something the app never reads.
 *
 * So tests are excluded from the "must be declared" direction and kept in the
 * "must be read" direction. Neither check is weakened: a genuinely new runtime
 * variable still has to be declared, and a declared variable that nothing reads
 * at all is still reported.
 */
function isTestFile(file) {
  const normalized = file.split(path.sep).join("/");
  return /(?:^|\/)(?:__tests__|tests)\//.test(normalized)
    || /\.(?:test|spec)\.[^/]+$/.test(normalized)
    || /(?:^|\/)test_[^/]*\.py$/.test(normalized);
}

function readExample(content, component) {
  const values = new Map();
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, name, value] = match;
    if (values.has(name)) fail(`${component}: duplicate ${name} in env example`);
    values.set(name, { value: value.trim(), line: index + 1 });
  }
  return values;
}

function runtimeVariables(content) {
  const names = new Set();
  const patterns = [
    /(?:process\.env\.|import\.meta\.env\.)([A-Z][A-Z0-9_]*)/g,
    /required\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    /os\.(?:getenv|environ\.get)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    /os\.environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
    /_(?:float|int)_env\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
if (schema.version !== 1 || !schema.components) fail("unsupported environment schema");

for (const [component, config] of Object.entries(schema.components ?? {})) {
  const declared = new Map(Object.entries(config.variables ?? {}));
  const exampleContent = await readFile(path.join(root, config.example), "utf8");
  const example = readExample(exampleContent, component);
  const discovered = new Set();      // read anywhere, including tests
  const discoveredRuntime = new Set(); // read by NON-test code only

  for (const sourceRoot of config.sourceRoots ?? []) {
    for (const file of await filesUnder(path.join(root, sourceRoot))) {
      const content = await readFile(file, "utf8");
      const isTest = isTestFile(file);
      for (const name of runtimeVariables(content)) {
        discovered.add(name);
        if (!isTest) discoveredRuntime.add(name);
      }
    }
  }

  // Only RUNTIME reads create a contract obligation — see isTestFile.
  for (const name of discoveredRuntime) {
    if (!declared.has(name)) fail(`${component}: runtime variable ${name} is missing from schema`);
  }
  for (const [name, metadata] of declared) {
    if (!example.has(name)) fail(`${component}: schema variable ${name} is missing from ${config.example}`);
    if (!discovered.has(name) && !metadata.external) {
      fail(`${component}: schema variable ${name} is not read by runtime code`);
    }
  }
  for (const name of example.keys()) {
    if (!declared.has(name)) fail(`${component}: unknown example variable ${name}`);
  }

  for (const [name, metadata] of declared) {
    const item = example.get(name);
    if (!item) continue;
    if (metadata.secret && item.value !== "replace_me") {
      fail(`${component}:${item.line}: secret ${name} must use replace_me`);
    }
    if (metadata.requiredInProduction && item.value === "") {
      fail(`${component}:${item.line}: required ${name} cannot have an empty example value`);
    }
    if (metadata.productionAllowed === false && metadata.requiredInProduction) {
      fail(`${component}: ${name} cannot be both production-required and production-forbidden`);
    }
    if (name.startsWith("VITE_") && metadata.secret) {
      fail(`${component}: browser variable ${name} cannot be secret`);
    }
  }

  const unsafe = [
    /https:\/\/[a-z0-9]{15,}\.supabase\.co/i,
    /\b(?:sk-ant-|sk_)[A-Za-z0-9_-]{8,}/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  ];
  for (const [name, item] of example) {
    if (unsafe.some((pattern) => pattern.test(item.value))) {
      fail(`${component}:${item.line}: ${name} contains a key-shaped or project-specific value`);
    }
  }
}

if (errors.length) {
  console.error(`Environment contract failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Environment contract valid for ${Object.keys(schema.components).join(", ")}.`);
