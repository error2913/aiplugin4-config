// 角色 / 技能 / MCP / 知识库四个分区的纯逻辑测试（node，无需浏览器）。
// 运行：node tests/domains-run.mjs
import assert from 'node:assert/strict';

import { rolesSpec, roleFromFile } from '../js/domains/roles.js';
import {
    buildSkills, parseSkillsImport, skillFromFile, skillFromFiles, skillsSpec, validateSkills,
} from '../js/domains/skills.js';
import { mcpSpec, parseMcpDocument, maskMcp } from '../js/domains/mcp.js';
import { kbSpec, kbFromFile } from '../js/domains/kb.js';
import { DOMAIN_SPECS } from '../js/domains/index.js';
import { DEFAULT_KB, DEFAULT_MCP, DEFAULT_ROLES, DEFAULT_SKILLS } from '../js/domains/default-data.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) {
        pass++;
        console.log(`  PASS  ${name}`);
    } else {
        fail++;
        console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`);
    }
};
const eq = (name, actual, expected) => check(name, actual === expected, `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);

console.log('=== 默认值：角色 / 技能 / 知识库与插件一致；MCP 为生成器示例 ===');
{
    eq('角色默认 1 条', DEFAULT_ROLES.length, 1);
    eq('角色名', DEFAULT_ROLES[0].name, '测试机器人');
    check('角色 prompt 非空', DEFAULT_ROLES[0].prompt.length > 0);
    eq('技能默认 1 条', DEFAULT_SKILLS.length, 1);
    eq('技能名', DEFAULT_SKILLS[0].name, '录卡');
    check('技能正文非空', DEFAULT_SKILLS[0].content.length > 100);
    eq('MCP 默认 4 台', DEFAULT_MCP.length, 4);
    eq('MCP 第二台平台', JSON.stringify(DEFAULT_MCP[1].platform), JSON.stringify(['QQ']));
    eq('MCP 第四台名称', DEFAULT_MCP[3].name, 'image-host');
    eq('MCP image-host 地址', DEFAULT_MCP[3].url, 'http://127.0.0.1:46680/mcp');
    eq('MCP image-host 默认带 token 头', JSON.stringify(DEFAULT_MCP[3].headers), JSON.stringify({ Authorization: 'Bearer token' }));
    eq('知识库默认 3 个', DEFAULT_KB.length, 3);
    eq('ob11 知识库平台', JSON.stringify(DEFAULT_KB[2].platform), JSON.stringify(['QQ']));
    check('默认知识库内容包含 ob11', DEFAULT_KB[2].content.includes('call_ob11_api'));
    for (const spec of DOMAIN_SPECS) {
        const { problems, warnings } = spec.validate(spec.defaults.map(x => spec.normalizeItem(x)));
        eq(`${spec.id} 默认值无问题`, problems.length + warnings.length, 0);
    }
}

console.log('\n=== 四个分区输出结构 ===');
{
    const roles = rolesSpec.build([{ name: 'A', prompt: '你是 A' }]);
    eq('角色 version', roles.version, 1);
    eq('角色结构', JSON.stringify(roles), JSON.stringify({ version: 1, roles: [{ name: 'A', prompt: '你是 A' }] }));

    const skills = skillsSpec.build([{ name: 'S', description: '', platform: [], content: '正文' }]);
    eq('技能空描述/空平台不输出', JSON.stringify(skills), JSON.stringify({ version: 1, skills: [{ name: 'S', content: '正文' }] }));

    const mcp = mcpSpec.build([{ name: 'M', platform: [], enabled: true, type: 'http', url: 'http://x/mcp', token: '', headers: {} }]);
    check('MCP 输出标准 mcpServers 对象', !!mcp.mcpServers && !Array.isArray(mcp.mcpServers));
    eq('MCP url', mcp.mcpServers.M.url, 'http://x/mcp');
    check('MCP 输出不含 enabled 键', !JSON.stringify(mcp).includes('"enabled"'));

    const disabledMcp = mcpSpec.build([{ name: 'M', platform: [], enabled: false, type: 'http', url: 'http://x/mcp', token: '', headers: {} }]);
    check('停用的 MCP 服务器直接从输出移除', !disabledMcp.mcpServers.M && Object.keys(disabledMcp.mcpServers).length === 0);

    const kb = kbSpec.build([{ name: 'K', description: '说明', platform: ['QQ'], content: '# 标题' }]);
    eq('知识库 platform 保留', JSON.stringify(kb.libraries[0].platform), JSON.stringify(['QQ']));
}

