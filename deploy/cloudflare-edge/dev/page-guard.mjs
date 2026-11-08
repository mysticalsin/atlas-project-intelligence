// The worker imports deploy/cloudflare-edge/src/atlas.html. The local runner serves that same file.
// ATLAS_Voice.html is the build.py alias. If it exists and differs, this stops instead of serving the stale alias.
import { existsSync, readFileSync } from 'node:fs';

export function readCanonicalPage(edgeHtml, rootHtml) {
  if (!existsSync(edgeHtml)) throw new Error('deploy/cloudflare-edge/src/atlas.html is missing. Run: python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html');
  const page = readFileSync(edgeHtml, 'utf8');
  if (existsSync(rootHtml) && readFileSync(rootHtml, 'utf8') !== page) throw new Error('ATLAS_Voice.html does not match deploy/cloudflare-edge/src/atlas.html. Rebuild both from one python3 build.py run and copy the result.');
  return page;
}
