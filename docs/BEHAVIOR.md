# 使用说明的行为核查

核查日期：2026-09-10。本文对齐补丁 v1.7.11 与数据库 spv9.2.5，数据库固定提交为 `5c53f795832b194ec4baa74135e8ebd950122438`。不代表未来版本或使用者的实际安装版本。

## 数据库已经按角色保存哪些配置？

9.2.5 原生按角色保存填表世界书的写入目标、读取来源、手动选书和条目选择；剧情推进世界书也按角色保存。相同角色切换或新建对话，会继续使用该角色配置。它们不是每条对话独立存储，也不等于把配置嵌入可导出的角色卡。角色键不可用时才回退聊天键。见[角色作用域实现](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/settings/character-scope.ts)。这项行为在 9.2.3 已存在，不是 9.2.5 新增。

补丁则按“已有对话绑定 > 角色绑定 > 全局默认”选择配置，再应用到数据库当前使用的配置中。缺少对话绑定时才继承并保存。因此，补丁中查看“全局”，数据库中查看当前角色，数值不同不一定是保存失败。

关闭对话时，补丁允许保存全局默认，但不会把它强行写成数据库当前角色配置。表格预设和推进预设有各自的原生配置流程，不能把上述世界书存储规则套用到所有预设。已有对话的原生表格模板始终优先，修改角色或全局预设不会自动覆盖它。

## 写入目标与同步

- 数据库原生支持 `injectionTarget`：`character` 取角色主世界书，也可以直接指定书名。见 [injection-engine-state.ts](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/worldbook/injection-engine-state.ts#L131)。因此“指定专用世界书”不是补丁独有能力；补丁负责三层绑定与继承。
- 原生 `CHAT_CHANGED` 会延迟约 1200ms，再读取聊天、应用模板、合并数据和刷新。聊天尚未加载等路径会提前返回。见 [init.ts](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/presentation/bootstrap/init.ts#L241)。不能笼统写成“原版不会自动刷新”。
- `updateReadableLorebookEntry_ACU()` 无可用 `mergedData` 时直接返回，不先清理。见 [pipeline.ts](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/worldbook/pipeline.ts#L22)。源码顶部的开场抑制注释不能当作实际行为，因为 [shouldSuppressWorldbookInjection_ACU](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/runtime/helpers-data-merge.ts#L809) 当前恒为 `false`。
- 补丁的额外处理是记录写入目标切换，使用数据库清理 API，再等待和重试同步，并提供手动入口。清理仍受数据库生成条目识别、隔离编号与外部导入保护约束；不保证抹掉一本书中所有历史生成内容。见 [数据库清理实现](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/worldbook/pipeline.ts#L455)。
- 切换对话后补丁会阻止旧上下文继续推进；已经进入数据库内部的异步调用不等于能立即被撤销，不作这样的保证。

## 当前全部世界书

- 原生普通填表读取支持角色来源和手动列表，见 [getCombinedWorldbookContent_ACU](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/worldbook/pipeline.ts#L1395)。补丁将助手 API 返回的全局、角色、用户设定（人设）、对话绑定去重，转为数据库可读取的手动列表；不是全库扫描。
- “扩大书名来源”不等于“跳过激活条件”。内容仍经数据库自己的条目启用、关键词、递归及 Agent 等处理，并通过填表提示词的 `$4` 插入。见 [prompt-api-call.ts](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/ai/prompt-builder/prompt-api-call.ts#L119)。
- 剧情推进使用独立的 `plotWorldbookConfig`，按任务计算世界书内容，通过 `$1` 使用；剧情推进中的召回任务是否带入这些内容取决于任务提示词。见 [plot-task-engine.ts](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/runtime/plot-runtime/plot-task-engine.ts#L383) 及 [读取目标解析](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/runtime/plot-runtime/plot-task-engine.ts#L1114)。不要把这项功能描述为接管所有次要 API 或所有召回流程；交火向量检索是另一条流程。
- 原生新版已经按角色保存填表/剧情世界书配置。补丁增加的是统一的三层解析与当前来源汇总，不宣称原生完全没有角色级配置。见 [character-scope.ts](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/service/settings/character-scope.ts)。

## 角色模板与合并

- 数据库原生管理全局模板及对话快照，补丁不替代这些存储结构。已有原生对话模板优先；没有角色绑定时直接沿用原生全局回退。
- 补丁 `applyPresetBinding()` 只在缺少原生对话模板时补充角色继承；开启 `mergeGlobal` 后按全局、角色顺序合并。同名表格由后者替换，非同名表格保留，不是按行拼接。见 [补丁源码](../patches/shujuku-scope-binding-patch.js) 的 `mergeTableTemplatesCore()`、`applyPresetBinding()`。
- 手动合并同样由补丁组合模板，再调用数据库 `importTemplateFromData()`，参数为 `scope: 'chat'`、`dataMode: 'seed'`、`conflictPolicy: 'keep-current'`。迁移由数据库完成，而不是补丁直接改写聊天表格。见 [template-preset-api.ts](https://github.com/AlbusKen/shujuku/blob/5c53f795832b194ec4baa74135e8ebd950122438/src/presentation/bootstrap/api-groups/template-preset-api.ts#L96)。

## 图片证据

步骤图截自隔离酒馆的真实补丁面板，写入示例名称改为“数据库表格专用世界书”，其余使用“星港通用规则”“星港角色设定”“玩家身份”和“星港专用表格”。图片证明选择与绑定状态，不证明模型已读取具体条目。

角色图实际保存了角色合并绑定，并出现数据库原生对话快照。未发送模型请求。截图包含面板全景、局部控件及切换对话后的同步提示，未篡改文字或勾选状态；公开前已检查可见内容及文件元数据。

同步图来自两条演示对话之间的实际切换，同时记录到开始、完成提示和成功状态。为拍摄延长提示停留时间，随后恢复；没有模拟通知、手动伪造事件或调用模型。
