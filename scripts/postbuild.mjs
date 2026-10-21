import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
const p = new URL('../dist/cli.js', import.meta.url);
const src = readFileSync(p, 'utf8');
if (!src.startsWith('#!')) writeFileSync(p, '#!/usr/bin/env node\n' + src);
chmodSync(p, 0o755);