console.log('\n=== 启用开关：停用 = 从输出移除，不写 enabled 键 ===');
{
    const cases = [
        ['角色', rolesSpec, { name: 'A', prompt: 'P' }, 'roles'],
        ['技能', skillsSpec, { name: 'S', content: 'C' }, 'skills'],
        ['知识库', kbSpec, { name: 'K', content: 'C' }, 'libraries'],
    ];
    for (const [label, spec, item, key] of cases) {
        const on = spec.build([{ ...item, enabled: true }]);
        const off = spec.build([{ ...item, enabled: false }]);
        check(`${label}：启用时输出`, on[key].length === 1, JSON.stringify(on));
        check(`${label}：停用后输出为空`, off[key].length === 0, JSON.stringify(off));
        check(`${label}：输出不含 enabled 键`, !JSON.stringify(on).includes('"enabled"'));
        const { problems } = spec.validate([{ ...item, enabled: false, name: '', content: '' }]);
        check(`${label}：停用条目不参与校验`, problems.length === 0, JSON.stringify(problems));
    }
    for (const spec of DOMAIN_SPECS) {
        const cfg = spec.build(spec.defaults.map(x => spec.normalizeItem(x)));
        check(`${spec.id}：默认输出不含 enabled 键`, !JSON.stringify(cfg).includes('"enabled"'));
    }
}

console.log('\n=== 导入 / 导出往返 ===');
{
    const roleText = JSON.stringify({ version: 1, roles: [{ name: 'A', prompt: '你是 A' }] });
    const roleImport = rolesSpec.parseImport(roleText);
    check('角色导入成功', roleImport.ok, JSON.stringify(roleImport.issues));
    eq('角色往返', JSON.stringify(rolesSpec.build(roleImport.items)), roleText);

    const skillText = JSON.stringify({
        version: 1,
        skills: [{ name: 'S', description: '描述', platform: ['QQ', 'DISCORD'], content: '# 正文\n内容' }],
    });
    const skillImport = skillsSpec.parseImport(skillText);
    check('技能导入成功', skillImport.ok, JSON.stringify(skillImport.issues));
    eq('技能往返', JSON.stringify(skillsSpec.build(skillImport.items)), skillText);

    const mcpText = JSON.stringify({
        mcpServers: {
            M: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } },
        },
    });
    const mcpImport = mcpSpec.parseImport(mcpText);
    check('MCP 导入成功', mcpImport.ok, JSON.stringify(mcpImport.issues));
    eq('MCP 往返 url', mcpSpec.build(mcpImport.items).mcpServers.M.url, 'http://127.0.0.1:1/mcp');

    const kbText = JSON.stringify({ version: 1, libraries: [{ name: 'K', description: '说明', content: '# 正文' }] });
    const kbImport = kbSpec.parseImport(kbText);
    check('知识库导入成功', kbImport.ok, JSON.stringify(kbImport.issues));
    eq('知识库往返', JSON.stringify(kbSpec.build(kbImport.items)), kbText);
}

console.log('\n=== 非法输入必须拒绝 ===');
{
    const cases = [
        ['空内容', rolesSpec, ''],
        ['非 JSON', rolesSpec, 'not json'],
        ['版本不支持', rolesSpec, '{"version":2,"roles":[]}'],
        ['缺少 roles', rolesSpec, '{"version":1}'],
        ['角色缺 name', rolesSpec, '{"version":1,"roles":[{"prompt":"x"}]}'],
        ['角色重复', rolesSpec, '{"version":1,"roles":[{"name":"A","prompt":"1"},{"name":"A","prompt":"2"}]}'],
        ['技能缺 content', skillsSpec, '{"version":1,"skills":[{"name":"S"}]}'],
        ['技能重复', skillsSpec, '{"version":1,"skills":[{"name":"S","content":"1"},{"name":"S","content":"2"}]}'],
        ['MCP 缺 mcpServers', mcpSpec, '{"servers":{}}'],
        ['MCP 缺 url', mcpSpec, '{"mcpServers":{"M":{}}}'],
        ['MCP 非法协议', mcpSpec, '{"mcpServers":{"M":{"url":"ftp://x"}}}'],
        ['MCP SSE 被跳过', mcpSpec, '{"mcpServers":{"M":{"type":"sse","url":"http://x"}}}'],
        ['知识库重复', kbSpec, '{"version":1,"libraries":[{"name":"K","content":"1"},{"name":"K","content":"2"}]}'],
    ];
    for (const [name, spec, text] of cases) {
        const result = spec.parseImport(text);
        check(`拒绝：${name}`, !result.ok);
    }
}

