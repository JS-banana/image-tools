import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

// Regression for nested Bash functions overwriting download_verified's _dest.
// Exercise the production function bodies with a local curl double: no network.
test('verified downloads atomically install into the final filename', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'image-tools-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = await readFile(new URL('../download_models.sh', import.meta.url), 'utf8');
  const definitions = path.join(directory, 'functions.sh');
  await writeFile(definitions, script.slice(0, script.indexOf('\ncase "$MODEL" in')));
  const destination = path.join(directory, 'model.onnx');
  const content = 'verified data';
  const hash = createHash('sha256').update(content).digest('hex');
  execFileSync('bash', ['-c', `
    definitions="$1"; target="$2"; digest="$3"; shift 3
    source "$definitions"
    curl() {
      while [ "$#" -gt 0 ]; do
        if [ "$1" = '-o' ]; then printf 'verified data' > "$2"; return 0; fi
        shift
      done
      return 1
    }
    download_verified 'https://fixture.invalid/model' fixture "$target" 13 "$digest"
  `, 'download-test', definitions, destination, hash], { encoding: 'utf8' });
  assert.equal(await readFile(destination, 'utf8'), content);
  await assert.rejects(access(`${destination}.part`));
});
