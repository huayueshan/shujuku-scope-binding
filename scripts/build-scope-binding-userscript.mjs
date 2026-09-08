import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'patches', 'shujuku-scope-binding-patch.js');
const outputPath = path.join(root, '酒馆助手脚本-数据库三层绑定补丁.json');
const content = await readFile(sourcePath, 'utf8');

const userscript = {
  type: 'script',
  enabled: true,
  name: '数据库三层绑定补丁',
  id: '8a8dd6ef-f59f-48fe-8b4b-57217946ef71',
  content,
  info: '基本实机验证 shujuku spv9.2.3；兼容性回归覆盖 spv8.4、spv8.9.2、spv9.1、spv9.1.6，不代表整个连续版本区间均已验证。世界书与剧情预设支持全局/角色/对话绑定；对话表格模板由数据库原生管理，补丁提供工作台入口，只在缺少对话模板时补角色继承，无角色绑定则沿用数据库全局模板。角色内嵌填表预设可双向复制、删除和绑定，可选合并全局，同名角色优先。保留有序多模板手动合并并通过数据库公开 API 协调迁移，区分同名全局与内嵌来源。非手动世界书来源不保存条目 UID 快照。入口位于扩展程序菜单；控制台核验：ShujukuScopeBindingPatch.verify()。',
  button: {
    enabled: true,
    buttons: [],
  },
  data: {},
};

await writeFile(outputPath, `${JSON.stringify(userscript, null, 2)}\n`, 'utf8');
console.log(path.relative(root, outputPath));