console.log('\n=== 文件导入 ===');
{
    const skill = skillFromFile('demo/SKILL.md', '---\nname: 测试技能\ndescription: 摘要\nplatform: [QQ]\n---\n# 正文\n内容');
    check('SKILL.md 解析成功', skill.ok, JSON.stringify(skill.issues));
    eq('SKILL.md name', skill.item.name, '测试技能');
    eq('SKILL.md platform', JSON.stringify(skill.item.platform), JSON.stringify(['QQ']));

    const skillNoFm = skillFromFile('my-skill.md', '# 没 frontmatter\n正文');
    check('无 frontmatter 的技能用文件名兜底', skillNoFm.ok);
    eq('文件名→技能名', skillNoFm.item.name, 'my-skill');
    check('无 frontmatter 有警告', (skillNoFm.warnings || []).length > 0);

    const role = roleFromFile('roles/kp.txt', '你是 KP，负责……');
    check('角色文件解析成功', role.ok, JSON.stringify(role.issues));
    eq('角色文件名→名称', role.item.name, 'kp');

    const kb = kbFromFile('kb/rules.md', '# 规则库\n\n第一条规则。\n\n## 小节');
    check('知识库文件解析成功', kb.ok, JSON.stringify(kb.issues));
    eq('知识库 # 标题→名称', kb.item.name, '规则库');
    eq('知识库描述取首段', kb.item.description, '第一条规则。');

    const claude = parseMcpDocument(JSON.stringify({
        mcpServers: {
            files: { type: 'http', url: 'http://127.0.0.1:3910/mcp' },
            local: { command: 'node', args: ['x.js'] },
        },
    }), 'mcp');
    check('mcpServers 导入成功', claude.ok, JSON.stringify(claude.issues));
    eq('mcpServers 保留可用服务器', claude.items.length, 1);
    check('stdio 服务器有警告', (claude.warnings || []).some(w => /stdio/.test(w.msg)));

    const nonStandard = parseMcpDocument(JSON.stringify({ type: 'http', url: 'http://127.0.0.1:9/mcp' }));
    check('非标准顶层（单服务器对象）被拒绝', !nonStandard.ok);
}

console.log('\n=== 不解析 frontmatter 的分区（角色 / 知识库 / MCP） ===');
{
    // 只有技能保留跨 agent 标准 SKILL.md 的 frontmatter；其余分区的文件导入不做特殊解析
    const role = roleFromFile('kp.txt', '---\nname: 会被忽略\n---\n你是 KP');
    check('角色：frontmatter 不参与解析，文件名作名称',
        role.ok && role.item.name === 'kp' && role.item.prompt.includes('name: 会被忽略'));

    const kb = kbFromFile('notes.md', '# 规则库\n\n第一条规则。');
    check('知识库：只认 # 标题 / 文件名，不认 frontmatter',
        kb.ok && kb.item.name === '规则库' && kb.item.description === '第一条规则。');

    check('角色 spec 不再暴露 fromLegacy', !('fromLegacy' in rolesSpec));
    check('知识库 spec 不再暴露 fromLegacy', !('fromLegacy' in kbSpec));
    check('MCP spec 不再暴露 fromLegacy', !('fromLegacy' in mcpSpec));
    check('技能 spec 不再暴露 fromLegacy', !('fromLegacy' in skillsSpec));
}

console.log('\n=== MCP 遮蔽 ===');
{
    const masked = maskMcp({
        mcpServers: { M: { type: 'http', url: 'http://x', headers: { Authorization: 'Bearer secret', 'X-Other': 'keep' } } },
    });
    eq('Authorization 被遮蔽', masked.mcpServers.M.headers.Authorization, 'xxxx');
    eq('普通 header 保留', masked.mcpServers.M.headers['X-Other'], 'keep');
}

