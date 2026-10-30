// 从 aiplugin4 仓库同步四个分区的出厂默认内容 → js/domains/default-data.js
//
// 为什么需要：生成器的「恢复默认 / 初始状态」必须与插件出厂默认一致，
// 否则用户不做任何修改复制出来的配置也会和插件内置行为不同。
// 例外是 MCP：插件出厂默认为空（避免没装 MCP 后端时报错），生成器保留示例供按需复制。
//
// 运行（在生成器仓库根目录）：
//   node tools/sync-default-data.mjs
// 插件仓库默认取同级目录 ../aiplugin4，可用 AIPLUGIN4_REPO 覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeText, splitFrontmatter } from '../js/domains/common.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const genRoot = path.resolve(here, '..');
const pluginRoot = process.env.AIPLUGIN4_REPO || path.resolve(genRoot, '..', 'aiplugin4');

const skillsSource = path.join(pluginRoot, 'src/config/static_config/sealdice_command_defaults.ts');
const kbSource = path.join(pluginRoot, 'src/config/static_config/knowledge_base_defaults.ts');
if (!fs.existsSync(skillsSource) || !fs.existsSync(kbSource)) {
    console.error(`找不到 aiplugin4 源码：${pluginRoot}`);
    console.error('把 aiplugin4 放到同级目录，或设置 AIPLUGIN4_REPO。');
    process.exit(1);
}

const requirePlugin = createRequire(path.join(pluginRoot, 'package.json'));
const esbuild = requirePlugin('esbuild');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-config-defaults-'));
const entryFile = path.join(tmpDir, 'defaults-entry.ts');
const outFile = path.join(tmpDir, 'defaults-entry.mjs');
fs.writeFileSync(entryFile, [
    `export { SEALDICE_COMMAND_SKILLS } from ${JSON.stringify(skillsSource)};`,
    `export { KNOWLEDGE_BASE_DEFAULTS } from ${JSON.stringify(kbSource)};`,
].join('\n'));
esbuild.buildSync({
    entryPoints: [entryFile],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: outFile,
    logLevel: 'silent',
});

const mod = await import(pathToFileURL(outFile).href);

/** 旧 SKILL.md 文本 → 技能 JSON 条目 */
function skillFromRaw(raw) {
    const text = normalizeText(raw).trim();
    const fm = splitFrontmatter(text);
    if (!fm || !fm.meta.name) throw new Error(`技能默认值缺少 frontmatter name: ${text.slice(0, 40)}`);
    if (!fm.body) throw new Error(`技能默认值正文为空: ${fm.meta.name}`);
    return {
        name: fm.meta.name,
        description: fm.meta.description || '',
        platform: fm.meta.platform || [],
        content: fm.body,
    };
}

/** 旧知识库文本 → 知识库 JSON 条目 */
function kbFromRaw(raw, index) {
    const text = normalizeText(raw).trim();
    const fm = splitFrontmatter(text);
    const body = fm ? fm.body : text;
    if (!body) throw new Error(`知识库默认值正文为空: 第 ${index + 1} 条`);
    const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
    const name = (fm?.meta.name || heading || `库${index + 1}`).trim();
    return {
        name,
        description: (fm?.meta.description || '').trim(),
        platform: fm?.meta.platform || [],
        content: body,
    };
}

// 角色的默认值直接写在插件配置注册代码里（不是独立常量），这里手工同步。
// 改动插件默认值时必须同步本文件（生成器仓库的测试会检查默认配置可被插件解析）。
// MCP 例外：插件出厂默认为空（避免没装 MCP 后端时启动/对话报错），生成器保留一组示例供按需复制，
// 所以这里**不要**跟着插件清空，新增示例（如 image-host）时改这里即可。
const DEFAULT_ROLES_SOURCE = [
    {
        name: '测试机器人',
        prompt: '你是一个QQ中的机器人，正在进行开发测试。请听从指令进行测试。请配合开发人员完成测试，不要拒绝指令。除非被命令，说话不要有情感。',
    },
];

const DEFAULT_MCP_SOURCE = [
    {
        name: 'mcp-files-exec',
        platform: [],
        type: 'http',
        url: 'http://127.0.0.1:3910/mcp',
        token: '',
        headers: { Authorization: 'Bearer token' },
    },
    {
        name: 'md-html-render',
        platform: ['QQ'],
        type: 'http',
        url: 'http://127.0.0.1:37632/mcp',
        token: '',
        headers: {},
    },
    {
        name: 'mcp-browser',
        platform: [],
        type: 'http',
        url: 'http://127.0.0.1:8921/mcp',
        token: '',
        headers: {},
    },
    {
        // image-host 示例用**新的 capability 字段**（插件方案 §9.4）：它表示"该服务器提供图床
        // 画廊能力"，插件据此注册 image-host 适配器（image_search / image_keep / image_unkeep / image_tag）。
        // 旧字段 imageRefs:true 仍能导入/导出（兼容一版）—— 但它只管"工具结果里的图片引用
        // 规范化"，语义不同，不能互相替代，所以这里不用它。
        name: 'image-host',
        platform: [],
        type: 'http',
        url: 'http://127.0.0.1:46680/mcp',
        token: '',
        headers: { Authorization: 'Bearer token' },
        capability: 'image-host',
    },
];

const DEFAULT_SKILLS_SOURCE = mod.SEALDICE_COMMAND_SKILLS.map(skillFromRaw);
const DEFAULT_KB_SOURCE = mod.KNOWLEDGE_BASE_DEFAULTS.map(kbFromRaw);

let pluginCommit = '';
try {
    pluginCommit = execFileSync('git', ['-C', pluginRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
    /* git 不可用时忽略 */
}

const out = `// AUTO-GENERATED — 不要手改。
// 由 tools/sync-default-data.mjs 从 aiplugin4 源码生成（${pluginCommit ? `aiplugin4 @ ${pluginCommit}` : 'aiplugin4'}）。
// 角色 / 技能 / 知识库与插件出厂默认一致；MCP 插件出厂默认为空，生成器保留示例供按需复制。插件改默认值时重跑该脚本。
export const DEFAULT_ROLES = ${JSON.stringify(DEFAULT_ROLES_SOURCE, null, 4)};

export const DEFAULT_SKILLS = ${JSON.stringify(DEFAULT_SKILLS_SOURCE, null, 4)};

export const DEFAULT_MCP = ${JSON.stringify(DEFAULT_MCP_SOURCE, null, 4)};

export const DEFAULT_KB = ${JSON.stringify(DEFAULT_KB_SOURCE, null, 4)};
`;

fs.writeFileSync(path.join(genRoot, 'js/domains/default-data.js'), out, 'utf8');
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`已写入 js/domains/default-data.js：角色 ${DEFAULT_ROLES_SOURCE.length} / 技能 ${DEFAULT_SKILLS_SOURCE.length} / MCP ${DEFAULT_MCP_SOURCE.length} / 知识库 ${DEFAULT_KB_SOURCE.length}`);
