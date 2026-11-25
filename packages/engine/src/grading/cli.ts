/**
 * Headless grader entry point, bundled to dist/grader.mjs and executed by the API in a
 * resource-limited subprocess. Protocol: one JSON object {project, rubric} on stdin,
 * one JSON object on stdout: {ok:true, report} or {ok:false, error}.
 */
import { grade } from './grader';

const MAX_INPUT = 4 * 1024 * 1024;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_INPUT) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'input too large' }));
      process.exit(2);
    }
    chunks.push(chunk as Buffer);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { project: unknown; rubric: unknown };
    const report = grade(input.project, input.rubric);
    process.stdout.write(JSON.stringify({ ok: true, report }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: (e as Error).message }));
    process.exit(1);
  }
}

void main();
