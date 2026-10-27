// 角色 / 技能 / MCP / 知识库 / 事件触发五个分区的纯逻辑测试（node，无需浏览器）。
// 运行：node tests/domains-run.mjs
import assert from 'node:assert/strict';

import { rolesSpec, roleFromFile } from '../js/domains/roles.js';
import { skillsSpec, skillFromFile } from '../js/domains/skills.js';
import { mcpSpec, parseMcpDocument, maskMcp } from '../js/domains/mcp.js';
import { kbSpec, kbFromFile } from '../js/domains/kb.js';
import {
    eventTriggerSpec, eventTriggerFromFile, normalizeEventTriggerRule,
} from '../js/domains/event-trigger.js';
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
    eq('事件触发默认 0 条（插件出厂为空）', eventTriggerSpec.defaults.length, 0);
    for (const spec of DOMAIN_SPECS) {
        const { problems, warnings } = spec.validate(spec.defaults.map(x => spec.normalizeItem(x)));
        eq(`${spec.id} 默认值无问题`, problems.length + warnings.length, 0);
    }
}

console.log('\n=== 五个分区输出结构 ===');
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

    const et = eventTriggerSpec.build([{
        name: '入群欢迎', on: ['group_increase', 'notify.poke'], platforms: ['QQ'],
        sessions: ['QQ-Group:1'], exclude: [], match: [{ field: 'operator_id', regex: '.+' }],
        prompt: 'P', toolChoice: 'none',
    }]);
    eq('事件触发 version', et.version, 1);
    eq('事件触发 on 多个输出数组', JSON.stringify(et.rules[0].on), JSON.stringify(['group_increase', 'notify.poke']));
    eq('事件触发 scope 结构', Object.keys(et.rules[0].scope).join(','), 'platforms,sessions,exclude');
    eq('事件触发 match 结构', JSON.stringify(et.rules[0].match), JSON.stringify([{ field: 'operator_id', regex: '.+' }]));
    eq('事件触发 toolChoice none 保留', et.rules[0].toolChoice, 'none');
}