console.log('\n=== 尾逗号兼容 ===');
{
    const result = skillsSpec.parseImport('{"version":1,"skills":[{"name":"S","content":"x",},],}');
    check('尾逗号 JSON 可解析', result.ok, JSON.stringify(result.issues));
}

console.log('\n=== 字符串转义（引号 / 反斜杠 / 换行 / 控制字符 / Unicode） ===');
{
    // 覆盖容易在“手写 JSON / 拼接字符串”方案里出错的字符：
    // 双引号、反斜杠路径、换行、制表、</script>、反引号、$&、emoji、U+2028/U+2029
    const tricky = '引号" 单引号\' 反斜杠 C:\\COC\\空白卡 换行\n第二行\t制表 </script> `$&` 😀 \u2028\u2029 结尾';
    const assertRoundTrip = (name, spec, item, get) => {
        const cfg = spec.build([item]);
        const text = JSON.stringify(cfg);
        check(`${name}：紧凑输出里换行被转义`, !text.includes('\n') || text.includes('\\n'));
        check(`${name}：输出里反斜杠被转义`, text.includes('C:\\\\COC\\\\空白卡') || name.includes('MCP'));
        const imported = spec.parseImport(text);
        const ok = imported.ok;
        check(`${name}：导入成功`, ok, JSON.stringify(imported.issues));
        if (!ok) return;
        eq(`${name}：内容逐字相等`, get(imported.items[0]), get(item));
    };

    assertRoundTrip('角色', rolesSpec,
        { name: '转义', prompt: tricky },
        item => item.prompt);
    assertRoundTrip('技能', skillsSpec,
        { name: '转义', description: '摘要 "含引号" \\反斜杠', platform: ['QQ'], content: tricky },
        item => item.content + '|' + item.description);
    assertRoundTrip('知识库', kbSpec,
        { name: '转义', description: '摘要 "含引号"', platform: [], content: tricky },
        item => item.content);

    // MCP 的 header 值也可能含引号/反斜杠；单独校验，避免把 C:\ 路径断言写死
    const mcpCfg = mcpSpec.build([{
        name: 'M', platform: [], enabled: true, type: 'http',
        url: 'http://127.0.0.1:1/mcp',
        token: 'tok"en\\x',
        headers: { 'X-Note': 'quote" back\\slash' },
    }]);
    const mcpText = JSON.stringify(mcpCfg);
    const mcpImported = mcpSpec.parseImport(mcpText);
    check('MCP：转义后仍可导入', mcpImported.ok, JSON.stringify(mcpImported.issues));
    eq('MCP：token 简写合并进 Authorization',
        mcpImported.items[0].headers.Authorization, 'Bearer tok"en\\x');
    eq('MCP：header 逐字相等', mcpImported.items[0].headers['X-Note'], 'quote" back\\slash');

    // 直接手写一份带转义的 JSON（模拟从别处粘贴）
    const handmade = '{"version":1,"skills":[{"name":"手写","content":"第一行\\n第二行 \\"引号\\" \\\\反斜杠\\t制表"}]}';
    const handmadeImported = skillsSpec.parseImport(handmade);
    check('手写转义 JSON 可导入', handmadeImported.ok, JSON.stringify(handmadeImported.issues));
    eq('手写转义 JSON 内容正确', handmadeImported.items[0].content, '第一行\n第二行 "引号" \\反斜杠\t制表');
}

