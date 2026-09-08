# 角色卡内嵌表格预设标准

## 目的与范围

本标准供“数据库三层绑定补丁”与角色卡作者共同使用。目标是让角色绑定和填表模板随角色卡导出、分享和导入，不依赖接收者本机已有同名全局预设。

当前版本只定义 `table`（填表模板）。根结构预留 `embeddedPresets` 分类，后续可以新增 `plot` 等类型而不修改现有字段。

## 实际存储位置

补丁通过酒馆助手直接全局变量 API 写入：

```js
getVariables({ type: 'character' })
updateVariablesWith(updater, { type: 'character' })
```

酒馆助手把角色变量保存到角色卡扩展字段：

```text
data.extensions.tavern_helper.variables.ShujukuScopeBindingCharacterV1
```

因此角色卡正常导出后，这部分会随卡携带。不要把内嵌预设写进脚本自己的 `data`、全局变量或聊天变量。

## 数据结构 v1

```json
{
  "version": 1,
  "profiles": {
    "__default__": {
      "bindings": {
        "tablePreset": {
          "source": "embedded",
          "presetName": "",
          "embeddedPresetId": "hero-main",
          "mergeGlobal": true
        }
      },
      "embeddedPresets": {
        "table": {
          "hero-main": {
            "schema": "shujuku-table-template",
            "version": 1,
            "id": "hero-main",
            "name": "角色主模板",
            "template": {
              "mate": {
                "type": "chatSheets",
                "version": 1
              },
              "sheet_status": {
                "uid": "sheet_status",
                "name": "状态表",
                "orderNo": 0,
                "sourceData": {},
                "content": []
              }
            },
            "source": {
              "type": "globalPreset",
              "name": "制卡时使用的全局预设",
              "copiedAt": 0
            },
            "updatedAt": 0
          }
        }
      },
      "legacyImported": true
    }
  }
}
```

使用数据库隔离配置时，`profiles` 的键改为对应 `dataIsolationCode`；没有隔离码时使用 `__default__`。

## 字段契约

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| 根 `version` | 是 | 当前固定为 `1`。 |
| `profiles` | 是 | 按数据库隔离码保存独立绑定和内嵌预设。 |
| `bindings` | 是 | 当前角色的五项三层绑定；结构与补丁公开绑定格式一致。 |
| `embeddedPresets.table` | 是 | 以稳定 ID 为键的填表内嵌预设表；可以为空对象。 |
| `schema` | 是 | 填表模板固定为 `shujuku-table-template`。 |
| 预设 `version` | 是 | 当前固定为 `1`。 |
| `id` | 是 | 卡内稳定且唯一；绑定引用此 ID，不引用显示名。 |
| `name` | 是 | UI 显示名，可与全局预设同名。 |
| `template` | 是 | 数据库 `getTableTemplate()` 返回的完整模板对象。必须包含至少一个 `sheet_*`。 |
| `source` | 否 | 仅用于记录复制来源，不参与运行逻辑。 |
| `updatedAt` | 否 | Unix 毫秒时间戳；缺失按 `0` 处理。 |
| `legacyImported` | 内部 | 表示旧脚本变量中的角色绑定已经迁移，避免解绑后被再次导入。 |

`template` 应保存对象，不使用 Base64，不做二次 JSON 字符串化。模板可包含 `mate`、`sheet_*`、`sourceData`、`content`、`seedRows`、更新配置和导出配置；不要放入当前聊天已经产生的运行行数据。

## 绑定格式

绑定全局命名预设：

```json
{
  "source": "global",
  "presetName": "通用冒险模板",
  "embeddedPresetId": "",
  "mergeGlobal": false
}
```

绑定角色内嵌预设：

```json
{
  "source": "embedded",
  "presetName": "",
  "embeddedPresetId": "hero-main",
  "mergeGlobal": true
}
```

旧版字符串和 `{ "presetName": "...", "mergeGlobal": false }` 仍按全局命名预设读取。

