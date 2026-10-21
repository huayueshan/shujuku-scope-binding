# 活动 API 三层绑定

候选版本：`1.7.13-dev.4`。数据库源码依据：`naiv1.3`，提交 `8508c85714798af38d363a13c019dd906f2063a0`。

## 故障与修正

数据库的 `setDefaultApiPreset_ACU()` 只保存默认名称。`getActiveApiPresetName_ACU()` 会用默认名称作为界面显示的回退，但 `reconcileApiBindingForCurrentChat_ACU()` 只把明确的对话绑定投影到 `apiMode`、`apiConfig`、`tavernProfile`。因此默认名称与实际请求连接可以不一致。

依据：[API 预设服务](https://github.com/AlbusKen/shujuku/blob/naiv1.3/src/service/settings/api-preset-service.ts)、[API 预设 store](https://github.com/AlbusKen/shujuku/blob/naiv1.3/src/presentation-v2/stores/api-preset-store.ts)。

补丁新增「活动 API 预设」选择器，沿用搜索、全局/角色/对话范围和链接/解除按钮。应用时比较完整连接字段，不只比较名称；第一次应用及上下文改变后会通过现有数据库保存适配器捕获运行对象，防止持久化数据正确而实际运行仍旧。

## 绑定与存储

- 全局：数据库自身 `defaultApiPresetName`，不需要角色或对话。
- 角色：角色卡现有 `ShujukuScopeBindingCharacterV1.profiles[隔离键].bindings.apiPreset`，值只能是预设名称字符串。需要已加载角色。
- 对话：数据库自身 `apiPresetBindingsByChat[chatKey]`，结构为 `{ presetName, updatedAt }`。需要打开对话；禁止写入 `unknown_chat`。
- 生效优先级：明确的数据库对话绑定 > 角色绑定 > 数据库全局默认。
- API 继承是动态回退，不把继承结果自动固化为对话绑定；这与世界书首次继承为对话快照不同。解除对话绑定后恢复角色/全局回退，解除角色绑定后恢复全局回退。
- 清除所有绑定后保留当前连接，不清空用户连接参数。停止或卸载补丁也不删除数据库的原生全局/对话绑定。
- 角色卡只携带名称，不内嵌连接信息。接收者需自行在数据库建立同名 API 预设。找不到或出现重名时提示错误，不猜测另一个预设。
- 填表或剧情任务显式指定的 API、模型等覆盖保持原样。已经发出的请求不会被取消或重发。

## 适配边界

当前数据库已废弃公开 `getApiPresets/loadApiPreset` 等方法，不能用空返回值判断没有预设。本功能复用项目已有的私有设置保存适配器，在数据库自己的保存序列化期间修改允许的五个字段，再从持久化变量独立核对。它不是新公开 API，数据库升级后必须检查字段结构和保存路径。

不把 API 密钥、URL、请求头写入角色卡、补丁变量、诊断结果或日志。运行时只做内部复制与比较；错误信息不会透传可能含连接详情的底层异常。没有修改数据库本体。

旧数据库缺少结构时跳过自动 API 应用，现有世界书/模板功能继续工作；明确操作新功能时提示不支持。发生保存错误时尽量恢复本次写入的运行字段；如果已切换上下文或存在后续原生修改，不用旧快照覆盖它们。保存确认失败绝不报告成功。

## 验证

`tests/shujuku-active-api-binding.test.mjs` 用真实补丁函数和模拟存储/数据库运行对象检查默认名称与连接不一致、三层优先级、无对话全局保存、切换对话与重新加载、相同名称修改参数、旧版跳过、保存失败、并发和上下文取消。另一个用例直接执行真实 `captureObjectViaStringify` 与保存适配器，检查实际对象、持久化 JSON 和 stringify 恢复。

`tests/live/scope-active-api-server.mjs` 提供本地模拟页，提取当前源码的选择器、行布局、样式与保存逻辑。内置浏览器通过 8 项模拟检查；390×844 面板宽378px，360×800宽348px，均无横向溢出，操作按钮44px。360px下点击长名称预设并绑定后，模拟运行配置更新成功。

本次没有运行完整数据库本体或真实模型请求，没有访问生产酒馆。上述结果是模拟验收，不是生产实机验证。
