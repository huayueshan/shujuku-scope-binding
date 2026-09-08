import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('offline artifact contains exactly the release source and no user data', async () => {
  const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
  const artifact = JSON.parse(await readFile(new URL('../酒馆助手脚本-数据库三层绑定补丁.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(artifact.content, source);
  assert.equal(artifact.id, '8a8dd6ef-f59f-48fe-8b4b-57217946ef71');
  assert.deepEqual(artifact.data, {});
  assert.deepEqual(artifact.button.buttons, []);
  assert.equal(source.match(/const PATCH_VERSION = '([^']+)'/)?.[1], pkg.version);
});

test('manual worldbook refresh uses the existing themed command button', async () => {
  const source = await readFile(new URL('../patches/shujuku-scope-binding-patch.js', import.meta.url), 'utf8');
  assert.match(source, /class="sjbp-button sjbp-command-button" data-reset-write-worldbook/);
  assert.match(source, /\.sjbp-command-button \{[^}]*background: #20292d; color: #eef2f3;/);
  assert.match(source, /\.sjbp-footer-actions \.sjbp-button \{[^}]*min-height: 44px;/);
  assert.match(source, /<dt>用户设定（人设）<\/dt>/);
  assert.doesNotMatch(source, /<dt>Persona \/ Avatar<\/dt>/);
});