## 应用与合并语义

- `mergeGlobal: false`：把所选全局预设或内嵌模板直接物化为当前聊天模板快照。
- `mergeGlobal: true`：先读取接收者当前全局模板，再叠加角色所选模板。
- 表名不同的表全部保留。
- 规范化后同名时，后加入的角色模板整表覆盖全局模板；不会逐字段拼接。
- 自补丁 v1.7.9 起，合并只在聊天完全没有原生模板时自动执行。`game_init`、`chat_template_pristine_switch`
  也属于已有模板，不再被视为可替换的临时初始化。已有聊天不会因角色卡或全局模板后来变化而被静默改写。
- 制卡时，如需由角色绑定初始化，请只配置本标准的角色绑定及内嵌模板，不要另一个开局脚本抢先导入聊天模板。
  如果卡脚本已经导入，补丁会尊重其结果；需叠加时改用手动合并。
- 对话模板的普通选择和解除交给数据库原生界面；存储 schema、版本及内嵌字段没有改变。
- “重新应用到当前对话”可显式选择全局、聊天、全局命名预设和角色内嵌预设并排序；越靠下优先级越高。
- 全局命名预设与角色内嵌预设使用不同的稳定来源键。即使二者显示名相同，也会分别显示为“全局预设 · 名称”和“角色内嵌 · 名称”，可单独选择或同时加入合并顺序。

## UI 操作

在“数据库三层绑定 > 表格预设 > 角色”中：

1. 选择一个全局命名预设或默认全局模板。
2. 点击“复制为内嵌”，输入角色卡内显示名。
3. 选择新增的“内嵌 · 名称”，按需开启“合并当前全局模板”。
4. 点击链接按钮保存角色绑定。

删除当前选中的内嵌预设时，如果角色绑定正引用它，补丁会同时清除该角色绑定；已经物化到旧聊天中的数据库原生快照不会被删除。

选择角色内嵌预设后，可点击“复制到全局”把其模板正文写入数据库全局预设库。用户可指定目标名称；同名目标必须确认后才覆盖。复制只增加或更新全局预设，不改变当前全局选择、角色绑定、合并开关或已有聊天快照。spv8.4、spv8.9.2 与 spv9.1 的 `importTemplateFromData({ scope: 'global' })` 都是“只保存、不切换”的契约，补丁不得在导入后额外调用 `switchTemplatePreset()`。若数据库不再提供 `getTemplatePresetNames()`，补丁必须停止复制，不能绕过同名覆盖确认。

## 迁移规则

v1.7.0 首次在某角色与隔离配置下运行时：

1. 读取脚本变量中旧的 `profiles[isolation].characters[characterKey]`。
2. 合并到角色变量 `profiles[isolation].bindings`，角色卡中已存在的值优先。
3. 写入 `legacyImported: true`。
4. 写入成功后删除脚本变量里的该角色旧副本。

没有旧角色绑定且角色卡尚无本补丁数据时，仅读取不会创建空扩展字段；只有第一次保存角色绑定或内嵌预设时才写入角色卡。

全局绑定和 UI 选择仍保存在脚本变量；对话快照仍保存在聊天变量或数据库原生聊天模板状态。只有角色绑定与内嵌预设迁入角色卡。

## 制卡校验

发布角色卡前至少确认：

- 导出的角色 JSON/PNG 扩展数据包含 `data.extensions.tavern_helper.variables.ShujukuScopeBindingCharacterV1`。
- 每个 `embeddedPresets.table` 键与内部 `id` 相同且卡内唯一。
- 每个模板至少有一个具备非空 `name` 的 `sheet_*`。
- `bindings.tablePreset.embeddedPresetId` 指向实际存在的内嵌预设。
- 在一个没有同名全局预设的新环境中，新建聊天仍能创建所需表格。
- 开启合并时，同名表由角色模板覆盖，不同名全局表被保留。
