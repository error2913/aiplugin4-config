# aiplugin4 配置生成器

给 [aiplugin4](https://github.com/error2913/aiplugin4)（SealDice AI 插件）用的**「api连接」可视化生成器**。

勾选服务商 → 填 API Key → 勾模型 → 复制生成的 TOML 粘进海豹，不用手写那坨配置。

> **当前状态：本地 demo。** 零依赖纯静态页面，双击 `index.html` 即可跑。
> 未做联网拉取模型列表、后端、跨设备同步。

## 为什么需要它

插件的「api连接」是**手写 TOML**，而且有几个反直觉的硬性规则，写错了插件只在日志里丢一行错误、界面上表现为"模型莫名没了"：

| 坑 | 后果 |
| --- | --- |
| `[types]` 表必须写在**本框最后**，其后不能再出现 `api_key` 等键 | 整框解析失败 |
| 模型名含 `.` `:` `/` 时，`[types]` 的键**必须加引号** | 被解析成嵌套表，该键失效 |
| `provider` 省略时必须显式填 `base_url` | 连接被跳过 |
| 模型名带斜杠的（生图/语音模型常见） | 最容易踩上面第二条 |

本工具把 `[types]` **恒定排在末尾**、对特殊模型名**自动加引号**，从结构上杜绝这几类错误。

## 用法

```
双击 index.html
```

或起个本地服务（推荐，`file://` 下剪贴板 API 受限）：

```bash
python -m http.server 8099
# 打开 http://127.0.0.1:8099/
```

然后：

1. 选服务商（自动填好默认 `base_url`），填 `api_key`，按需填 `models`
2. 点「复制全部」
3. 粘到 SealDice WebUI →「JS插件」→「插件设置」→ aiplugin4 →「模型」→ **api连接**
4. **多个连接要逐个框粘贴** —— 插件是「一框一条连接」
5. 重载 JS 生效

> 本工具**不会**自动写入海豹。纯静态页面访问不到你的海豹实例，只负责生成正确文本。

## 功能

- **内置 10 个供应商模板**：DeepSeek / 智谱 / 阿里百炼 / Google Gemini / Anthropic Claude / OpenAI / Moonshot / 硅基流动 / xAI / Mistral，各自带默认 `base_url` 与模型名示例
- **自定义网关**：provider 留空 = 按 OpenAI 兼容处理（此时 `base_url` 必填，界面会拦住）
- **实时预览**：右侧常驻显示生成的 TOML，带语法着色
- **多连接**：每张卡片对应插件里一个配置框，卡片标题直接标出「连接序号 N」
- **遮蔽 API Key**：导出时把 key 换成 `sk-xxxx`，方便截图分享
- **反向导入**：粘贴已有 TOML 解析回表单（含行号报错定位）
- **本地草稿**：自动存 localStorage

### 关于 API Key 存储

**默认不把 API Key 写入 localStorage。** 需要保留时得显式勾选「在本机记住 API Key」，界面会提示是明文存储。公用电脑别开。

## 适配版本

对应 **aiplugin4 v4.24.0**。

本工具与插件的 TOML 格式是硬耦合的：插件改了「api连接」的格式，这里生成的配置就可能失效。页面顶部有版本标注，核对插件版本再用。

数据来源：`src/config/static_config/providers.ts` 的 `PROVIDER_MAP` 与 `src/config/configs/model.ts` 的模板定义。

## 文件结构

```
index.html          页面结构
css/styles.css      样式
js/templates.js     供应商模板数据（对应 PROVIDER_MAP）
js/toml-gen.js      表单 -> TOML（[types] 置尾、特殊键加引号）
js/toml-parse.js    迷你 TOML 解析（受限子集 + 行号报错）
js/app.js           交互逻辑
```

## 关于「一键粘贴」

做不到字面意义的零粘贴。插件的配置入口是 `seal.ext.registerTemplateConfig`（一个框一个字符串），海豹没有给外部程序写入配置的通道，本工具也**不去驱动海豹 WebUI**（那需要浏览器内核，与"轻量"目标冲突）。

所以做成了"生成正确文本 + 一键复制"，把"从零手写还容易写错"变成"粘贴"。

## 免责

非官方工具，与 aiplugin4 / SealDice 官方无关。生成的配置请自行核对后再用于生产环境。
