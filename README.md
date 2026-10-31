# aiplugin4 配置生成器

给 [aiplugin4](https://github.com/error2913/aiplugin4)（SealDice AI 插件）用的**模型 / 联网 / 角色 / 技能 / MCP / 知识库 / 事件触发配置可视化生成器**。

点选供应商 → 填 API Key → 选模型（或选搜索方言 / 编辑条目）→ 复制生成的 JSON 粘进海豹，不用手写配置。

> **零依赖纯静态页面**，双击 `index.html` 即可跑（建议用 `node serve.mjs`，见「用法」）。
> 产出 **v5 JSON 模型配置**、**联网配置 JSON**，以及**角色设定 / 技能 / MCP / 知识库 / 事件触发规则五份 JSON**（各自单框，分别粘贴）；插件侧见下方「适配状态」。

## 为什么需要它

插件的模型配置是**手写 TOML**，而且有几个反直觉的硬性规则，写错了插件只在日志里丢一行、界面上表现为"模型莫名没了"：

| 坑 | 后果 |
| --- | --- |
| `[types]` 表必须写在**本框最后** | 其后出现任何键 → 整框解析失败 |
| 模型名含 `.` `:` `/` 时 `[types]` 键**必须加引号** | 被解析成嵌套表，该键失效 |
| 规则靠**模型名字符串**匹配连接 | 改名/换清单 → 规则静默失配 |
| 连接**框序**是语义（`[0]:模型名`） | 删/挪一个框，引用全部漂移 |
| 用途绑定存在插件内部存储里 | 重装/迁移即丢 |

v5 用**单个 JSON 配置**替换这些，生成器负责产出正确结构。

## 用法

```bash
node serve.mjs          # 默认 8099；也可 node serve.mjs 8080
# 打开 http://127.0.0.1:8099/
```

**请用 `serve.mjs`，不要用 `python -m http.server`。** 后者**不发 `Cache-Control`**，
浏览器于是按启发式缓存复用旧文件 —— 改了 `app.js` 按 F5 却仍跑旧代码，
表现为"我明明改了它却没生效"（本轮排查 Key 持久化时就踩了这个坑，
最后靠 Ctrl+F5 才确认修复其实早已生效）。

`serve.mjs` 对所有响应发 `Cache-Control: no-store`，刷新必定拿到最新文件。

或直接双击 `index.html`（但 `file://` 下剪贴板 API 受限，建议起服务）。

**操作流程**

1. 点「+ 添加」或卡片上的「编辑」→ 右侧打开编辑面板
2. 选**接入方式**：
   - **模型供应商**：下拉选厂商，`api` 与 `baseURL` 自动填好
   - **自定义 URL**：面向 one-api / new-api / 自建服务
3. 填 **API Key**
4. 展开**高级自定义** → 选模型：
   - 点「**自动拉取模型列表**」，拉到后**点卡片多选**
   - 或**手动输入**模型名（始终可用）
5. 在**用途绑定**里点模型卡片指定各用途用哪些模型 —— **角标是取用顺序**（插件先用 1，失败时顺着 2、3… 往后切）。一个都不选 = 由插件按该用途候选的第一个取
6. 点「**复制全部**」→ 粘到 SealDice WebUI →「JS插件」→「插件设置」→ aiplugin4 →「模型」→ **模型配置**
7. 重载 JS 生效

> 本工具**不会**自动写入海豹 —— 纯静态页面访问不到你的海豹实例，只负责生成正确文本。

## 功能

- **11 个内置供应商模板**，各带默认 `baseURL`、协议与模型名示例
- **自动拉取模型列表**：浏览器直连 `GET /models`，结果做成可点击卡片多选
- **自动预填模型类型**（`kind`）：识别嵌入/生图/语音模型，让配置显式化；`decision`（System One 决策模型）不自动识别，需手动选择，且只能绑定「评分」
- **连接卡片**：每张卡 = 一个连接，可编辑/删除；顺序即插件里的连接顺序
- **用途绑定**：7 个用途各一组模型卡片，点击绑定，**角标 = 取用顺序**（可绑多个，插件按顺序取用并在失败时往后回退）；每张用途卡都显示用途说明。judge 统一叫「**评分**」（给每条消息评分、决定是否主动插话），额外给出**选型提示**（推荐模型 / 价格档 / 结构化输出 / 思考支持，**只提示不预选**，不会自动改绑定）
- **逐模型「用途请求体」（`models[].request.bodyByUse`）**：在连接编辑面板里为**每个模型**单独添加，默认 0 条 = 不写字段。每条 = 用途下拉 + 请求体 JSON + 删除按钮；用途按模型类型过滤（文本：对话 / 总结 / 评分；视觉另加图片识别；嵌入 / 生图 / 语音不显示入口），同一用途只能一条。它优先于内置预设，用来给「评分」这类用途单独设 `temperature: 0`、小 `max_tokens` 或 `thinking` 等厂商字段（生成器**不按 vendor 猜**关思考字段，需要时自己填）
- **实时预览**：右侧常驻显示生成的 JSON，编辑过程中即时更新
- **校验 + 路径报错**：`$.providers[1].models[0].kind` 形式指出问题，有问题时禁止复制
- **遮蔽 API Key**：导出时换成 `sk-xxxx`，方便截图分享
- **格式化开关**：输出默认紧凑单行，打开后多行缩进（模型 / 联网两个输出窗口都有）
- **本地草稿**：自动存 localStorage
- **角色 / 技能 / MCP / 知识库 / 事件触发五个页签**：各自生成一份 JSON；支持文件导入（SKILL.md / Markdown / 文本 / MCP JSON / 规则 JSON）、JSON 导入导出、MCP 敏感信息遮蔽（详见下文）

### 联网搜索分区

顶栏「联网搜索」页签为插件「联网 → 联网配置」生成 JSON（独立于模型配置，两边数据互不影响）：

- **Provider 卡片**：内置 10 家方言 + 自定义（generic），顺序即搜索/抓取尝试顺序（前一个失败自动换下一个）：
  DeepSeek / SearXNG / Kimi (Moonshot) / Brave Search / Tavily / Serper / 博查 Bocha / 智谱 Web Search / Exa / Firecrawl；
- 每家只需选方言、填 API Key（SearXNG 不用 Key），默认 `baseURL` 已内置；
- **generic** 用 JSON 描述任意 HTTP 搜索/抓取接口（请求模板占位符 + 响应取数路径），不用改插件代码；Jina Reader 这类未内置的走它；
- 右侧实时产出「联网配置」，可复制 / 下载 / 导入；校验不通过时禁止复制；
- 默认输出**紧凑单行**（省版面、直接可粘贴）；「**格式化**」开关可展开为多行缩进，便于阅读；
- 字段与插件侧 schema v1 对应；**返回条数 / 详细程度 / 超时 / 正文截断 / 失败回退不再写进 JSON**，它们是插件「联网」页的独立配置项（返回条数、联网搜索详细程度、联网搜索超时、联网搜索正文截断、联网搜索失败回退），生成器不再输出 `defaults`。
- OpenAI / Anthropic / Gemini / xAI / Qwen 等**模型自带的托管搜索**不是独立 provider，属于模型请求参数，见插件仓库 `docs/04 工具系统`。

纯逻辑在 `js/web.js`，自检：`node tests/web-check.mjs`。

### 角色 / 技能 / MCP / 知识库 / 事件触发分区

顶栏另外五个页签分别生成一份独立 JSON，各自粘贴到插件对应配置项（都是**单框 String 配置**）：

| 页签 | 粘到插件 | JSON 形态 | 生效方式 |
| --- | --- | --- | --- |
| 角色设定 | 角色设定 →「角色设定」 | `{version:1, roles:[{name,prompt}]}` | 重载 JS；`.ai role` 切换 |
| 技能 | 技能 →「技能列表」 | `{version:1, skills:[{name,description,platform,content}]}` | `.ai skill refresh` |
| MCP | MCP →「MCP服务器」 | **标准 MCP JSON**：`{"mcpServers":{"<服务器名>":{"type":"http","url":"…","headers":{…}}}}`；另支持扩展字段 `platform` 与 `capability` | `.ai mcp refresh`（先开「是否启用MCP」） |
| 知识库 | 知识库 →「知识库配置」 | `{version:1, libraries:[{name,description,platform,content}]}` | `.ai kb refresh` |
| 事件触发 | 触发 →「事件触发规则」 | `{version:1, rules:[{on,scope,match,prompt}]}`（一条规则一个扁平事件名） | 重载 JS |

共同点：

- **一个分区一份 JSON，互不影响**；顺序 = 插件里的运行时顺序（角色序号 / 技能展示顺序 / 服务器顺序 / 知识库展示顺序 / 规则匹配顺序）。
- 平台白名单省略或 `[]` = 所有平台（内容分区是 `platform`，事件触发是 `scope.platforms`）。
- **每个条目卡片都有「启用」开关**：关闭的条目只留在生成器草稿里，**不会写进生成的 JSON**（不产生 `enabled` 字段）；MCP 同理，关闭 = 直接从 `mcpServers` 里移除。
- **直接导入文件**：
  - 技能：标准 `SKILL.md`（`---` frontmatter + 正文，这是其他 agent 通用的技能文件格式），一个文件一个技能；
  - 知识库：`.md` / `.txt`，库名取第一个 `# 标题`，没有标题时用文件名；描述取正文首段；
  - 角色：`.md` / `.txt`，文件名作为角色名，整份文本作为设定；
  - MCP：`.json`，**要求标准 `mcpServers` 结构**（与 Claude Desktop / Cursor 的 `.mcp.json` 一致）；支持 aiplugin4 扩展字段 `platform` / `capability`（旧字段 `imageRefs` 兼容）；stdio（`command`）与 SSE 会明确警告并跳过；
  - 事件触发：`.json`，与「触发 → 事件触发规则」同格式（规范对象或裸数组都行）。
- 也支持把已有 JSON 粘进「导入…」继续改；导入会**替换**当前页签内容，校验不通过时不动任何东西。
- 「恢复默认」：角色 / 技能 / 知识库与插件出厂默认一致；**MCP 插件的出厂默认为空**，生成器保留四台示例（`mcp-files-exec` / `md-html-render` / `mcp-browser` / `image-host`，其中 `image-host` 用 `capability: "image-host"`）供按需复制；**事件触发出厂默认为空**，默认输出 `{"version":1,"rules":[]}`。默认数据由 `tools/sync-default-data.mjs` 从插件源码生成，插件改默认值时重跑。
- MCP 输出是**标准 MCP JSON**：顶层 `mcpServers` 对象，键 = 服务器名，字段用 `type` / `url` / `headers`；`token` 只是输入简写，导出时合并成 `Authorization: Bearer …`，不会输出非标准字段；`platform` 与 `capability` 是 aiplugin4 的扩展字段（标准客户端会忽略未知字段）。启用开关关闭的服务器直接不出现。
- MCP **能力声明 `capability`**（下拉：不填 / `image-host`）：`image-host` 表示该服务器提供图床画廊能力（`image_search` / `image_keep` / `image_unkeep` / `image_tag`），插件据此注册图床适配器。未知值按**警告后忽略**处理（与插件解析同口径），不会让整份导入失败。旧字段 `imageRefs: true` 仍可导入/导出（兼容一版）：它表示"该服务器的工具结果包含图片引用"，语义与 `capability` 不同，**不会**被自动映射。
- 只支持 Streamable HTTP 的 MCP。
- 生成器的「启用」是**条目级**开关，只影响该条目是否出现在生成的 JSON 里；「是否启用MCP / 启用知识库记忆 / 会话回收」这类**全局开关**仍由插件配置页单独设置，不写进 JSON。
- 插件侧这些页签对应**新的 JSON 键名**，旧的多框配置项不再读取、也不会自动迁移；升级后按生成器重新生成一份粘贴即可。

纯逻辑在 `js/domains/*.js`，Node 自检：`node tests/domains-run.mjs`；浏览器交互自检：`tests/domain-e2e-check.html`。

### 事件触发分区

顶栏「事件触发」页签为插件「触发 → 事件触发规则」生成规则 JSON（schema v1，规则最多 50 条）。

- **规则**：`{ version: 1, rules: [...] }`；每条规则**只绑一个扁平事件名**，无规则名、无工具限制字段。
- **事件**：中文短名下拉（按 群成员 / 群消息 / 群信息 / 机器人 / 好友 / 申请 分组），选中事件只带默认条件，不自动填提示词：
  入群、退群、管理变更、禁言、撤回、文件上传、名片变更、表情回应、精华消息、群名变更、头衔变更、群荣誉、运气王、机器人入群、戳一戳、新好友、好友撤回、加群申请、好友申请。
  「自定义事件…」可手输事件名（小写字母/数字/下划线）；插件不认识的未知事件会只给 warning，协议端未上报时不会触发。
- **prompt**：**默认留空、可留空**（事件接收本身已把事件写入上下文；留空 = 只触发 AI 对该事件做出响应，不附加指令）。0~4000 字，由用户自行填写。占位符：`{user_id}` `{operator_id}` `{group_id}` `{session_id}` `{platform}` `{event_text}` `{event_json}` `{event_type}` `{flag}` `{comment}` `{sub_type}`。
- **scope（作用范围，高级折叠，默认全部）**：`platforms` 平台白名单；`sessions` 限定会话 UNI-ID（每行一个）；`exclude` 排除会话（每行一个）；后两者最多 200 个。
- **触发条件（match）**：可视化行编辑器——字段（中文字段下拉：触发者/操作者/群号/消息ID/子类型/请求类型/平台/会话ID/是否群聊/是否戳机器人）+ 操作（等于 / 匹配正则）+ 值；可增删；也可展开「直接编辑 JSON」。最多 10 条，全部满足才触发；输出始终是规范数组（插件额外接受对象糖，生成器不输出）。
- 「戳一戳」默认带一条 `is_target_bot = true` 条件（避免戳别人也触发），可删；其他事件默认无条件。
- `group_request` / `friend_request` 也会正常触发响应：`group_request`（加群申请）是主场景；`friend_request` 可能因双方已是好友而无法投递回复。
- **旧格式导入迁移**：含 `name` / `toolChoice` / `on` 数组 / `notify.*` 复合名的旧 JSON 或旧本地草稿会自动迁移（丢无效字段、数组取第一个并 warning、复合名映射扁平名、match 对象糖展开）。
- 「启用」开关关闭的规则只留在草稿里，不写进 JSON；导入时未知键只产生 warning，不会导致整份配置被拒。
- **范围说明**：本页签只生成插件「触发」页的 **11 个键之一**——`事件触发规则`（JSON v1）。其余 10 个键
  （`触发需要满足的条件` / `触发次数上限` / `触发次数补充间隔` / `触发活跃时间` / `默认计数器` / `默认计时器` /
  `评分触发参数`（TOML v2）/ `默认概率` / `触发正则表达式` / `默认定时器`（TOML 多 `[[timer]]`））
  不在生成器范围，仍需在插件配置页设置；规则工具 / 命令 schema（`set_trigger_rule` 等）同样不由生成器生成。
- 点「复制全部」→ 粘到海豹 → JS插件 → 插件设置 → aiplugin4 →「触发」→「事件触发规则」；重载 JS 生效。
### 关于 API Key

**API Key 会保存在本机浏览器里**（localStorage），刷新不丢 —— 不必反复粘贴。

这是**改过**的决定：初版是"永不落盘"（每次刷新重贴）。改的理由是本机静态页面、
而 Key **本来就已经明文存在海豹配置里**，同一个信任边界，再存一份到 localStorage
的增量风险很小，不值得用"反复粘贴"去换。

**唯一的真实风险场景**：把页面**托管到公网**（而不是本机打开）。那时 localStorage
属于那个源，同源下的其它脚本能读到它（`<用户名>.github.io` 是**所有** Pages 项目
共用的一个源）。若在意这点，把 `js/app.js` 的 `scheduleSave()` 改成映射出
`apiKey: ''` 即可恢复"不落盘"。

公用电脑上用完请点「**清空**」。

配置文件本身按 v5 设计是**明文存 key**，所以分享配置前请用「遮蔽 API Key」。

## 自动拉取模型列表的现实约束

拉取是**浏览器直连供应商**，浏览器强制 CORS。实测（2026）：

| 供应商 | 浏览器直连 |
| --- | --- |
| DeepSeek / 智谱 / 阿里百炼 / 硅基流动 / Moonshot | 是 放行 |
| OpenRouter | 是 放行 |
| Anthropic | 否 被 CORS 拦截 |
| OpenAI / xAI / Mistral | 国内网络不可达，需自备代理 |

**国内厂商全部放行**，所以「自动拉取」可作主入口；拉不动时会有明确提示，并随时可改手动输入。

拉取时 API Key 由浏览器**直连**发给该供应商（无第三方经手）。本工具**绝不**使用公共 CORS 代理，也不引入任何后端。

想自己复测：起服务后打开 `tests/cors-probe.html`。

## 适配状态

对应 **aiplugin4 的 v5 配置格式**（设计见插件仓库 `docs/13-模型配置v5方案.md`）。

> 注意版本号：**「v5」指的是配置格式，不是插件版本。** 插件版本是 `4.2x` ——
> v5 配置随 **4.25** 发布（当前发布版是 4.24.0，仍读旧的两个 TOML 框）。
> 顶栏曾显示过"适配 aiplugin4 v5.0.0"，那个版本号是错的，已删除。

插件侧已同步改造（v5 单框 `模型配置` 取代 `api连接` + `模型规则`）。
**要装到海豹，需要插件仓库的 `dist/aiplugin4.js` 构建产物 —— 而不仅是拉源码。**

> **用途数量不变：仍是 7 个。** `compression`（压缩）已彻底移除，judge 统一显示为
> 「**评分**」（不再叫「评分 / 决策（判定）」，也没有 `decision` 这个**用途键**；`decision` 是**模型 kind**，见下）。
> 旧配置/旧本地草稿里含 `compression` 时**不会导入失败**：导入会自动剔除该用途绑定，
> 并给出「旧配置中的「压缩」用途已移除，已自动忽略」的警告。
>
> **用途组请求体（`groups[]`）已停用。** 插件侧删掉了整套用途组机制，请求体覆盖改走
> **逐模型**的 `models[].request.bodyByUse`（用途 → 请求体）：生成器不再输出 `groups`，
> 导入旧配置时会把 `groups` **丢弃并明确警告**，而 `models[].request` 原样保留。
> 旧版本地草稿里的 `useBodies` / `judgePreset` 也一并忽略（不再有「判定请求体预设」开关）。

角色 / 技能 / MCP / 知识库 / 事件触发五个页签对应插件侧的**新 JSON 配置键**（`角色设定`、`技能列表`、`MCP服务器`、`知识库配置`、`事件触发规则`），
格式版本为 `1`。旧的多框配置项不再读取、也不自动迁移；升级后请用这五个页签重新生成并粘贴。

## 文件结构

```
index.html            页面结构
css/styles.css        样式
docs/ui-standard.md   页签 / 卡片动作 / 工具栏 / 导入对话框 / 编辑侧栏的统一标准
js/ui.js             通用 UI 元件（toast / 复制 / 下载 / 文件选择 / 导入对话框 / 编辑侧栏 / 卡片动作）
js/tabs.js            统一页签切换（7 个分区）
js/templates.js       供应商模板（对应插件 PROVIDER_MAP）
js/classify.js        模型类型分类（与插件 catalog.ts 同源，是其超集）
js/v5.js              v5 配置的构建 / 校验 / 序列化
js/fetch-models.js    模型列表拉取（含 CORS 降级 + 供应商自报能力位解析）
js/app.js             模型分区交互逻辑
js/web.js             联网配置的构建 / 校验 / 序列化（对应插件 src/web/schema.ts）
js/web-app.js         联网分区的交互逻辑
js/domain-app.js      角色 / 技能 / MCP / 知识库 / 事件触发的通用交互层
js/domains/common.js  内容分区的共用纯逻辑（JSON / 校验 / SKILL.md frontmatter）
js/domains/roles.js   角色设定：校验 / 构建 / 导入 / 文件解析
js/domains/skills.js  技能：校验 / 构建 / 导入 / SKILL.md 解析
js/domains/mcp.js     MCP：标准 mcpServers JSON 的校验 / 构建 / 导入 / 遮蔽
js/domains/kb.js     知识库：校验 / 构建 / 导入 / Markdown 解析
js/domains/event-trigger.js  事件触发：校验 / 构建 / 导入 / 文件解析
js/domains/default-data.js  出厂默认（由 tools/sync-default-data.mjs 生成）
tests/run.mjs         模型 / 联网逻辑测试（301 项）
tests/domains-run.mjs 五个内容分区逻辑测试（231 项）
tests/web-check.mjs  联网分区逻辑自检（28 项）
tests/dom-test.html   模型 / 联网浏览器交互测试（231 项）
tests/domain-e2e-check.html 五个内容分区浏览器交互测试（52 项）
tests/web-e2e-check.html 联网分区统一编辑/启用/导入交互测试（12 项）
tests/close-check.html 面板关闭路径定点验证
tests/purpose-check.html 用途绑定卡片 + 取用顺序角标 + 评分标签检查（26 项）
tests/vision-e2e-check.html 视觉模型端到端检查（桩 /models → 卡片标注 → 配置 kind）
tests/override-e2e-check.html 请求覆盖端到端检查（逐字输入不失焦 / 非法 JSON 不清空配置）
tests/import-e2e-check.html 导入导出往返检查（bodyByUse 保留 / 旧 groups 丢弃+警告 / 幂等 / 编辑后不冲掉其它字段）
tests/dashscope-image-e2e-check.html 百炼生图零配置检查（不填 URL / 不写结构）
tests/style-check.html   排版与动效检查（计算样式：字号下限/控件归一化/箭头旋转/无 emoji）
tests/cors-probe.html CORS 实测工具
```

## 缓存：为什么"改了没生效"，以及怎么根治

**GitHub Pages 固定发 `Cache-Control: max-age=600`**（HTML 与 JS 都是），而且
**Pages 不支持自定义响应头**（没有 Netlify / Cloudflare 那种 `_headers`）。
所以部署后最多 10 分钟内，浏览器可能仍在跑旧文件 —— 表现为"我明明改了它却没生效"。

本项目为此踩过三次（本地 python 服务、Pages 各一次，最后一次是你刷新看到卡片全丢）。

**根治办法：让页面自己发现自己是旧的。** `js/app.js` 启动后会：

1. 取一份**绕过缓存**的自身副本（`cache: 'no-store'`）
2. 与浏览器**当前正在运行的**那份（`cache: 'only-if-cached'`）比对
3. 不一致 → 顶部出一条「页面有更新（当前是浏览器缓存的旧版）· 立即刷新」

关键：**这个检查由旧页面发起也能发现新版本**，所以缓存挡不住它。

**「立即刷新」为什么要带 `?v=`**：实测这三种写法**都只能刷到新 HTML，子资源仍走缓存**，
提示会一直在（只有 Ctrl+F5 会全绕开）：

| 写法 | 结果 |
| --- | --- |
| `location.reload()` | 子资源仍走缓存 ✗ |
| `location.replace(url + '?_=' + now)` | 同上 ✗ |
| `await import('./js/app.js?v=…')` | 同上 ✗，**而且 JS 会在 `load` 之后才跑**（就绪时刻变了，10 个测试因此失败） |

所以 `index.html` 里有一段**解析期**脚本，把地址栏的 `?v=` 用 `document.write`
透传给 CSS 与 JS 的 URL，让三者**一起**换成新 URL。这是 `document.write`
的正当用法（解析期插入，模块仍按正常时机加载并阻塞 `load`）。

正常访问（没有 `?v=`）时什么都不加，照常走缓存。

**手动验证**（需要一个会缓存的服务器，本地 `serve.mjs` 发的是 `no-store`，测不出来）：

```bash
# 1) 起一个模仿 Pages 的服务器（max-age=600），加载一次填缓存
# 2) 改一下 js/app.js
# 3) 再加载：应出现「页面有更新」提示；点「立即刷新」后提示消失
```

> 换到有响应头控制的托管（Cloudflare Pages 等）可以直接设 `no-store`，就不需要这段了。
## 开发约定：UI 统一元素

新增页签或改现有页签时，卡片动作（↑ ↓ 编辑 删除）、工具栏（复制全部 / 下载 .json / 导入… / 导入文件… / 恢复默认 / 清空）、导入对话框、编辑侧栏、文件导入行为必须按
[`docs/ui-standard.md`](docs/ui-standard.md) 实现；通用实现集中在 `js/ui.js` 与 `js/tabs.js`，不要各写一套。

## 视觉规范

| 项 | 约定 |
| --- | --- |
| 字号 | **一律 rem**，根字号保持 `100%`（跟随用户浏览器设置）。最小 **12px**，用 `max(rem, px)` 兜底 |
| 正文 | 15px / 行高 1.65（中文需要比英文更松的行距） |
| 控件 | `select` 用 `appearance: none` + 自绘 SVG 箭头 —— 各平台原生外观差异极大，不归一化谈不上跨平台 |
| 原生控件配色 | `color-scheme: dark`，否则 Chromium 给白底下拉、Safari 给白底滚动条 |
| 滚动条 | WebKit 走 `::-webkit-scrollbar`，Firefox 走 `scrollbar-color` / `scrollbar-width` |
| 图标 | **不用 emoji，也不用 `▸`/`▾` 等字符**：emoji 各平台字形不一，字符箭头宽度随字体变。折叠箭头用 CSS 画的三角（可旋转、可动画） |
| 用途角标 | 绑定的**序号**用数字而非勾选 —— "第几个"本身就是信息（决定插件取用与回退顺序） |
| 动效 | 统一 `--dur` / `--ease`；必须提供 `prefers-reduced-motion` 降级 |
| 浏览器 | `inset` 补 top/right/bottom/left 兜底；`backdrop-filter` 带 `-webkit-` 前缀；可选增强用 `@supports` 包裹 |

**字号写死的坑（实测踩过）**：根元素上的 `rem` 按**初始字号（16px）**解析，
所以 `html { font-size: .9375rem }` 会把根变成 15px，页面里**所有** rem 值整体缩水 6.25%
（`0.75rem` 从 12px 掉到 11.25px）。**字号只在 `body` 上设。**

## 测试

```bash
npm test                  # 模型 / 联网 + 五个内容分区的全部 Node 逻辑测试
# 或分开跑：
node tests/run.mjs        # 模型 / 联网逻辑
node tests/domains-run.mjs # 角色 / 技能 / MCP / 知识库 / 事件触发逻辑
# 浏览器：起服务后打开
#   tests/dom-test.html          模型 / 联网交互
#   tests/domain-e2e-check.html  五个内容分区交互
#   tests/web-e2e-check.html     联网分区统一编辑/导入交互
#   tests/style-check.html       排版与动效
```

默认值同步（改插件出厂默认后）：

```bash
node tools/sync-default-data.mjs   # 需要同级目录有 aiplugin4（或设置 AIPLUGIN4_REPO）
```

## 免责

非官方工具，与 aiplugin4 / SealDice 官方无关。生成的配置请自行核对后再用于生产环境。
