// Permet à Node.js d'importer les fichiers .html / .txt (texte) et .png (binaire) comme le fait Cloudflare Wrangler.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    if (/\.(html|txt|sql)$/.test(url)) {
      const text = fs.readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
    }
    if (/\.png$/.test(url)) {
      const b64 = fs.readFileSync(fileURLToPath(url)).toString('base64');
      return { format: 'module', shortCircuit: true, source: `const b = Buffer.from(${JSON.stringify(b64)}, 'base64'); export default b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);` };
    }
  }
  return nextLoad(url, context);
}
