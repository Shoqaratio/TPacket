// Bundles the engine's headless grader into a single self-contained Node script.
// The API server runs this bundle in a sandboxed subprocess (see apps/api/app/grading/runner.py),
// so the browser and the server execute exactly the same simulation code.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/grading/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/grader.mjs',
});
console.log('built dist/grader.mjs');
