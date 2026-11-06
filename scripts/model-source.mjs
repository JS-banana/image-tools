// Download preparation reads the package-owned source metadata, not a deploy subset.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const catalogs = await Promise.all(['ocr', 'remove-bg'].map(async (tool) =>
  JSON.parse(await readFile(path.join(root, 'packages', tool, 'models.json'), 'utf8'))));
const models = catalogs.flatMap((catalog) => catalog.models);
const [command, first, second] = process.argv.slice(2);

if (command === 'upstream') {
  const source = models.flatMap((model) => [
    ...Object.values(model.files).map((file) => file.source),
    ...Object.values(model.configurations ?? {}),
  ]).find((entry) => entry?.repository === first && entry.path === second);
  if (!source || !/^[a-f0-9]{40}$/.test(source.revision)
    || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isSafeInteger(source.sizeBytes)) {
    throw new Error(`No verified immutable upstream metadata for ${first}/${second}`);
  }
  console.log(`${source.revision} ${source.sizeBytes} ${source.sha256}`);
} else if (command === 'ocr-notices') {
  const model = models.find((entry) => entry.id === first && entry.pipeline === 'ppocr-dbnet-ctc');
  if (!model) throw new Error(`Unknown OCR model ${first}`);
  const directory = path.join(root, 'apps/web/public/models', model.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'LICENSE'), await readFile(path.join(root, 'scripts/licenses/Apache-2.0.txt')));
  const provenance = [
    `${model.name} model source`, '',
    'Publisher: PaddlePaddle / PaddleOCR',
    'License: Apache-2.0; see LICENSE in this directory.',
    'Source project: https://github.com/PaddlePaddle/PaddleOCR', '',
    ...Object.entries(model.files).flatMap(([role, file]) => [
      `${role}: ${file.url}`,
      `  Upstream: https://huggingface.co/${file.source.repository}/resolve/${file.source.revision}/${file.source.path}`,
      `  Source sizeBytes: ${file.source.sizeBytes}`,
      `  Source SHA256: ${file.source.sha256}`,
      `  Distributed sizeBytes: ${file.sizeBytes}`,
      `  Distributed SHA256: ${file.sha256}`, '',
    ]),
    'dict.json is generated from the pinned recognition inference.yml by scripts/extract_charset.py.',
    'The transformation extracts PostProcess.character_dict as compact UTF-8 JSON without a trailing newline.',
    'ONNX weights are unmodified upstream files. Small/Medium hashes are published upstream LFS metadata;',
    'the download and release checks independently verify the actual bytes before distribution.', '',
  ].join('\n');
  await writeFile(path.join(directory, 'MODEL_SOURCE'), provenance);
  console.log(`Wrote Apache-2.0 license and immutable source notice for ${model.id}`);
} else {
  throw new Error('Usage: model-source.mjs upstream <repository> <file> | ocr-notices <model-id>');
}
