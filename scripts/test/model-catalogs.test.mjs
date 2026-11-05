import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { ROOT, readSources, selectCatalogs, generateCatalogs, filterExportAssets, checkAssets, assetPath } from '../model-catalogs.mjs';

const sources = await readSources();
const tiny = { NEXT_PUBLIC_TOOLS: 'ocr', MODEL_IDS: 'ppocrv6-tiny' };

async function fixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'image-tools-release-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const selected = structuredClone(selectCatalogs(sources, tiny));
  for (const model of selected.ocr.models) {
    for (const [role, file] of Object.entries(model.files)) {
      const content = Buffer.from(`fixture bytes: ${role}`);
      file.sizeBytes = content.length;
      file.sha256 = createHash('sha256').update(content).digest('hex');
      await mkdir(path.dirname(assetPath(output, file.url)), { recursive: true });
      await writeFile(assetPath(output, file.url), content);
    }
    const license = await readFile(path.join(ROOT, 'scripts/licenses/Apache-2.0.txt'));
    await writeFile(assetPath(output, model.distribution.notices[0]), license);
    await writeFile(assetPath(output, model.distribution.notices[1]), Object.values(model.files)
      .map((file) => `${file.source.repository} ${file.source.revision}`).join('\n'));
  }
  await generateCatalogs(selected, output);
  return { selected, output };
}

test('deployment selectors reject unknown, disabled, duplicate and empty selections', () => {
  assert.throws(() => selectCatalogs(sources, { NEXT_PUBLIC_TOOLS: 'ocr,other' }), /Unknown tool/);
  assert.throws(() => selectCatalogs(sources, { NEXT_PUBLIC_TOOLS: '' }), /nonempty/);
  assert.throws(() => selectCatalogs(sources, { NEXT_PUBLIC_TOOLS: 'ocr,ocr' }), /duplicates/);
  assert.throws(() => selectCatalogs(sources, { ...tiny, MODEL_IDS: 'typo' }), /Unknown model/);
  assert.throws(() => selectCatalogs(sources, { ...tiny, MODEL_IDS: 'ben2-base-fp16' }), /disabled tool/);
  assert.throws(() => selectCatalogs(sources, { MODEL_IDS: 'ppocrv6-tiny' }), /no selected models/);
});

test('a one-model deployment has exactly one default without mutating source', () => {
  const selected = selectCatalogs(sources, { NEXT_PUBLIC_TOOLS: 'ocr', MODEL_IDS: 'ppocrv6-small' });
  assert.deepEqual(Object.keys(selected), ['ocr']);
  assert.deepEqual(selected.ocr.models.map((model) => model.id), ['ppocrv6-small']);
  assert.equal(selected.ocr.models[0].recommended, true);
  assert.equal(sources.ocr.models.find((model) => model.id === 'ppocrv6-small').recommended, false);
});

test('catalog generation removes disabled catalogs without downloading or deleting local weights', async (t) => {
  const { selected, output } = await fixture(t);
  await generateCatalogs(selectCatalogs(sources, {}), output);
  await generateCatalogs(selected, output);
  await assert.rejects(access(path.join(output, 'catalogs/remove-bg.json')));
  await access(path.join(output, 'models/ppocrv6-tiny/det.onnx'));
  await assert.rejects(access(path.join(output, 'models/ben2-base/model.onnx')));
});

test('strict publication check verifies selected bytes, hashes and notices', async (t) => {
  const { selected, output } = await fixture(t);
  assert.deepEqual(await checkAssets(selected, output), { fileCount: 3, digestCount: 3 });
  await rm(path.join(output, 'models/ppocrv6-tiny/LICENSE'));
  await assert.rejects(checkAssets(selected, output), /Missing required release asset/);
});

test('missing weights fail publication instead of becoming skipped tests', async (t) => {
  const { selected, output } = await fixture(t);
  await rm(path.join(output, 'models/ppocrv6-tiny/rec.onnx'));
  await assert.rejects(checkAssets(selected, output), /Missing required release asset/);
});

test('same-size corruption fails SHA-256 verification', async (t) => {
  const { selected, output } = await fixture(t);
  const file = path.join(output, 'models/ppocrv6-tiny/det.onnx');
  const content = await readFile(file);
  content[0] ^= 1;
  await writeFile(file, content);
  await assert.rejects(checkAssets(selected, output), /SHA-256 mismatch/);
});

test('unselected exported model assets are rejected then filtered out of generated output', async (t) => {
  const { selected, output } = await fixture(t);
  const extra = path.join(output, 'models/ben2-base/model.onnx');
  await mkdir(path.dirname(extra), { recursive: true });
  await writeFile(extra, 'an unselected weight');
  await assert.rejects(checkAssets(selected, output), /Unselected asset/);
  assert.equal(await filterExportAssets(selected, output), 1);
  await checkAssets(selected, output);
});

test('release catalog contents must match the same selection used for export', async (t) => {
  const { selected, output } = await fixture(t);
  await generateCatalogs(selectCatalogs(sources, {}), output);
  await assert.rejects(checkAssets(selected, output), /do not match tool selection/);
});

test('model asset paths cannot escape their static directory', () => {
  for (const url of ['/models/../secret', '/models//file', '//example.test/file', '/models/%2e%2e/file']) {
    assert.throws(() => assetPath('/tmp/export', url), /Invalid model asset path/);
  }
});