console.log('\n=== 技能：includeDefaults 与 resources ===');
{
    const legacyItems = [
        { name: 'S', description: '', platform: [], content: '正文' },
        { name: 'T', description: '描述', platform: ['QQ'], content: '正文2' },
    ];
    eq('技能：空 resources / 缺省 options 输出与旧版逐字一致',
        JSON.stringify(buildSkills(legacyItems)),
        '{"version":1,"skills":[{"name":"S","content":"正文"},{"name":"T","description":"描述","platform":["QQ"],"content":"正文2"}]}');
    eq('技能：spec.build 缺省输出与 buildSkills 一致',
        JSON.stringify(skillsSpec.build(legacyItems)), JSON.stringify(buildSkills(legacyItems)));

    eq('技能：newSkill 带空 resources', JSON.stringify(skillsSpec.newItem().resources), '{}');

    const withEmptyResources = buildSkills([
        { name: 'S', description: '', platform: [], content: '正文', resources: {} },
    ]);
    eq('技能：空 resources 不输出', JSON.stringify(withEmptyResources), '{"version":1,"skills":[{"name":"S","content":"正文"}]}');

    const off = buildSkills(legacyItems, { includeDefaults: false });
    eq('技能：includeDefaults:false 输出且位于 skills 前',
        JSON.stringify(off),
        '{"version":1,"includeDefaults":false,"skills":[{"name":"S","content":"正文"},{"name":"T","description":"描述","platform":["QQ"],"content":"正文2"}]}');
    eq('技能：includeDefaults:true 不输出',
        JSON.stringify(buildSkills(legacyItems, { includeDefaults: true })), JSON.stringify(buildSkills(legacyItems)));
    eq('技能：includeDefaults 缺省不输出',
        JSON.stringify(buildSkills(legacyItems, {})), JSON.stringify(buildSkills(legacyItems)));
    eq('技能：spec.build 第二参生效',
        skillsSpec.build(legacyItems, { includeDefaults: false }).includeDefaults, false);

    const withResources = buildSkills([{
        name: 'S', description: '', platform: [], content: '正文',
        resources: { 'references/forms.md': '# 表格\n内容', 'notes.txt': '备注' },
    }]);
    eq('技能：resources 输出（在 content 之后）',
        JSON.stringify(withResources),
        JSON.stringify({
            version: 1,
            skills: [{
                name: 'S', content: '正文',
                resources: { 'references/forms.md': '# 表格\n内容', 'notes.txt': '备注' },
            }],
        }));

    const advanced = {
        version: 1,
        includeDefaults: false,
        skills: [{
            name: 'S', description: '描述', platform: ['QQ'], content: '# 正文\n内容',
            resources: { 'references/forms.md': '# 表格', 'notes.txt': '备注' },
        }],
    };
    const advancedText = JSON.stringify(advanced);
    const imported = parseSkillsImport(advancedText);
    check('技能：带 includeDefaults/resources 导入成功', imported.ok, JSON.stringify(imported.issues));
    eq('技能：导入带出 options.includeDefaults', imported.options?.includeDefaults, false);
    eq('技能：includeDefaults + resources 逐字往返',
        JSON.stringify(buildSkills(imported.items, imported.options)), advancedText);

    const plain = parseSkillsImport('{"version":1,"skills":[]}');
    check('技能：输入没有 includeDefaults 时不返回 options', plain.ok && !('options' in plain));
    const offOnly = parseSkillsImport('{"version":1,"includeDefaults":false,"skills":[]}');
    eq('技能：只有 includeDefaults 也逐字往返',
        JSON.stringify(buildSkills(offOnly.items, offOnly.options)), '{"version":1,"includeDefaults":false,"skills":[]}');

    check('技能：卡片显示资源数量', skillsSpec.cardMeta({
        name: 'S', platform: [], content: 'x', resources: { 'a.md': '1', 'b.md': '2' },
    }).includes('2 个资源'));

    const option = (skillsSpec.options || []).find(o => o.key === 'includeDefaults');
    check('技能 spec 定义 includeDefaults 复选框', !!option && option.type === 'checkbox' && option.default === true && !!option.note);
    check('技能 spec 暴露 fromFiles', typeof skillsSpec.fromFiles === 'function');
    check('技能 spec 保留 fromFile', typeof skillsSpec.fromFile === 'function');
}

