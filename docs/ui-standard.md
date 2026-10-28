# 配置生成器 UI 统一元素标准

> 适用范围：`aiplugin4-config` 的 7 个页签（模型 / 联网 / 角色 / 技能 / MCP / 知识库 / 事件触发）。
> 新增页签或改现有页签时，**通用元素必须按本文档实现**，不要各写一套。
> 实现入口：`js/ui.js`（toast / 复制 / 下载 / 文件选择 / 导入对话框 / 编辑侧栏 / 卡片动作）、`js/tabs.js`（页签）。

## 1. 页签

- 导航按钮：`<button class="view-tab" data-view="<id>">`，放在 `nav.view-tabs` 里。
- 当前页签：`class="active"` + `aria-selected="true"`；由 `js/tabs.js` 统一切换，各分区不要自己操作其它 layout。
- 每个页签一个 `<main class="layout" id="<id>Layout" hidden>`；切换到该页签时显示，其余隐藏。
- 支持深链：`?tab=<id>` 或 `#<id>`；默认 `model`。
- 页签顺序：模型配置、联网搜索、角色设定、技能、MCP、知识库、事件触发。

## 2. 页面布局

两个 `.pane`：

| 区域 | 内容 |
| --- | --- |
| 左（输入） | `.pane-head`（标题 + `.pane-hint`）+ 卡片网格 `.card-grid`（或该分区的说明/拖放区） |
| 右（输出） | `.pane.pane-output`：标题行（含遮蔽/格式化开关）→ 校验区 `.validation` → 预览 `.preview` → 工具栏 `.actions` → 文件导入结果 → 使用说明 `details.usage-box` |

窄屏（≤1080px）由 `.layout` 自动单列，不要另写断点。

## 3. 卡片动作（统一）

所有可排序的条目卡片，底部动作按钮**顺序固定**：

```
↑    ↓    编辑    删除
```

| 按钮 | 类名 | title | 说明 |
| --- | --- | --- | --- |
| ↑ | `btn btn-sm btn-move` | 上移 | 第一位禁用 |
| ↓ | `btn btn-sm btn-move` | 下移 | 最后一位禁用 |
| 编辑 | `btn btn-sm btn-edit` | 编辑 | 打开右侧编辑面板 |
| 删除 | `btn btn-sm btn-danger` | 删除 | 先 `confirm` 再删 |

- 统一由 `ui.js` 的 `cardActions({canUp,canDown,onUp,onDown,onEdit,onDelete})` 生成，不要手写按钮。
- 编辑按钮文字固定「编辑」；确需展开/收起语义时只允许在同一个按钮上切换「编辑 / 收起」，位置不变。
- 「+ 添加」卡片：`<div class="dcard dcard-add">+ 添加<条目名></div>`（模型/联网页沿用 `pcard pcard-add`，视觉一致）。

### 启用开关

- 每张条目卡片头部都要有 `label.toggle > input[type=checkbox]` + 文字「启用」。
- 关闭只影响**是否写进生成的 JSON**：不产生 `enabled` 字段，直接把该条目从输出里移除。
- 校验跳过已停用条目（停用条目里的空字段不应阻止复制）；输出为空是合法状态。
- 卡片可以加 `is-off` / 半透明样式，但条目本身要保留在界面上，方便重新启用。
- 模型页关闭连接时，同时清掉 `purposes` 里指向该连接模型的绑定，避免输出引用不存在的模型。

## 4. 工具栏（统一）

所有页签的 `.actions` 顺序固定：

| 顺序 | 按钮 | 类名 | 说明 |
| --- | --- | --- | --- |
| 1 | 复制全部 | `btn btn-primary` | 校验不通过时 `disabled` |
| 2 | 下载 .json | `btn` | 下载当前预览内容 |
| 3 | 导入… | `btn` | 打开**统一导入对话框** |
| 4 | 导入文件… | `btn` | 系统文件选择器，读取后走同一套解析 |
| 5 | 恢复默认 | `btn` | 恢复该分区出厂默认 |
| 6 | 清空 | `btn` | `confirm` 后清空 |

- 模型 / 联网 / 内容分区都遵循这个顺序；内容分区由 `js/domain-app.js` 生成，模型 / 联网在 `index.html` 里同样顺序。
- 复制/下载/文件读取/导入对话框统一用 `js/ui.js` 的 `copyText` / `downloadText` / `pickFiles` / `readFileText` / `openImportDialog`。

## 5. 导入对话框（统一）

所有页签的「导入…」都打开**同一个右侧导入面板**（`index.html` 里的 `#importPanel`，由 `js/ui.js` 接管），不再新增内联导入框。

| 元素 | 约定 |
| --- | --- |
| 标题 | `openImportDialog({title})`，如「导入技能配置」 |
| 说明 | 统一说明：导入会**替换**当前内容；校验不通过时不会改动任何东西 |
| 输入 | `#importText`（`.json-area`），占位符写该分区 JSON 示例 |
| 错误 | `#importMsg`，列前 8 条 `路径 消息` |
| 按钮 | 取消 / 导入（`btn` / `btn btn-primary`） |
| 关闭 | `×`、取消、点遮罩都关闭并清空输入 |
| 失败 | 面板保持打开，页面内容不变 |
| 成功 | 关闭面板、清空输入、调用分区自己的 `onSuccess` |

不要给某个页签单独做 `webImportBox` / `ImportBox` 之类的内联导入框。

## 6. 编辑侧栏（统一）

