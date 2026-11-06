import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseOcrCatalog } from '../packages/ocr/src/models.ts';
import { parseRemoveBgCatalog } from '../packages/remove-bg/src/models.ts';
import { TOOLS } from '../apps/web/lib/site/tools.ts';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CATALOGS = {
  ocr: { source: 'packages/ocr/models.json', parse: parseOcrCatalog },
  'remove-bg': { source: 'packages/remove-bg/models.json', parse: parseRemoveBgCatalog },
};

function selector(value, name) {
  if (value === undefined) return undefined;
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error(`${name} must be a nonempty comma-separated list without duplicates`);
  }
  return ids;
}

export function assetPath(root, url) {
  if (typeof url !== 'string' || !/^\/models\/[A-Za-z0-9._/-]+$/.test(url)
    || url.split('/').slice(1).some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid model asset path: ${url}`);
  }
  return path.join(root, url.slice(1));
}

export async function readSources(root = ROOT) {
  const sources = {};
  for (const [tool, definition] of Object.entries(CATALOGS)) {
    const catalog = JSON.parse(await readFile(path.join(root, definition.source), 'utf8'));
    definition.parse(catalog); // The tool owns its schema; build code never duplicates it.
    for (const model of catalog.models) {
      for (const file of Object.values(model.files)) {
        assetPath(root, file.url);
        if (file.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(file.sha256)) {
          throw new Error(`Invalid SHA-256: ${model.id} ${file.url}`);
        }
      }
      if (!model.distribution?.license || !model.distribution.notices?.length) {
        throw new Error(`Missing license/source distribution metadata: ${model.id}`);
      }
      for (const notice of model.distribution.notices) assetPath(root, notice);
    }
    sources[tool] = catalog;
  }
  return sources;
}

export function selectCatalogs(sources, env = process.env) {
  const tools = selector(env.NEXT_PUBLIC_TOOLS, 'NEXT_PUBLIC_TOOLS') ?? TOOLS.map((tool) => tool.id);
  for (const tool of tools) {
    if (!TOOLS.some((entry) => entry.id === tool)) throw new Error(`Unknown tool: ${tool}`);
  }
  const ids = selector(env.MODEL_IDS, 'MODEL_IDS');
  const available = Object.entries(sources).flatMap(([tool, catalog]) =>
    catalog.models.map((model) => ({ tool, model })));
  if (new Set(available.map(({ model }) => model.id)).size !== available.length) {
    throw new Error('Model IDs must be unique across tool catalogs');
  }
  for (const id of ids ?? []) {
    const match = available.find(({ model }) => model.id === id);
    if (!match) throw new Error(`Unknown model: ${id}`);
    if (!tools.includes(match.tool)) throw new Error(`Model ${id} belongs to disabled tool ${match.tool}`);
  }
  const selected = {};
  for (const [tool, catalog] of Object.entries(sources)) {
    if (!tools.includes(tool)) continue;
    const models = catalog.models.filter((model) => !ids || ids.includes(model.id));
    if (!models.length) throw new Error(`Enabled tool ${tool} has no selected models`);
    const recommended = models.find((model) => model.recommended) ?? models[0];
    selected[tool] = { models: models.map((model) => ({ ...model, recommended: model === recommended })) };
    CATALOGS[tool].parse(selected[tool]);
  }
  return selected;
}

export async function generateCatalogs(selected, publicRoot) {
  const output = path.join(publicRoot, 'catalogs');
  await mkdir(output, { recursive: true });
  // Only our known generated names are touched. Downloaded public/models stays intact.
  for (const tool of Object.keys(CATALOGS)) {
    const file = path.join(output, `${tool}.json`);
    if (selected[tool]) await writeFile(file, `${JSON.stringify(selected[tool], null, 2)}\n`);
    else await rm(file, { force: true });
  }
}

function selectedPaths(selected) {
  return new Set(Object.values(selected).flatMap(({ models }) => models.flatMap((model) => [
    ...Object.values(model.files).map((file) => file.url),
    ...model.distribution.notices,
  ])));
}

async function walk(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Model asset cannot be a symlink: ${file}`);
    if (entry.isDirectory()) files.push(...await walk(file));
    else files.push(file);
  }
  return files;
}

