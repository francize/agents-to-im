import * as esbuild from 'esbuild';
import fs from 'node:fs';

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli.js',
  external: [
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'readline',
    'node:*',
  ],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

// Node.js ESM does not strip shebangs from .js files with "type":"module".
// We use a thin shell+node polyglot wrapper that re-execs itself via node.
// The actual bin entry uses this wrapper script.
const wrapperContent = `#!/usr/bin/env node
// CLI entry point - auto-generated, do not edit
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { runCli } = await import(join(__dirname, 'cli.js'));
runCli(process.argv.slice(2));
`;
fs.writeFileSync('dist/cli-bin.mjs', wrapperContent);
fs.chmodSync('dist/cli-bin.mjs', 0o755);
fs.writeFileSync('dist/cli.mjs', wrapperContent);
fs.chmodSync('dist/cli.mjs', 0o755);

console.log('Built dist/cli.js + dist/cli-bin.mjs + dist/cli.mjs');
