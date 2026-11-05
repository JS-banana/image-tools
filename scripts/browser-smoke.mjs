#!/usr/bin/env node
// Run after building apps/web/out. For Pages, use the same BASE_PATH as the build.
// SMOKE_EXECUTABLE_PATH optionally selects an existing Chromium installation.
// SMOKE_REMOVE_BG=1 additionally runs the large BEN2 model through WASM (not a quality/WebGPU gate).
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'apps/web/out');
const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
assert(!basePath || (basePath.startsWith('/') && !basePath.includes('..')), 'BASE_PATH must be an absolute URL path');
const timeout = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
assert(Number.isSafeInteger(timeout) && timeout > 0, 'SMOKE_TIMEOUT_MS must be a positive integer');
const testRemoval = process.env.SMOKE_REMOVE_BG === '1';
const removalTimeout = Number(process.env.SMOKE_REMOVE_BG_TIMEOUT_MS ?? 180_000);
assert(Number.isSafeInteger(removalTimeout) && removalTimeout > 0, 'SMOKE_REMOVE_BG_TIMEOUT_MS must be a positive integer');
const expectedText = ['Hello', '浏览器', '12345']; // scripts/assets/baseline.md: cn_en
const requestedPaths = [];
const pageErrors = [];
const failedAssets = [];
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.onnx': 'application/octet-stream',
};

async function exists(filename) {
  try { return (await stat(filename)).isFile(); } catch { return false; }
}

// Serve the real static export, including /ocr -> /ocr.html and Pages subpaths.
// Deliberately omit COOP/COEP: the baseline must work without cross-origin isolation.
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    requestedPaths.push(pathname);
    if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      response.writeHead(404).end('Outside BASE_PATH');
      return;
    }
    const relative = pathname.slice(basePath.length) || '/';
    const candidate = path.resolve(output, `.${relative}`);
    if (candidate !== output && !candidate.startsWith(`${output}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const choices = relative.endsWith('/')
      ? [path.join(candidate, 'index.html')]
      : [candidate, `${candidate}.html`, path.join(candidate, 'index.html')];
    let filename;
    for (const choice of choices) {
      if (await exists(choice)) { filename = choice; break; }
    }
    if (!filename) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Not found: ${pathname}`);
      return;
    }
    response.writeHead(200, {
      'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream',
      'Content-Length': (await stat(filename)).size,
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filename).on('error', (error) => response.destroy(error)).pipe(response);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500);
    response.end(String(error));
  }
});

let browser;
let page;
let stage = 'preflight';
function step(message) {
  stage = message;
  console.log(`[browser-smoke] ${message}`);
}