- 「编辑」按钮打开右侧面板（`.panel` + `.backdrop`），不要改成卡片内展开。
- 通用实现：`ui.js` 的 `openSideEditor({title, body, onSave, onCancel})`；联网分区已接入，模型 / 内容分区现有的 `#panel` / `#domainPanel` 与它视觉、行为一致。
- 面板结构：`.panel-head`（标题 + `×`）→ `.panel-body` → `.panel-foot`（取消 / 保存）。
- 保存时先校验/归一，再写回状态；取消丢弃改动。
- 表单字段统一用 `.field` / `.field-label` / `.field-note`；JSON 字段用 `.json-area`，解析失败留在面板并提示。
  - `type: 'json'` 默认只接受对象；数组字段可加 `jsonKind: 'array'`，保存时要求是 JSON 数组。
  - 多行字符串数组（如事件触发的 `sessions` / `exclude`，每行一个 UNI-ID）用 `type: 'lines'`，与数组自动互转。
  - 下拉分组：`type: 'select'` 支持 `optionGroups`（分组）+ `options`（末尾追加项），两者可以是数组或返回数组的回调。
  - 条件行编辑器：`type: 'conditions'`（「字段 / 操作 / 值 / 删除」行，含「直接编辑 JSON」折叠与双向同步；字段/值选项由 spec 的 `conditionFields` 提供，可带枚举值）。事件触发的 `match` 使用它。
  - 折叠分组：`type: 'details'` 渲染 `<details>` 子字段（如事件触发的「作用范围（高级）」）。
  - 条件显示：字段可加 `visibleIf(draft)`（如「自定义事件名」仅在选中「自定义事件…」时出现）。
  - 字段级操作按钮：`actionLabel` + `onAction(draft)`，返回 `true` 时重渲染面板。
  - 分区钩子：`onFieldChange(fieldKey, value, prevValue, draft)` 在字段变更后调用，返回 `true` 时重渲染（事件触发用它切换事件时套用该事件的默认条件）；`cardTitle(item)` 可自定义卡片标题（事件触发用中文事件短名）。

## 7. 文件导入（统一）

- 触发：工具栏「导入文件…」或左侧拖放区；统一用 `ui.js` 的 `pickFiles` 和 `readFileText`。
- 单文件上限 2MB；逐文件解析，失败的列在该页签的 `.file-msg` 中，**不破坏已有内容**。
- 文件类型：
  - 技能：标准 `SKILL.md`（跨 agent 通用格式，frontmatter 里取 name/description/platform，正文作 content）；
  - 知识库：`.md` / `.txt`（`#` 标题作库名，首段作描述，正文原样）；
  - 角色：`.md` / `.txt`（文件名作角色名，整份文本作设定）；
  - MCP：标准 `mcpServers` JSON（Claude Desktop / Cursor `.mcp.json`）；
  - 事件触发：`.json`（与「触发 → 事件触发规则」同格式的规则文档，或裸规则数组）；
  - 模型 / 联网：`.json`（各自的 v5 / web schema）。
- 除技能外，**不解析 frontmatter**；插件自定义格式一律用 JSON，不再引入第二种文本格式。

## 8. 密钥输入

- API Key / Token 一律用 `ui.js` 的 `apiKeyInput(value, onChange, { placeholder })`：
  `type=password` 输入框 + 「显示/隐藏」按钮，外层 `.key-row`。
- 不要再各页签手写普通 `text` 输入框；模型连接、联网 provider、MCP token 都用同一套。
- 提示文案统一说明：明文写入生成的配置、只存本机浏览器、分享时用「遮蔽」。
- 遮蔽按钮只改导出副本，不改内存里的真实值。

## 9. 开关与提示

- 「遮蔽敏感信息」只在有敏感字段的页签出现（目前 MCP）；「格式化」所有页签都有，位置在输出区标题行右侧。
- 校验结果统一放 `.validation`：错误红色 `.vtitle`，提示黄色 `.vtitle.warn`；错误时复制按钮禁用。
- 操作反馈统一用 `ui.js` 的 `toast(msg, 'ok' | 'err')`，不弹 `alert`（删除确认除外）。
- 文案用中文；不使用 emoji；图标优先用文字或 CSS，不引入字符箭头以外的装饰。

## 10. 视觉与可访问性

- 字号用 rem，最小 12px；控件、面板、按钮沿用 `css/styles.css` 既有变量与类，不新增一套配色。
- 原生控件 `color-scheme: dark`；`select` 用统一自绘箭头。
- 键盘可达：按钮用 `<button type="button">`；面板/对话框加 `role="dialog"`、`aria-modal="true"`；`×` 有 title。
- 动效遵守 `prefers-reduced-motion`。

## 11. 自检清单

新增/修改页签后至少确认：

- [ ] 页签按钮有 `data-view`，切换后其它 layout 隐藏。
- [ ] 卡片动作顺序/类名/title 与本文档一致。
- [ ] 每张卡片有「启用」开关；关闭后条目从输出移除，输出里没有 `enabled` 键。
- [ ] API Key / Token 使用 `ui.js` 的 `apiKeyInput`（密码框 + 显示/隐藏）。
- [ ] 工具栏 6 个按钮顺序一致，「复制全部」是 `btn-primary`。
- [ ] 「导入…」打开统一 `#importPanel`；非法内容不关面板、不改内容。
- [ ] 「编辑」打开右侧面板；保存/取消行为正确。
- [ ] 文件导入失败有逐文件提示，已有内容不丢。
- [ ] `node tests/run.mjs`、`node tests/domains-run.mjs`、浏览器交互测试通过。