console.log('\n=== 技能：非法 resources / includeDefaults 必须拒绝 ===');
{
    const cases = [
        ['resources 是非对象', { version: 1, skills: [{ name: 'S', content: 'C', resources: [] }] }],
        ['resources 路径穿越', { version: 1, skills: [{ name: 'S', content: 'C', resources: { '../secret.md': 'x' } }] }],
        ['resources 反斜杠路径穿越', { version: 1, skills: [{ name: 'S', content: 'C', resources: { 'references\\..\\secret.md': 'x' } }] }],
        ['resources 绝对路径', { version: 1, skills: [{ name: 'S', content: 'C', resources: { '/etc/passwd': 'x' } }] }],
        ['resources Windows 绝对路径', { version: 1, skills: [{ name: 'S', content: 'C', resources: { 'C:\\secret.md': 'x' } }] }],
        ['resources 空 key', { version: 1, skills: [{ name: 'S', content: 'C', resources: { '': 'x' } }] }],
        ['resources key 超长', { version: 1, skills: [{ name: 'S', content: 'C', resources: { ['a'.repeat(121)]: 'x' } }] }],
        ['resources key 含控制字符', { version: 1, skills: [{ name: 'S', content: 'C', resources: { 'a\u0000b.md': 'x' } }] }],
        ['resources 空 value', { version: 1, skills: [{ name: 'S', content: 'C', resources: { 'a.md': '   ' } }] }],
        ['resources value 非字符串', { version: 1, skills: [{ name: 'S', content: 'C', resources: { 'a.md': 42 } }] }],
        ['includeDefaults 非布尔', { version: 1, includeDefaults: 'no', skills: [] }],
    ];
    for (const [name, value] of cases) {
        const result = skillsSpec.parseImport(JSON.stringify(value));
        check(`拒绝：${name}`, !result.ok, JSON.stringify(result.issues));
    }

    const long = validateSkills([{
        name: 'S', description: '', platform: [], content: 'C',
        resources: { 'a.md': 'x'.repeat(12001) },
    }]);
    eq('技能：超长资源只 warning 不阻断', long.problems.length, 0);
    check('技能：超长资源有 12000 提示', long.warnings.some(w => /12000/.test(w.msg)));

    const many = {};
    for (let i = 0; i < 51; i++) many[`r${i}.md`] = 'x';
    const manyResult = validateSkills([{ name: 'S', description: '', platform: [], content: 'C', resources: many }]);
    eq('技能：51 个资源不阻断', manyResult.problems.length, 0);
    check('技能：超过 50 个资源有提示', manyResult.warnings.some(w => /50/.test(w.msg)));

    const disabled = validateSkills([{
        name: '', description: '', platform: [], content: '', enabled: false,
        resources: { '/abs.md': 'x' },
    }]);
    eq('技能：停用条目的非法 resources 不参与校验', disabled.problems.length, 0);
}

