// Fails the build if the emitted bundle does not contain the current source
// fingerprint — i.e. if the compiler served stale output.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist/siftio/browser';
const stamp = readFileSync('src/app/core/build-stamp.ts', 'utf8').match(/'([0-9a-f]+)'/)?.[1];
if (!stamp) throw new Error('no build stamp found in source');

const bundles = readdirSync(OUT).filter((f) => f.endsWith('.js'));
const hit = bundles.some((f) => readFileSync(join(OUT, f), 'utf8').includes(stamp));

if (!hit) {
  console.error(
    `\nSTALE BUILD: source fingerprint ${stamp} is not in ${OUT}.\n` +
      `The compiler emitted output that does not match src/. Re-run the build.\n`,
  );
  process.exit(1);
}
console.log(`build verified: ${stamp} present in bundle`);
