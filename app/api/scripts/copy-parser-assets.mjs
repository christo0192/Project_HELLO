#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(scriptDir, '..');
const source = join(apiRoot, 'src', 'lib', 'resume-parser-child.mjs');
const destination = join(apiRoot, 'dist', 'src', 'lib', 'resume-parser-child.mjs');

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