try {
  assert(await exists(path.join(output, 'ocr.html')), 'Missing static OCR export. Run pnpm build first.');
  const catalog = JSON.parse(await readFile(path.join(output, 'catalogs/ocr.json'), 'utf8'));
  const tiny = catalog.models.find((model) => model.id === 'ppocrv6-tiny');
  assert(tiny?.recommended, 'The smoke baseline requires recommended ppocrv6-tiny in the exported catalog');
  const hasRemoval = await exists(path.join(output, 'catalogs/remove-bg.json'));
  let removalModel;
  if (testRemoval) {
    assert(hasRemoval, 'SMOKE_REMOVE_BG=1 requires a build with the removal tool enabled');
    const removalCatalog = JSON.parse(await readFile(path.join(output, 'catalogs/remove-bg.json'), 'utf8'));
    removalModel = removalCatalog.models.find((model) => model.recommended);
    assert(removalModel, 'Missing recommended removal model');
    for (const file of Object.values(removalModel.files)) {
      const filename = path.join(output, file.url.replace(/^\/+/, ''));
      assert(await exists(filename), `Download BEN2 before optional smoke: ${filename}`);
      assert.equal((await stat(filename)).size, file.sizeBytes, `BEN2 asset size differs from the catalog: ${filename}`);
    }
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = (route) => `${origin}${basePath}${route}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SMOKE_EXECUTABLE_PATH ? { executablePath: process.env.SMOKE_EXECUTABLE_PATH } : {}),
    args: ['--disable-gpu', '--disable-webgl', '--disable-features=WebGPU'],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  context.on('response', (response) => {
    if (response.status() >= 400 && /\/(models|ort|catalogs|_next)\//.test(new URL(response.url()).pathname)) {
      failedAssets.push(`${response.status()} ${response.url()}`);
    }
  });
  await context.addInitScript(() => {
    const state = window.__imageToolsSmoke = {
      created: 0, active: 0, maxActive: 0, workers: [], runs: [], selections: [], race: null,
      heartbeat: { count: 0, previous: performance.now() },
    };
    setInterval(() => {
      const now = performance.now();
      const gap = now - state.heartbeat.previous;
      state.heartbeat.previous = now;
      state.heartbeat.count += 1;
      for (const run of state.runs) {
        if (!run.finished) run.maxHeartbeatGapMs = Math.max(run.maxHeartbeatGapMs, gap);
      }
    }, 16);
    const NativeWorker = window.Worker;
    window.Worker = class ObservedWorker extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.smokeId = ++state.created;
        this.smokeClosed = false;
        this.smokeRecord = { id: this.smokeId, name: args[1]?.name, closed: false };
        state.workers.push(this.smokeRecord);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        this.addEventListener('message', ({ data }) => {
          const key = `${this.smokeId}:${data?.id}`;
          const run = state.runs.find((item) => item.key === key);
          if (!run) return;
          if (data.kind === 'event' && data.name === 'run-progress') {
            run.progress = data.payload.pct;
            const race = state.race;
            if (race?.armed && !race.triggered && data.payload.pct === 20) {
              race.triggered = true;
              race.targetRun = key;
              const transfer = new DataTransfer();
              transfer.items.add(race.file);
              const input = document.querySelector('input[type="file"]');
              input.files = transfer.files;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else if (data.kind === 'result' || data.kind === 'error') {
            run.finished = true;
            run.heartbeats = state.heartbeat.count - run.startHeartbeat;
            run.elapsedMs = performance.now() - run.startedAt;
            if (data.kind === 'result') {
              run.result = {
                boxesFound: data.value.boxesFound,
                backend: data.value.backend,
                alphaLength: data.value.alpha?.length,
                totalMs: data.value.totalMs,
                texts: data.value.results?.map((line) => line.text),
              };
            } else run.error = data.error;
            if (state.race?.targetRun === key) {
              state.race.oldReplyAfterBlank = state.race.blankDisplayed;
            }
          }
        });
      }
      postMessage(message, ...args) {
        if (message?.method === 'run') {
          state.runs.push({
            key: `${this.smokeId}:${message.id}`,
            width: message.payload.width, height: message.payload.height, finished: false,
            startHeartbeat: state.heartbeat.count, startedAt: performance.now(), maxHeartbeatGapMs: 0,
          });
        } else if (message?.method === 'select') state.selections.push(message.payload.id);
        return super.postMessage(message, ...args);
      }
      terminate() {
        if (!this.smokeClosed) { this.smokeClosed = true; this.smokeRecord.closed = true; state.active -= 1; }
        return super.terminate();
      }
    };
  });
  page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
  page.on('pageerror', (error) => pageErrors.push(error.message));

  if (hasRemoval) {
    step('empty removal page: no model/runtime requests or Workers');
    await page.goto(url('/remove-bg'), { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '背景去除', exact: true }).waitFor();
    await page.locator('input[type="file"]').waitFor({ state: 'attached' });
    assert.equal(await page.evaluate(() => window.__imageToolsSmoke.created), 0, 'Empty removal page created a Worker');
    assert.deepEqual(requestedPaths.filter((name) => /\/(models|ort)\//.test(name)), [], 'Empty removal page fetched heavy assets');
    step('navigate to OCR; only the recommended Tiny model may load');
    await page.getByRole('navigation', { name: '图片工具' }).getByRole('link', { name: 'OCR', exact: true }).click();
    await page.waitForURL(url('/ocr'));
  } else {
    step('Pages/one-tool build: open OCR directly');
    await page.goto(url('/ocr'), { waitUntil: 'domcontentloaded' });
  }
  await page.getByText('模型已就绪，上传图片即可识别', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.crossOriginIsolated), false, 'Smoke must run without COOP/COEP');
  const loadedModels = [...new Set(requestedPaths.flatMap((name) => name.match(/\/models\/([^/]+)\//)?.[1] ?? []))];
  assert.deepEqual(loadedModels, ['ppocrv6-tiny'], 'OCR eagerly loaded an unselected model');
  for (const file of Object.values(tiny.files)) {
    const expected = `${basePath}/${file.url.replace(/^\/+/, '')}`;
    assert(requestedPaths.includes(expected), `Tiny asset not requested from the deployment base path: ${expected}`);
  }

  step('real Tiny/WASM OCR and TXT download (cn_en baseline)');
  await page.locator('input[type="file"]').setInputFiles(path.join(root, 'scripts/assets/test_input.png'));
  await page.waitForFunction(() => window.__imageToolsSmoke.runs[0]?.finished);
  const firstRun = await page.evaluate(() => window.__imageToolsSmoke.runs[0]);
  assert(!firstRun.error, `OCR worker failed: ${JSON.stringify(firstRun.error)}`);
  assert.equal(firstRun.result.backend, 'wasm', 'GPU-disabled smoke did not use WASM');
  assert(firstRun.result.boxesFound >= 2, `Expected at least two text boxes: ${JSON.stringify(firstRun.result)}`);
  const resultSection = page.locator('section').filter({ has: page.getByRole('heading', { name: '识别结果', exact: true }) });
  await page.getByRole('button', { name: '下载 .txt', exact: true }).waitFor();
  const visibleText = await resultSection.innerText();
  for (const fragment of expectedText) assert(visibleText.includes(fragment), `UI OCR output is missing ${fragment}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载 .txt', exact: true }).click(),
  ]);
  assert.equal(download.suggestedFilename(), 'test_input-ocr.txt');
  assert.equal(await download.failure(), null, 'TXT download failed');
  const downloadedText = await readFile(await download.path(), 'utf8');
  for (const fragment of expectedText) assert(downloadedText.includes(fragment), `Downloaded TXT is missing ${fragment}`);
  await page.getByRole('button', { name: '重新识别', exact: true }).waitFor();

  step('replace the image during real inference; stale output must never repopulate the UI');
  const blank = await readFile(path.join(root, 'scripts/assets/baseline_blank.png'));
  const blankWidth = blank.readUInt32BE(16);
  const blankHeight = blank.readUInt32BE(20);
  await page.evaluate(({ bytes, width, height, expected }) => {
    const race = window.__imageToolsSmoke.race = {
      armed: true, triggered: false, blankDisplayed: false, oldReplyAfterBlank: false,
      staleText: [], file: new File([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))], 'baseline_blank.png', { type: 'image/png' }),
    };
    const observer = new MutationObserver(() => {
      const canvas = document.querySelector('canvas');
      if (race.triggered && canvas?.width === width && canvas?.height === height) race.blankDisplayed = true;
      if (!race.blankDisplayed) return;
      const heading = [...document.querySelectorAll('h2')].find((node) => node.textContent === '识别结果');
      const text = heading?.closest('section')?.textContent ?? '';
      if (expected.some((fragment) => text.includes(fragment))) race.staleText.push(text);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['width', 'height'] });
    race.stop = () => observer.disconnect();
  }, { bytes: blank.toString('base64'), width: blankWidth, height: blankHeight, expected: expectedText });
  await page.getByRole('button', { name: '重新识别', exact: true }).click();
  await page.getByText('未检测到文本，请尝试更清晰的图片', { exact: true }).waitFor();
  const raceResult = await page.evaluate(() => {
    const race = window.__imageToolsSmoke.race;
    race.stop();
    return {
      triggered: race.triggered, blankDisplayed: race.blankDisplayed,
      oldReplyAfterBlank: race.oldReplyAfterBlank, staleText: race.staleText,
      runs: window.__imageToolsSmoke.runs,
    };
  });
  assert(raceResult.triggered && raceResult.blankDisplayed, 'The in-flight replacement scenario did not execute');
  assert(raceResult.oldReplyAfterBlank, 'Old inference completed before replacement; stale-result race was not exercised');
  assert.deepEqual(raceResult.staleText, [], 'Old OCR output appeared after the blank image was displayed');
  const lastRun = raceResult.runs.at(-1);
  assert.equal(lastRun.width, blankWidth);
  assert.equal(lastRun.height, blankHeight);
  assert.equal(lastRun.result?.boxesFound, 0, `Blank image did not produce zero boxes: ${JSON.stringify(lastRun)}`);
  assert.equal(await page.getByRole('button', { name: '下载 .txt', exact: true }).count(), 0, 'Old TXT action survived blank-image replacement');

  if (hasRemoval) {
    step('navigate back to removal and wait for the OCR Worker to terminate');
    await page.getByRole('navigation', { name: '图片工具' }).getByRole('link', { name: '去背景', exact: true }).click();
    await page.waitForURL(url('/remove-bg'));
    await page.getByRole('heading', { name: '背景去除', exact: true }).waitFor();
    await page.waitForFunction(() => window.__imageToolsSmoke.active === 0);
    await page.waitForLoadState('networkidle');
  }
  let removalEvidence;
  if (testRemoval) {
    step('optional BEN2: explicitly confirm WASM, then load and run the real model');
    const before = await page.evaluate(() => window.__imageToolsSmoke.runs.length);
    const testImage = await readFile(path.join(root, 'scripts/assets/test_input.png'));
    const expectedWidth = testImage.readUInt32BE(16);
    const expectedHeight = testImage.readUInt32BE(20);
    await page.locator('input[type="file"]').setInputFiles(path.join(root, 'scripts/assets/test_input.png'));
    await page.getByRole('button', { name: '确认兼容模式', exact: true }).click();
    const progressLog = setInterval(() => {
      void page.evaluate((index) => ({
        run: window.__imageToolsSmoke.runs[index] ?? 'loading/session initialization',
        heartbeat: window.__imageToolsSmoke.heartbeat.count,
        inferenceElapsedMs: window.__imageToolsSmoke.runs[index]
          ? performance.now() - window.__imageToolsSmoke.runs[index].startedAt : null,
        status: document.querySelector('aside [aria-live]')?.textContent,
      }), before).then((value) => console.log(`[browser-smoke] BEN2 pending ${JSON.stringify(value)}`)).catch(() => {});
    }, 15_000);
    let completion;
    try {
      const observed = await page.waitForFunction((index) => {
        const run = window.__imageToolsSmoke.runs[index];
        if (run?.finished) return { run };
        const retry = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '重试' && button.getClientRects().length);
        if (retry) return { error: document.querySelector('aside [aria-live]')?.textContent ?? document.body.innerText };
        return false;
      }, before, { timeout: removalTimeout });
      completion = await observed.jsonValue();
    } finally {
      clearInterval(progressLog);
    }
    assert(!completion.error, `BEN2 browser initialization failed: ${completion.error}`);
    const removalRun = completion.run;
    assert(!removalRun.error, `BEN2 worker failed: ${JSON.stringify(removalRun.error)}`);
    assert.equal(removalRun.result.backend, 'wasm');
    assert.equal(removalRun.result.alphaLength, expectedWidth * expectedHeight, 'BEN2 returned an incorrectly sized matte');
    assert(removalRun.heartbeats >= 3, `Main-thread heartbeat stopped during inference: ${JSON.stringify(removalRun)}`);
    step('optional BEN2: decode the downloaded PNG and inspect its alpha channel');
    const pngButton = page.getByRole('button', { name: '下载 PNG', exact: true });
    const [pngDownload] = await Promise.all([page.waitForEvent('download'), pngButton.click()]);
    assert.equal(pngDownload.suggestedFilename(), 'test_input-remove-bg.png');
    assert.equal(await pngDownload.failure(), null, 'PNG download failed');
    const png = await readFile(await pngDownload.path());
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Download is not a PNG');
    const alpha = await page.evaluate(async (bytes) => {
      const file = new Blob([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))], { type: 'image/png' });
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let min = 255, max = 0, nonZero = 0, notOpaque = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          const value = pixels[index];
          min = Math.min(min, value); max = Math.max(max, value);
          if (value > 0) nonZero += 1;
          if (value < 255) notOpaque += 1;
        }
        return { width: bitmap.width, height: bitmap.height, min, max, nonZero, notOpaque };
      } finally {
        bitmap.close(); canvas.width = 0; canvas.height = 0;
      }
    }, png.toString('base64'));
    assert.equal(alpha.width, expectedWidth);
    assert.equal(alpha.height, expectedHeight);
    assert(alpha.nonZero > 0 && alpha.notOpaque > 0, `PNG alpha is entirely empty or opaque: ${JSON.stringify(alpha)}`);
    removalEvidence = {
      backend: removalRun.result.backend, totalMs: removalRun.result.totalMs,
      heartbeats: removalRun.heartbeats, maxHeartbeatGapMs: removalRun.maxHeartbeatGapMs,
      pngBytes: png.length, alpha,
    };
    console.log(`[browser-smoke] BEN2 structural result ${JSON.stringify(removalEvidence)}`);
    step('optional BEN2: return to OCR and verify removal Worker termination before the next Worker');
    await page.getByRole('navigation', { name: '图片工具' }).getByRole('link', { name: 'OCR', exact: true }).click();
    await page.waitForURL(url('/ocr'));
    await page.getByText('模型已就绪，上传图片即可识别', { exact: true }).waitFor();
    const workers = await page.evaluate(() => window.__imageToolsSmoke.workers);
    assert.equal(workers[1]?.name, 'image-tools-remove-bg');
    assert.equal(workers[1]?.closed, true, 'Removal Worker survived navigation back to OCR');
    assert.equal(workers[2]?.name, 'image-tools-ocr');
  }
  const metrics = await page.evaluate(() => ({
    created: window.__imageToolsSmoke.created,
    active: window.__imageToolsSmoke.active,
    maxActive: window.__imageToolsSmoke.maxActive,
    selections: window.__imageToolsSmoke.selections,
    runs: window.__imageToolsSmoke.runs.length,
  }));
  assert.equal(metrics.created, testRemoval ? 3 : 1, 'Unexpected tool Worker creation count');
  assert.equal(metrics.maxActive, 1, 'More than one heavy tool Worker was active');
  assert.deepEqual(metrics.selections, testRemoval ? ['ppocrv6-tiny', 'ppocrv6-tiny'] : ['ppocrv6-tiny']);
  assert.deepEqual(pageErrors, [], 'Browser raised an uncaught exception');
  assert.deepEqual(failedAssets, [], 'Static assets failed to load');
  const allowedModelDirectories = new Set(['ppocrv6-tiny', ...(testRemoval
    ? Object.values(removalModel.files).map((file) => file.url.match(/\/models\/([^/]+)\//)?.[1])
    : [])]);
  assert(requestedPaths.every((name) => {
    const modelId = name.match(/\/models\/([^/]+)\//)?.[1];
    return !modelId || allowedModelDirectories.has(modelId);
  }), 'An unselected model was fetched');
  assert(requestedPaths.some((name) => name.endsWith('.wasm')), 'No real WASM runtime was fetched');
  console.log(`[browser-smoke] PASS ${JSON.stringify({ basePath, mode: hasRemoval ? 'all-tools' : 'ocr-only', backend: firstRun.result.backend, ...(removalEvidence ? { removal: removalEvidence } : {}), ...metrics })}`);
} catch (error) {
  console.error(`[browser-smoke] FAIL at ${stage}:`, error);
  if (page && !page.isClosed()) {
    console.error('[browser-smoke] diagnostics:', JSON.stringify({
      url: page.url(), pageErrors, failedAssets,
      worker: await page.evaluate(() => {
        const state = window.__imageToolsSmoke;
        return state && { created: state.created, active: state.active, maxActive: state.maxActive, selections: state.selections, runs: state.runs };
      }).catch(() => null),
      body: await page.locator('body').innerText({ timeout: 3000 }).catch(() => '(unavailable)'),
    }, null, 2));
  }
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
