import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('compatibility map matches the exact current source and documents evidence limits', async () => {
  const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const map = JSON.parse(await read('compatibility.json'));
  const pkg = JSON.parse(await read('package.json'));
  const markdown = await read('COMPATIBILITY.md');
  assert.equal(map.schemaVersion, 1);
  assert.equal(map.unlistedDatabaseVersions, 'unverified');
  assert.equal(new Set(map.releases.map(r => r.patchVersion)).size, map.releases.length);
  const current = map.releases.filter(r => r.patchVersion === pkg.version);
  assert.equal(current.length, 1);
  assert.equal(current[0].sourceSha256, createHash('sha256').update(await read('patches/shujuku-scope-binding-patch.js')).digest('hex'));
  const source = await read('patches/shujuku-scope-binding-patch.js');
  const licenseHeader = `/*\n${await read('NOTICE')}*/\n`;
  assert.ok(source.startsWith(licenseHeader));
  assert.equal(createHash('sha256').update(source.slice(licenseHeader.length)).digest('hex'), current[0].liveTestSourceSha256,
    'Executable source must match the latest recorded live check; otherwise repeat acceptance.');
  for (const release of map.releases) {
    assert.ok(['candidate', 'released'].includes(release.status));
    assert.match(release.sourceSha256, /^[a-f0-9]{64}$/);
    if (release.status === 'candidate') assert.equal(release.releaseTag, null);
    else assert.equal(release.releaseTag, `v${release.patchVersion}`);
    assert.ok(release.database.length > 0);
    assert.equal(new Set(release.database.map(d => d.tag)).size, release.database.length);
    for (const database of release.database) {
      assert.match(database.tag, /^spv\d+\.\d+(?:\.\d+)?$/);
      assert.match(database.commit, /^[a-f0-9]{40}$/);
      assert.ok(['source-contract', 'live-basic', 'unverified', 'incompatible'].includes(database.evidence));
      assert.ok(database.limitations.length > 0);
      if (release === current[0]) assert.ok(markdown.includes(database.tag));
    }
  }
});