console.log('\n=== 启用开关：停用 = 从输出移除，不写 enabled 键 ===');
{
    const cases = [
        ['角色', rolesSpec, { name: 'A', prompt: 'P' }, 'roles'],
        ['技能', skillsSpec, { name: 'S', content: 'C' }, 'skills'],
        ['知识库', kbSpec, { name: 'K', content: 'C' }, 'libraries'],
        ['事件触发', eventTriggerSpec, { name: 'E', on: ['*'], prompt: 'P' }, 'rules'],
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

console.log('\n=== 事件触发：默认输出为空 / 停用不写入 ===');
{
    eq('事件触发默认输出为空规则列表',
        JSON.stringify(eventTriggerSpec.build(eventTriggerSpec.defaults.map(x => eventTriggerSpec.normalizeItem(x)))),
        JSON.stringify({ version: 1, rules: [] }));
    const empty = eventTriggerSpec.validate([]);
    eq('事件触发空列表合法', empty.problems.length + empty.warnings.length, 0);

    const disabled = eventTriggerSpec.build([{ name: 'E', on: ['*'], prompt: 'P', enabled: false }]);
    eq('停用规则不写入 JSON', JSON.stringify(disabled), JSON.stringify({ version: 1, rules: [] }));
    const enabled = eventTriggerSpec.build([{ name: 'E', on: ['*'], prompt: 'P', enabled: true }]);
    check('事件触发输出不含 enabled 键', !JSON.stringify(enabled).includes('"enabled"'));

    // 编辑框里填「逗号分隔」→ 内部数组
    const normalized = normalizeEventTriggerRule({ on: 'group_increase, notify.poke' });
    eq('逗号分隔的 on 归一为数组', JSON.stringify(normalized.on), JSON.stringify(['group_increase', 'notify.poke']));
    eq('toolChoice 缺省为 auto', normalized.toolChoice, 'auto');
    check('auto 不写进输出', !('toolChoice' in eventTriggerSpec.build([{ name: 'E', on: ['*'], prompt: 'P', toolChoice: 'auto' }]).rules[0]));
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

    // 事件触发：与插件示例逐字一致的往返
    const eventText = JSON.stringify({
        version: 1,
        rules: [{
            name: '入群欢迎',
            on: 'group_increase',
            scope: { platforms: ['QQ'], sessions: [], exclude: [] },
            match: [{ field: 'operator_id', regex: '.+' }],
            prompt: '新成员 {user_id} 入群了。请以角色身份用一句话欢迎，不要复述系统提示。',
            toolChoice: 'none',
        }],
    });
    const eventImport = eventTriggerSpec.parseImport(eventText);
    check('事件触发导入成功', eventImport.ok, JSON.stringify(eventImport.issues));
    eq('事件触发往返', JSON.stringify(eventTriggerSpec.build(eventImport.items)), eventText);

    const eventMultiple = JSON.stringify({
        version: 1,
        rules: [{
            name: '多事件',
            on: ['group_increase', 'notify.poke'],
            scope: { platforms: [], sessions: ['QQ-Group:123456'], exclude: ['QQ-Group:654321'] },
            match: [{ field: 'is_group', equals: true }],
            prompt: 'P',
        }],
    });
    const eventMultipleImport = eventTriggerSpec.parseImport(eventMultiple);
    check('事件触发（数组 on / equals）导入成功', eventMultipleImport.ok, JSON.stringify(eventMultipleImport.issues));
    eq('事件触发（数组 on / equals）往返', JSON.stringify(eventTriggerSpec.build(eventMultipleImport.items)), eventMultiple);

    const eventBare = eventTriggerSpec.parseImport(JSON.stringify([{ name: '裸数组', on: 'notify.poke', prompt: 'P' }]));
    check('事件触发支持裸数组导入', eventBare.ok, JSON.stringify(eventBare.issues));
    eq('裸数组 on 输出字符串', JSON.stringify(eventTriggerSpec.build(eventBare.items).rules[0].on), '"notify.poke"');
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
        ['事件触发缺 name', eventTriggerSpec, '{"version":1,"rules":[{"on":"*","prompt":"x"}]}'],
        ['事件触发缺 prompt', eventTriggerSpec, '{"version":1,"rules":[{"name":"A","on":"*"}]}'],
        ['事件触发 version 非法', eventTriggerSpec, '{"version":2,"rules":[]}'],
        ['事件触发缺 rules', eventTriggerSpec, '{"version":1}'],
        ['事件触发 on 非法', eventTriggerSpec, '{"version":1,"rules":[{"name":"A","on":"nope","prompt":"x"}]}'],
        ['事件触发 match 非数组', eventTriggerSpec, '{"version":1,"rules":[{"name":"A","on":"*","prompt":"x","match":{}}]}'],
        ['事件触发 regex 非法', eventTriggerSpec, '{"version":1,"rules":[{"name":"A","on":"*","prompt":"x","match":[{"field":"operator_id","regex":"("}]}]}'],
        ['事件触发 match field 非法', eventTriggerSpec, '{"version":1,"rules":[{"name":"A","on":"*","prompt":"x","match":[{"field":"nope","regex":"."}]}]}'],
        ['事件触发 regex/equals 同时出现', eventTriggerSpec, '{"version":1,"rules":[{"name":"A","on":"*","prompt":"x","match":[{"field":"is_group","regex":".","equals":true}]}]}'],
        ['事件触发 toolChoice 非法', eventTriggerSpec, '{"version":1,"rules":[{"name":"A","on":"*","prompt":"x","toolChoice":"always"}]}'],
    ];
    for (const [name, spec, text] of cases) {
        const result = spec.parseImport(text);
        check(`拒绝：${name}`, !result.ok);
    }

    // 事件触发的数量 / 长度上限（单独构造，避免写成超长字符串）
    const eventRule = (over = {}) => ({ name: 'A', on: '*', prompt: 'P', ...over });
    const eventDoc = (rules) => JSON.stringify({ version: 1, rules });
    check('拒绝：事件触发 rules 超过 50 条',
        !eventTriggerSpec.parseImport(eventDoc(Array.from({ length: 51 }, () => eventRule()))).ok);
    check('拒绝：事件触发 match 超过 10 条',
        !eventTriggerSpec.parseImport(eventDoc([eventRule({
            match: Array.from({ length: 11 }, () => ({ field: 'is_group', equals: true })),
        })])).ok);
    check('拒绝：事件触发 sessions 超过 200 个',
        !eventTriggerSpec.parseImport(eventDoc([eventRule({
            scope: { sessions: Array.from({ length: 201 }, (_, i) => `QQ-Group:${i}`) },
        })])).ok);
    check('拒绝：事件触发 name 超过 40 字',
        !eventTriggerSpec.parseImport(eventDoc([eventRule({ name: '名'.repeat(41) })])).ok);
    check('拒绝：事件触发 prompt 超过 4000 字',
        !eventTriggerSpec.parseImport(eventDoc([eventRule({ prompt: '字'.repeat(4001) })])).ok);
    check('拒绝：事件触发 on 为空数组',
        !eventTriggerSpec.parseImport(eventDoc([eventRule({ on: [] })])).ok);
}

console.log('\n=== 事件触发：未知键只 warning，不拒绝 ===');
{
    const result = eventTriggerSpec.parseImport(JSON.stringify({
        version: 1,
        future: true,
        rules: [{
            name: 'A', on: '*', prompt: 'P', extra: 1,
            scope: { platforms: [], sessoins: [] },
            match: [{ field: 'is_group', equals: true, note: 'x' }],
        }],
    }));
    check('未知键仍可导入', result.ok, JSON.stringify(result.issues));
    check('未知键产生 warning', (result.warnings || []).length >= 3, JSON.stringify(result.warnings));
    check('未知键不写进输出', !JSON.stringify(eventTriggerSpec.build(result.items)).includes('"extra"'));
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

    const eventFile = eventTriggerFromFile('rules.json', JSON.stringify({
        version: 1,
        rules: [{ name: '文件规则', on: 'group_ban', prompt: '提示词' }],
    }));
    check('事件触发文件导入成功', eventFile.ok, JSON.stringify(eventFile.issues));
    eq('事件触发文件导入规则数', eventFile.items.length, 1);
    check('事件触发文件导入非法 JSON 被拒', !eventTriggerFromFile('bad.json', '{bad').ok);
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
    assertRoundTrip('事件触发', eventTriggerSpec,
        { name: '转义', on: '*', prompt: tricky },
        item => item.prompt);

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

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) process.exitCode = 1;
