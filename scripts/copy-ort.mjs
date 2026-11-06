// Always copy WASM and its loader from the same installed SDK used by the app.
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const app = path.join(root, 'apps/web');
const installed = path.join(app, 'node_modules/onnxruntime-web');
const dependency = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8')).dependencies['onnxruntime-web'];
const version = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')).version;
if (version !== dependency) throw new Error(`Pin onnxruntime-web exactly: package requires ${dependency}, installed ${version}`);
for (const tool of ['ocr', 'remove-bg']) {
  const runtime = JSON.parse(await readFile(path.join(root, 'packages', tool, 'node_modules/onnxruntime-web/package.json'), 'utf8'));
  if (runtime.version !== version) throw new Error(`ORT JS/WASM version mismatch: ${tool}=${runtime.version}, web=${version}`);
}
const source = path.join(installed, 'dist');
const target = path.join(app, 'public/ort');
await mkdir(target, { recursive: true });
const names = (await readdir(source)).filter((name) => /^ort-wasm-simd-threaded\..*\.(mjs|wasm)$/.test(name)
  || /^ort-wasm-simd-threaded\.(mjs|wasm)$/.test(name)).sort();
if (!names.includes('ort-wasm-simd-threaded.wasm') || !names.includes('ort-wasm-simd-threaded.mjs')) {
  throw new Error('Installed ORT package lacks required WASM/loader pair');
}
for (const name of await readdir(target)) {
  if (name.startsWith('ort-wasm-') && !names.includes(name)) await rm(path.join(target, name));
}
const files = [];
for (const name of names) {
  await copyFile(path.join(source, name), path.join(target, name));
  const content = await readFile(path.join(source, name));
  files.push({ name, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
}
await writeFile(path.join(target, 'version.json'), `${JSON.stringify({ version, files }, null, 2)}\n`);
console.log(`Copied ${names.length} ORT loader/WASM assets from installed onnxruntime-web@${version}.`);