/** Operates on generated export output, never on the downloaded public/ source. */
export async function filterExportAssets(selected, exportRoot) {
  const keep = selectedPaths(selected);
  const files = await walk(path.join(exportRoot, 'models'));
  let removed = 0;
  for (const file of files) {
    const url = `/${path.relative(exportRoot, file).split(path.sep).join('/')}`;
    if (!keep.has(url)) { await rm(file); removed++; }
  }
  return removed;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function requireFile(file) {
  let info;
  try { info = await stat(file); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Missing required release asset: ${file}`); throw error; }
  if (!info.isFile() || !info.size) throw new Error(`Release asset must be a nonempty file: ${file}`);
  return info;
}

export async function checkAssets(selected, exportRoot) {
  const expectedCatalogFiles = Object.keys(selected).map((tool) => `${tool}.json`).sort();
  const actualCatalogFiles = (await readdir(path.join(exportRoot, 'catalogs'))).sort();
  if (!isDeepStrictEqual(actualCatalogFiles, expectedCatalogFiles)) {
    throw new Error(`Exported catalogs do not match tool selection: expected ${expectedCatalogFiles}, got ${actualCatalogFiles}`);
  }
  let fileCount = 0;
  let digestCount = 0;
  for (const [tool, catalog] of Object.entries(selected)) {
    const exported = JSON.parse(await readFile(path.join(exportRoot, 'catalogs', `${tool}.json`), 'utf8'));
    if (!isDeepStrictEqual(exported, catalog)) throw new Error(`Exported ${tool} catalog does not match source/model selection`);
    for (const model of catalog.models) {
      for (const descriptor of Object.values(model.files)) {
        const file = assetPath(exportRoot, descriptor.url);
        const info = await requireFile(file);
        if (info.size !== descriptor.sizeBytes) throw new Error(`Asset size mismatch: ${descriptor.url} expected ${descriptor.sizeBytes}, got ${info.size}`);
        if (descriptor.sha256) {
          if (await sha256(file) !== descriptor.sha256) throw new Error(`Asset SHA-256 mismatch: ${descriptor.url}`);
          digestCount++;
        }
        fileCount++;
      }
      for (const url of model.distribution.notices) await requireFile(assetPath(exportRoot, url));
      const licenseUrl = model.distribution.notices.find((url) => url.endsWith('/LICENSE'));
      const sourceUrl = model.distribution.notices.find((url) => url.endsWith('/MODEL_SOURCE'));
      if (!licenseUrl || !sourceUrl) throw new Error(`Missing LICENSE/MODEL_SOURCE declaration: ${model.id}`);
      const license = await readFile(assetPath(exportRoot, licenseUrl), 'utf8');
      const canonicalLicense = model.distribution.license === 'Apache-2.0' ? 'Apache-2.0.txt'
        : model.distribution.license === 'MIT' ? 'BEN2-MIT.txt' : undefined;
      if (canonicalLicense && license !== await readFile(path.join(ROOT, 'scripts/licenses', canonicalLicense), 'utf8')) {
        throw new Error(`Release license differs from the preserved upstream notice: ${model.id}`);
      }
      if (model.distribution.license === 'Apache-2.0' && (!license.includes('Apache License') || !license.includes('Version 2.0'))) {
        throw new Error(`Missing Apache-2.0 license text: ${model.id}`);
      }
      if (model.distribution.license === 'MIT' && (!license.includes('MIT License') || !license.includes('Prama LLC'))) {
        throw new Error(`Missing Prama LLC MIT notice: ${model.id}`);
      }
      const provenance = await readFile(assetPath(exportRoot, sourceUrl), 'utf8');
      for (const file of Object.values(model.files)) {
        if (file.source && (!provenance.includes(file.source.repository) || !provenance.includes(file.source.revision))) {
          throw new Error(`Missing immutable model source notice: ${model.id}`);
        }
      }
    }
  }
  const allowed = selectedPaths(selected);
  for (const file of await walk(path.join(exportRoot, 'models'))) {
    const url = `/${path.relative(exportRoot, file).split(path.sep).join('/')}`;
    if (!allowed.has(url)) throw new Error(`Unselected asset in release: ${url}`);
  }
  try {
    await stat(path.join(exportRoot, 'models.json'));
    throw new Error('Legacy global models.json must not be published');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { fileCount, digestCount };
}

export async function checkOrtAssets(exportRoot) {
  const expected = JSON.parse(await readFile(path.join(ROOT, 'apps/web/public/ort/version.json'), 'utf8'));
  const actual = JSON.parse(await readFile(path.join(exportRoot, 'ort/version.json'), 'utf8'));
  const app = JSON.parse(await readFile(path.join(ROOT, 'apps/web/package.json'), 'utf8'));
  if (expected.version !== app.dependencies['onnxruntime-web'] || !isDeepStrictEqual(actual, expected)) {
    throw new Error('Published ORT assets do not match the pinned JavaScript SDK');
  }
  for (const file of actual.files) {
    if (!/^ort-wasm-simd-threaded\.[a-z.]+$/.test(file.name)) throw new Error(`Invalid ORT asset name: ${file.name}`);
    const location = path.join(exportRoot, 'ort', file.name);
    const info = await requireFile(location);
    if (info.size !== file.sizeBytes || await sha256(location) !== file.sha256) {
      throw new Error(`Published ORT asset differs from installed SDK: ${file.name}`);
    }
  }
  return actual.version;
}

async function main() {
  const command = process.argv[2] ?? 'generate';
  if (!['generate', 'filter-export', 'check'].includes(command) || process.argv.length > 3) {
    throw new Error('Usage: node scripts/model-catalogs.mjs generate|filter-export|check');
  }
  const sources = await readSources();
  const selected = selectCatalogs(sources);
  const summary = Object.entries(selected).map(([tool, catalog]) => `${tool}: ${catalog.models.map((model) => model.id).join(', ')}`).join('; ') || 'no model tools';
  if (command === 'generate') {
    await generateCatalogs(selected, path.join(ROOT, 'apps/web/public'));
    console.log(`Generated catalogs (${summary}); no weights downloaded.`);
  } else if (command === 'filter-export') {
    const removed = await filterExportAssets(selected, path.join(ROOT, 'apps/web/out'));
    console.log(`Export selection (${summary}); removed ${removed} unselected exported files.`);
  } else {
    const exportRoot = path.join(ROOT, 'apps/web/out');
    const result = await checkAssets(selected, exportRoot);
    const ortVersion = await checkOrtAssets(exportRoot);
    console.log(`ORT JavaScript/WASM consistency verified: ${ortVersion}.`);
    console.log(`Release assets verified: ${result.fileCount} files, ${result.digestCount} SHA-256 checks (${summary}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