console.log('\n=== 技能目录导入（skillFromFiles） ===');
{
    const single = skillFromFiles([
        { path: 'my-skill/SKILL.md', text: '---\nname: 目录技能\ndescription: 来自目录\nplatform: [QQ]\n---\n# 正文\n内容' },
        { path: 'my-skill/references/forms.md', text: '# 表单\n内容' },
        { path: 'my-skill/notes.txt', text: '备注' },
    ]);
    check('目录导入：单目录成功', single.ok, JSON.stringify(single.issues));
    eq('目录导入：1 个技能', single.items.length, 1);
    eq('目录导入：name', single.items[0].name, '目录技能');
    eq('目录导入：description', single.items[0].description, '来自目录');
    eq('目录导入：platform', JSON.stringify(single.items[0].platform), JSON.stringify(['QQ']));
    eq('目录导入：resources 路径（相对根目录，保持输入顺序）',
        JSON.stringify(Object.keys(single.items[0].resources)),
        JSON.stringify(['references/forms.md', 'notes.txt']));
    eq('目录导入：resources 内容', single.items[0].resources['references/forms.md'], '# 表单\n内容');
    eq('目录导入：item 结构',
        JSON.stringify(Object.keys(single.items[0])),
        JSON.stringify(['name', 'description', 'platform', 'content', 'resources']));

    const multi = skillFromFiles([
        { path: 'b/SKILL.md', text: '---\nname: B\n---\n正文 B' },
        { path: 'a/SKILL.md', text: '---\nname: A\n---\n正文 A' },
        { path: 'a/ref/x.md', text: 'X' },
    ]);
    check('目录导入：多个顶层目录成功', multi.ok, JSON.stringify(multi.issues));
    eq('目录导入：多目录保持输入顺序', JSON.stringify(multi.items.map(x => x.name)), JSON.stringify(['B', 'A']));
    eq('目录导入：资源只归属自己的目录', JSON.stringify(multi.items[1].resources), JSON.stringify({ 'ref/x.md': 'X' }));
    eq('目录导入：无资源目录给空对象', JSON.stringify(multi.items[0].resources), '{}');

    const win = skillFromFiles([
        { path: 'win-skill\\SKILL.md', text: '---\nname: Win\n---\n正文' },
        { path: 'win-skill\\references\\forms.md', text: '# F' },
    ]);
    check('目录导入：Windows 反斜杠归一化', win.ok, JSON.stringify(win.issues));
    eq('目录导入：反斜杠资源键', JSON.stringify(Object.keys(win.items[0].resources)), JSON.stringify(['references/forms.md']));

    const upper = skillFromFiles([{ path: 'u/skill.MD', text: '---\nname: Upper\n---\n正文' }]);
    check('目录导入：SKILL.md 大小写不敏感', upper.ok, JSON.stringify(upper.issues));
    eq('目录导入：大小写不敏感取到 name', upper.items[0].name, 'Upper');

    const none = skillFromFiles([{ path: 'my-skill/README.md', text: '只有说明' }]);
    check('目录导入：没有 SKILL.md 拒绝', !none.ok);
    eq('目录导入：拒绝路径固定为 目录', none.issues?.[0]?.path, '目录');
    eq('目录导入：拒绝消息', none.issues?.[0]?.msg, '未找到 SKILL.md');
    eq('目录导入：只有一条拒绝原因', none.issues?.length, 1);

    const filtered = skillFromFiles([
        { path: 's/SKILL.md', text: '---\nname: S\n---\n正文' },
        { path: 's/.hidden.md', text: '隐藏文件' },
        { path: 's/.git/config', text: 'git 配置' },
        { path: 's/logo.png', text: 'PNG' },
        { path: 's/Makefile', text: 'all:\n\techo hi' },
        { path: 's/blob.md', text: 'a\u0000b' },
    ]);
    check('目录导入：隐藏/不支持/二进制混合时仍成功', filtered.ok, JSON.stringify(filtered.issues));
    eq('目录导入：只保留允许的文本资源', JSON.stringify(Object.keys(filtered.items[0].resources)), JSON.stringify(['Makefile']));
    check('目录导入：不支持扩展名有 warning', (filtered.warnings || []).some(w => /不支持/.test(w.msg) && /\.png/.test(w.msg)));
    check('目录导入：二进制内容有 warning', (filtered.warnings || []).some(w => /二进制/.test(w.msg)));

    const longText = 'x'.repeat(12001);
    const longImport = skillFromFiles([
        { path: 's/SKILL.md', text: '---\nname: S\n---\n正文' },
        { path: 's/references/long.md', text: longText },
    ]);
    check('目录导入：超长资源仍保留', longImport.ok && longImport.items[0].resources['references/long.md'].length === 12001);
    check('目录导入：超长资源有 12000 warning', (longImport.warnings || []).some(w => /12000/.test(w.msg)));

    const manyFiles = [{ path: 's/SKILL.md', text: '---\nname: S\n---\n正文' }];
    for (let i = 0; i < 51; i++) manyFiles.push({ path: `s/r${String(i).padStart(2, '0')}.md`, text: 'x' });
    const manyImport = skillFromFiles(manyFiles);
    check('目录导入：51 个资源仍成功', manyImport.ok, JSON.stringify(manyImport.issues));
    eq('目录导入：51 个资源全部保留', Object.keys(manyImport.items[0].resources).length, 51);
    check('目录导入：超过 50 个资源有 warning', (manyImport.warnings || []).some(w => /50/.test(w.msg)));

    const dup = skillFromFiles([
        { path: 's/SKILL.md', text: '---\nname: S\n---\n正文' },
        { path: 's/a.md', text: '第一份' },
        { path: 's/a.md', text: '第二份' },
    ]);
    check('目录导入：同名资源仍成功', dup.ok, JSON.stringify(dup.issues));
    eq('目录导入：同名资源保留先出现的一份', dup.items[0].resources['a.md'], '第一份');
    check('目录导入：同名资源有 warning', (dup.warnings || []).some(w => /重复/.test(w.msg)));

    const stray = skillFromFiles([
        { path: 'a/SKILL.md', text: '---\nname: A\n---\n正文' },
        { path: 'b/notes.md', text: '不是技能' },
    ]);
    check('目录导入：缺 SKILL.md 的子目录跳过', stray.ok && stray.items.length === 1);
    check('目录导入：被跳过的子目录有 warning', (stray.warnings || []).some(w => /目录 b/.test(w.path)));
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) process.exitCode = 1;
