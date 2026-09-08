import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');

test('the static documentation has complete local resources and valid section anchors', async () => {
  const html = await read('index.html');
  const allowlist = JSON.parse(await read('release-files.json'));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, href] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    if (href.startsWith('https://')) continue;
    if (href.startsWith('#')) assert.ok(ids.includes(href.slice(1)), href);
    else {
      assert.ok(allowlist.includes(href), href);
      await readFile(new URL(href, root));
    }
  }
  assert.doesNotMatch(html, /\bdownload=|href="dist\/|下载|jsDelivr/);
  for (const id of ['worldbooks', 'reading', 'templates']) {
    const section = html.match(new RegExp(`<section id="${id}">([\\s\\S]*?)</section>`))?.[1];
    assert.ok(section, id);
    assert.match(section, /怎么设置/);
    assert.match(section, /<ol class="steps">/);
    assert.match(section, /<figure class="guide-shot">/);
    assert.match(section, /<figcaption>/);
  }
  assert.match(html, /用户设定（人设）/);
  assert.match(html, /数据库二创/);
  assert.match(html, /使用要求：.*需要酒馆助手和数据库 spv9\.2\.3/);
  assert.doesNotMatch(html, /本地候选|尚未发布|data-status/);
  assert.match(html, /数据库表格专用世界书/);
  assert.doesNotMatch(html, /avatar（用户角色）|以下说明已对照|源码契约回归|shujuku 配套补丁/);
  assert.match(html, /site\/media\/worldbook-sync\.jpg/);
  const script = await read('site/script.js');
  assert.doesNotMatch(script, /本地候选|尚未发布|data-status/);
  assert.match(script, /进行过基本测试，没有进行实机测试/);
  assert.match(script, /进行过基本测试和实机测试/);
  assert.match(html, /同名表格以角色预设为准/);
  assert.match(html, /清空并更新写入世界书/);
  assert.match(html, /数据库原生就可以指定写入目标/);
  assert.match(html, /<code>\$4<\/code>/);
  assert.match(html, /<code>\$1<\/code>/);
  const evidence = await read('docs/BEHAVIOR.md');
  assert.match(evidence, /c99fa5c6811fbe23aad523091ad972d82a774f86/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="https?:/);
});

test('website version and compatibility data are generated from the release map', async () => {
  const context = { window: {} };
  vm.runInNewContext(await read('site/release-data.js'), context);
  const data = JSON.parse(JSON.stringify(context.window.releaseData));
  const pkg = JSON.parse(await read('package.json'));
  const map = JSON.parse(await read('compatibility.json'));
  const current = map.releases.find(r => r.patchVersion === pkg.version);
  assert.deepEqual(data, { version: pkg.version, status: current.status, database: current.database.map(({ tag, evidence }) => ({ tag, evidence })) });
  assert.ok((await read('index.html')).includes(`v${pkg.version}`));
});

test('all seven demo pictures are real JPEG files with accessible dimensions', async () => {
  const html = await read('index.html');
  const images = [...html.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
  assert.equal(images.length, 7);
  for (const image of images) {
    assert.match(image, /alt="[^"]+"/);
    assert.match(image, /width="\d+" height="\d+"/);
    const file = image.match(/src="([^"]+)"/)[1];
    assert.ok(file.endsWith('.jpg'));
    const bytes = await readFile(new URL(file, root));
    assert.equal(bytes.readUInt16BE(0), 0xffd8);
    assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9);
  }
});
