// 角色 / 技能 / MCP / 知识库 / 事件触发五个分区的纯逻辑测试（node，无需浏览器）。
// 运行：node tests/domains-run.mjs
import assert from 'node:assert/strict';

import { rolesSpec, roleFromFile } from '../js/domains/roles.js';
import { skillsSpec, skillFromFile } from '../js/domains/skills.js';
import { mcpSpec, parseMcpDocument, maskMcp } from '../js/domains/mcp.js';
import { kbSpec, kbFromFile } from '../js/domains/kb.js';
import {
    eventTriggerSpec, eventTriggerFromFile, normalizeEventTriggerRule,
    EVENT_TABLE, EVENT_NAMES, EVENT_GROUPS, EVENT_LABELS,
    DEFAULT_MATCH, applyEventSelection, parseConditionsText, CONDITION_FIELDS, MATCH_FIELDS,
    eventLabel,
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
    eq('MCP image-host 默认用 capability（§9.4 新字段）', DEFAULT_MCP[3].capability, 'image-host');
    check('MCP 默认示例不再写旧字段 imageRefs', !('imageRefs' in DEFAULT_MCP[3]), JSON.stringify(DEFAULT_MCP[3]));
    eq('知识库默认 3 个', DEFAULT_KB.length, 3);
    eq('ob11 知识库平台', JSON.stringify(DEFAULT_KB[2].platform), JSON.stringify(['QQ']));
    check('默认知识库内容包含 ob11', DEFAULT_KB[2].content.includes('call_ob11_api'));
    eq('事件触发默认 0 条（插件出厂为空）', eventTriggerSpec.defaults.length, 0);
    for (const spec of DOMAIN_SPECS) {
        const { problems, warnings } = spec.validate(spec.defaults.map(x => spec.normalizeItem(x)));
        eq(`${spec.id} 默认值无问题`, problems.length + warnings.length, 0);
    }
}

console.log('\n=== 事件触发：事件表 / 中文短名 / 英文预设 ===');
{
    eq('事件表 19 个', EVENT_TABLE.length, 19);
    check('事件名唯一', new Set(EVENT_NAMES).size === EVENT_TABLE.length);
    eq('下拉分组数', EVENT_GROUPS.length, 6);
    eq('分组覆盖全部事件', EVENT_GROUPS.reduce((sum, group) => sum + group.events.length, 0), EVENT_TABLE.length);
    eq('入群中文名', EVENT_LABELS.group_increase, '入群');
    eq('戳一戳中文名', EVENT_LABELS.poke, '戳一戳');
    eq('加群申请中文名', EVENT_LABELS.group_request, '加群申请');
    check('事件表不含 notify.* 复合名', EVENT_TABLE.every(event => !event.on.includes('notify.')));
    check('不提供 profile_like / gray_tip / input_status',
        !EVENT_NAMES.includes('profile_like') && !EVENT_NAMES.includes('gray_tip') && !EVENT_NAMES.includes('input_status'));
    eq('eventLabel 已知事件 → 中文短名', eventLabel('group_increase'), '入群');
    eq('eventLabel 自定义事件 → 事件名', eventLabel('my_event'), 'my_event');
    eq('戳一戳默认条件', JSON.stringify(DEFAULT_MATCH.poke), JSON.stringify([{ field: 'is_target_bot', equals: true }]));
    eq('其他事件无默认条件', DEFAULT_MATCH.group_increase, undefined);
    eq('match 字段白名单与插件一致', MATCH_FIELDS.length, 13);
    check('条件编辑器字段都来自白名单', CONDITION_FIELDS.every(field => MATCH_FIELDS.includes(field.value)));
    check('布尔条件字段 is_target_bot', CONDITION_FIELDS.some(field => field.value === 'is_target_bot' && field.kind === 'boolean'));
    check('sub_type / request_type 给枚举建议',
        CONDITION_FIELDS.some(field => field.value === 'sub_type' && field.kind === 'enum')
        && CONDITION_FIELDS.some(field => field.value === 'request_type' && field.kind === 'enum'));
}

console.log('\n=== 事件触发：切换事件只套用默认条件，提示词不自动填充 ===');
{
    const draft = { on: 'group_increase', prompt: '', match: [] };
    applyEventSelection(draft, 'group_increase', 'poke');
    eq('切到戳一戳：自动带 is_target_bot 条件',
        JSON.stringify(draft.match), JSON.stringify([{ field: 'is_target_bot', equals: true }]));
    eq('提示词保持为空（不自动填充）', draft.prompt, '');

    draft.prompt = '自定义提示词';
    applyEventSelection(draft, 'poke', 'group_decrease');
    eq('切走戳一戳后默认条件移除', JSON.stringify(draft.match), '[]');
    eq('自定义提示词不被切换覆盖', draft.prompt, '自定义提示词');

    // 用户自己的条件不被事件切换冲掉
    const userMatch = { on: 'group_increase', prompt: '', match: [{ field: 'user_id', equals: 'QQ:1' }] };
    applyEventSelection(userMatch, 'group_increase', 'poke');
    eq('用户条件保留，另补戳一戳默认条件',
        JSON.stringify(userMatch.match),
        JSON.stringify([{ field: 'is_target_bot', equals: true }, { field: 'user_id', equals: 'QQ:1' }]));
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
        on: 'group_increase', platforms: ['QQ'], sessions: ['QQ-Group:1'], exclude: [],
        match: [{ field: 'sub_type', equals: 'approve' }, { field: 'user_id', regex: '^QQ:100' }],
        prompt: '',
    }]);
    eq('事件触发 version', et.version, 1);
    eq('事件触发 on 输出单个字符串', et.rules[0].on, 'group_increase');
    eq('事件触发 scope 结构', Object.keys(et.rules[0].scope).join(','), 'platforms,sessions,exclude');
    eq('事件触发 match 规范数组',
        JSON.stringify(et.rules[0].match),
        JSON.stringify([{ field: 'sub_type', equals: 'approve' }, { field: 'user_id', regex: '^QQ:100' }]));
    check('事件触发输出无 name / toolChoice', !('name' in et.rules[0]) && !('toolChoice' in et.rules[0]));
}

console.log('\n=== 启用开关：停用 = 从输出移除，不写 enabled 键 ===');
{
    const cases = [
        ['角色', rolesSpec, { name: 'A', prompt: 'P' }, 'roles'],
        ['技能', skillsSpec, { name: 'S', content: 'C' }, 'skills'],
        ['知识库', kbSpec, { name: 'K', content: 'C' }, 'libraries'],
        ['事件触发', eventTriggerSpec, { on: 'group_increase', prompt: 'P' }, 'rules'],
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

console.log('\n=== 事件触发：默认输出为空 / 停用不写入 / 归一迁移 ===');
{
    eq('事件触发默认输出为空规则列表',
        JSON.stringify(eventTriggerSpec.build(eventTriggerSpec.defaults.map(x => eventTriggerSpec.normalizeItem(x)))),
        JSON.stringify({ version: 1, rules: [] }));
    const empty = eventTriggerSpec.validate([]);
    eq('事件触发空列表合法', empty.problems.length + empty.warnings.length, 0);

    const disabled = eventTriggerSpec.build([{ on: 'group_increase', prompt: 'P', enabled: false }]);
    eq('停用规则不写入 JSON', JSON.stringify(disabled), JSON.stringify({ version: 1, rules: [] }));
    const enabledRule = eventTriggerSpec.build([{ on: 'group_increase', prompt: 'P', enabled: true }]);
    check('事件触发输出不含 enabled 键', !JSON.stringify(enabledRule).includes('"enabled"'));
    check('事件触发输出不含 name / toolChoice',
        !('name' in enabledRule.rules[0]) && !('toolChoice' in enabledRule.rules[0]));

    // 归一 / 迁移：旧字段、on 数组、notify.*、match 对象糖
    const normalized = normalizeEventTriggerRule({
        name: '旧规则', toolChoice: 'none', on: ['notify.poke', 'group_increase'],
        match: { is_target_bot: true }, prompt: 'P',
    });
    eq('旧 on 数组取第一个并扁平化', normalized.on, 'poke');
    eq('旧 match 对象糖展开', JSON.stringify(normalized.match), JSON.stringify([{ field: 'is_target_bot', equals: true }]));
    check('归一结果无 name / toolChoice', !('name' in normalized) && !('toolChoice' in normalized));
    eq('归一保留 prompt', normalized.prompt, 'P');

    // 自定义事件（不在事件表里）→ on 空 + customOn
    const custom = normalizeEventTriggerRule({ on: 'my_custom_event', prompt: 'P' });
    eq('未知事件进自定义模式', custom.on, '');
    eq('自定义事件名保留', custom.customOn, 'my_custom_event');

    // 生成器内部草稿形态：on 为空 + customOn
    const draftCustom = normalizeEventTriggerRule({ on: '', customOn: 'future_event', prompt: 'P' });
    eq('草稿 customOn 迁移', draftCustom.customOn, 'future_event');
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

    // 事件触发：与插件示例逐字一致的往返（无 name / toolChoice，on 单字符串，match 规范数组）
    const eventText = JSON.stringify({
        version: 1,
        rules: [{
            on: 'group_increase',
            scope: { platforms: ['QQ'], sessions: [], exclude: [] },
            match: [{ field: 'sub_type', equals: 'approve' }],
            prompt: 'A new member joined the group. Greet them briefly in character.',
        }],
    });
    const eventImport = eventTriggerSpec.parseImport(eventText);
    check('事件触发导入成功', eventImport.ok, JSON.stringify(eventImport.issues));
    eq('事件触发往返', JSON.stringify(eventTriggerSpec.build(eventImport.items)), eventText);

    // 旧版生成器输出（name / toolChoice / on 数组 / notify.*）迁移后可导入，并规范化输出
    const legacyText = JSON.stringify({
        version: 1,
        rules: [{
            name: '旧规则', toolChoice: 'none',
            on: ['notify.poke', 'group_increase'],
            scope: { platforms: [], sessions: ['QQ-Group:123456'], exclude: [] },
            match: [{ field: 'is_group', equals: true }],
            prompt: 'P',
        }],
    });
    const legacyImport = eventTriggerSpec.parseImport(legacyText);
    check('旧版 JSON 迁移导入成功', legacyImport.ok, JSON.stringify(legacyImport.issues));
    eq('迁移后 on = poke', legacyImport.items[0].on, 'poke');
    check('迁移有 on 数组 warning', (legacyImport.warnings || []).some(w => /on 是数组/.test(w.msg)));
    check('迁移有 name / toolChoice 丢弃提示',
        (legacyImport.warnings || []).some(w => /name/.test(w.msg))
        && (legacyImport.warnings || []).some(w => /toolChoice/.test(w.msg)));
    eq('迁移保留作用范围', JSON.stringify(legacyImport.items[0].sessions), JSON.stringify(['QQ-Group:123456']));

    // match 对象糖（导入）→ 规范数组输出
    const sugarImport = eventTriggerSpec.parseImport(JSON.stringify({
        version: 1,
        rules: [{ on: 'group_decrease', match: { sub_type: 'leave', is_target_bot: false }, prompt: 'P' }],
    }));
    check('match 对象糖导入成功', sugarImport.ok, JSON.stringify(sugarImport.issues));
    eq('对象糖展开为等值数组',
        JSON.stringify(eventTriggerSpec.build(sugarImport.items).rules[0].match),
        JSON.stringify([{ field: 'sub_type', equals: 'leave' }, { field: 'is_target_bot', equals: false }]));

    const eventBare = eventTriggerSpec.parseImport(JSON.stringify([{ on: 'notify.group_name', prompt: 'P' }]));
    check('事件触发支持裸数组导入', eventBare.ok, JSON.stringify(eventBare.issues));
    eq('裸数组 notify.* 扁平化', eventTriggerSpec.build(eventBare.items).rules[0].on, 'group_name');
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
        ['事件触发缺 on', eventTriggerSpec, '{"version":1,"rules":[{"prompt":"x"}]}'],
        ['事件触发 on 为空字符串', eventTriggerSpec, '{"version":1,"rules":[{"on":"","prompt":"x"}]}'],
        ['事件触发 prompt 非字符串', eventTriggerSpec, '{"version":1,"rules":[{"on":"group_increase","prompt":123}]}'],
        ['事件触发 version 非法', eventTriggerSpec, '{"version":2,"rules":[]}'],
        ['事件触发缺 rules', eventTriggerSpec, '{"version":1}'],
        ['事件触发 on 非法字符', eventTriggerSpec, '{"version":1,"rules":[{"on":"bad.name","prompt":"x"}]}'],
        ['事件触发 on 旧通配符', eventTriggerSpec, '{"version":1,"rules":[{"on":"*","prompt":"x"}]}'],
        ['事件触发 match 非数组/对象', eventTriggerSpec, '{"version":1,"rules":[{"on":"group_increase","prompt":"x","match":3}]}'],
        ['事件触发 regex 非法', eventTriggerSpec, '{"version":1,"rules":[{"on":"group_increase","prompt":"x","match":[{"field":"operator_id","regex":"("}]}]}'],
        ['事件触发 match field 非法', eventTriggerSpec, '{"version":1,"rules":[{"on":"group_increase","prompt":"x","match":[{"field":"nope","regex":"."}]}]}'],
        ['事件触发 regex/equals 同时出现', eventTriggerSpec, '{"version":1,"rules":[{"on":"group_increase","prompt":"x","match":[{"field":"is_group","regex":".","equals":true}]}]}'],
        ['事件触发 regex/equals 都不给', eventTriggerSpec, '{"version":1,"rules":[{"on":"group_increase","prompt":"x","match":[{"field":"is_group"}]}]}'],
        ['事件触发对象糖值非法', eventTriggerSpec, '{"version":1,"rules":[{"on":"group_increase","prompt":"x","match":{"is_group":{"bad":1}}}]}'],
        ['事件触发 scope 非对象', eventTriggerSpec, '{"version":1,"rules":[{"on":"group_increase","prompt":"x","scope":[]}]}'],
    ];
    for (const [name, spec, text] of cases) {
        const result = spec.parseImport(text);
        check(`拒绝：${name}`, !result.ok);
    }

    // 事件触发的数量 / 长度上限（单独构造，避免写成超长字符串）
    const eventRule = (over = {}) => ({ on: 'group_increase', prompt: 'P', ...over });
    const eventDoc = (rules) => JSON.stringify({ version: 1, rules });
    check('接受：0 条规则', eventTriggerSpec.parseImport(eventDoc([])).ok);
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
    check('拒绝：事件触发 platforms 超过 20 个',
        !eventTriggerSpec.parseImport(eventDoc([eventRule({
            scope: { platforms: Array.from({ length: 21 }, (_, i) => `P${i}`) },
        })])).ok);
    check('拒绝：事件触发 prompt 超过 4000 字',
        !eventTriggerSpec.parseImport(eventDoc([eventRule({ prompt: '字'.repeat(4001) })])).ok);
    check('拒绝：事件触发 on 为空数组',
        !eventTriggerSpec.parseImport(eventDoc([eventRule({ on: [] })])).ok);
}

console.log('\n=== 事件触发：未知键 / 旧字段 / 自定义事件 ===');
{
    const result = eventTriggerSpec.parseImport(JSON.stringify({
        version: 1,
        future: true,
        rules: [{
            on: 'group_increase', prompt: 'P', extra: 1,
            name: '旧规则名', toolChoice: 'none',
            scope: { platforms: [], sessoins: [] },
            match: [{ field: 'is_group', equals: true, note: 'x' }],
        }],
    }));
    check('未知键 / 旧字段仍可导入', result.ok, JSON.stringify(result.issues));
    check('产生多条 warning', (result.warnings || []).length >= 4, JSON.stringify(result.warnings));
    check('name / toolChoice 有迁移提示',
        (result.warnings || []).some(w => /name/.test(w.msg))
        && (result.warnings || []).some(w => /toolChoice/.test(w.msg)));
    check('未知键不写进输出',
        !JSON.stringify(eventTriggerSpec.build(result.items)).includes('"extra"')
        && !JSON.stringify(eventTriggerSpec.build(result.items)).includes('"name"')
        && !JSON.stringify(eventTriggerSpec.build(result.items)).includes('"toolChoice"'));

    // 自定义事件：合法命名可导入，但带 warning
    const custom = eventTriggerSpec.parseImport(JSON.stringify({
        version: 1,
        rules: [{ on: 'future_event', prompt: 'P' }],
    }));
    check('合法自定义事件可导入', custom.ok, JSON.stringify(custom.issues));
    check('自定义事件有未知事件 warning', (custom.warnings || []).some(w => /未知事件/.test(w.msg)));
    eq('自定义事件进入自定义模式', custom.items[0].on, '');
    eq('自定义事件名保留', custom.items[0].customOn, 'future_event');

    // 被插件硬排除的事件只 warning
    const profile = eventTriggerSpec.parseImport(JSON.stringify({
        version: 1,
        rules: [{ on: 'profile_like', prompt: 'P' }],
    }));
    check('profile_like 可导入', profile.ok, JSON.stringify(profile.issues));
    check('profile_like 有硬排除 warning', (profile.warnings || []).some(w => /硬排除/.test(w.msg)));
}

console.log('\n=== 事件触发：条件 JSON 与可视化行互转 ===');
{
    const parsed = parseConditionsText('[{"field":"is_group","equals":"true"},{"field":"user_id","regex":"^QQ:100"}]');
    check('条件 JSON 解析成功', parsed.ok, parsed.error);
    eq('布尔字段字符串归一为布尔',
        JSON.stringify(parsed.value),
        JSON.stringify([{ field: 'is_group', equals: true }, { field: 'user_id', regex: '^QQ:100' }]));
    const sugar = parseConditionsText('{"sub_type":"leave"}');
    eq('对象糖转条件行', JSON.stringify(sugar.value), JSON.stringify([{ field: 'sub_type', equals: 'leave' }]));
    check('非法条件字段报错', !parseConditionsText('[{"field":"nope","equals":1}]').ok);
    check('非法正则报错', !parseConditionsText('[{"field":"user_id","regex":"("}]').ok);
    check('空文本 = 无条件', parseConditionsText('').ok && parseConditionsText('').value.length === 0);
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
        rules: [{ on: 'group_ban', prompt: '提示词' }],
    }));
    check('事件触发文件导入成功', eventFile.ok, JSON.stringify(eventFile.issues));
    eq('事件触发文件导入规则数', eventFile.items.length, 1);
    check('事件触发文件导入非法 JSON 被拒', !eventTriggerFromFile('bad.json', '{bad').ok);

    const eventLegacyFile = eventTriggerFromFile('old.json', JSON.stringify({
        version: 1,
        rules: [{ name: '旧文件规则', toolChoice: 'none', on: ['notify.poke'], prompt: 'P' }],
    }));
    check('旧版文件迁移导入成功',
        eventLegacyFile.ok && eventLegacyFile.items[0].on === 'poke',
        JSON.stringify(eventLegacyFile.issues));
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

console.log('\n=== MCP capability（§9.4 生成器侧：normalize/build/parse/validate/mask 全链路） ===');
{
    const baseItem = {
        name: 'image-host', platform: [], enabled: true, type: 'http',
        url: 'http://127.0.0.1:46680/mcp', token: '', headers: {},
        capability: 'image-host',
    };

    // build：capability 写进标准 mcpServers 条目
    const built = mcpSpec.build([baseItem]);
    eq('capability 写进输出', built.mcpServers['image-host'].capability, 'image-host');

    // 空值不输出（保持配置紧凑，也避免给插件塞无意义字段）
    const plain = mcpSpec.build([{ ...baseItem, capability: '' }]);
    check('不填 capability → 输出没有该字段', !('capability' in plain.mcpServers['image-host']),
        JSON.stringify(plain.mcpServers['image-host']));

    // parse → normalize → build 往返
    const parsed = mcpSpec.parseImport(JSON.stringify(built));
    check('含 capability 的输出可导入', parsed.ok, JSON.stringify(parsed.issues));
    eq('导入后 capability 保留', parsed.items[0].capability, 'image-host');
    check('导入无警告', parsed.warnings.length === 0, JSON.stringify(parsed.warnings));
    eq('往返输出逐字节一致', JSON.stringify(mcpSpec.build(parsed.items)), JSON.stringify(built));

    // 未知 capability：警告后忽略（与插件 parse.ts 同口径，不阻断整份导入）
    const unknown = mcpSpec.parseImport(JSON.stringify({
        mcpServers: { M: { url: 'http://127.0.0.1:1/mcp', capability: 'memory-host' } },
    }));
    check('未知 capability 仍可导入（不整份拒绝）', unknown.ok, JSON.stringify(unknown.issues));
    check('未知 capability 给警告', (unknown.warnings || []).some(w => /capability/.test(w.msg)),
        JSON.stringify(unknown.warnings));
    check('未知 capability 不写进输出',
        !('capability' in mcpSpec.build(unknown.items).mcpServers.M),
        JSON.stringify(mcpSpec.build(unknown.items)));
    const normUnknown = mcpSpec.normalizeItem({ name: 'M', url: 'http://x', capability: 'memory-host' });
    check('normalizeItem 丢弃未知 capability', !('capability' in normUnknown), JSON.stringify(normUnknown));
    const normKnown = mcpSpec.normalizeItem({ name: 'M', url: 'http://x', capability: 'image-host' });
    eq('normalizeItem 保留合法 capability', normKnown.capability, 'image-host');

    // validate：合法 capability 不产生问题
    const v = mcpSpec.validate([baseItem]);
    check('含 capability 的条目校验无问题',
        v.problems.length === 0 && v.warnings.length === 0, JSON.stringify(v));
    eq('newServer 默认 capability 为空', mcpSpec.newItem().capability, '');

    // mask：遮蔽敏感头时不能把能力声明弄丢
    const masked = maskMcp(mcpSpec.build([{ ...baseItem, headers: { Authorization: 'Bearer x' } }]));
    eq('遮蔽后 capability 保留', masked.mcpServers['image-host'].capability, 'image-host');
    eq('遮蔽仍生效', masked.mcpServers['image-host'].headers.Authorization, 'xxxx');

    // ---- 旧 imageRefs:true 兼容一版：保留（不映射成 capability） ----
    // 语义不同：imageRefs 管"工具结果里的 [img:<sha>] 规范化"，capability 管"图床适配器注册"。
    // 映射会改变含义，所以选择**原样往返**。
    const legacy = mcpSpec.parseImport(JSON.stringify({
        mcpServers: { 'image-host': { url: 'http://127.0.0.1:1/mcp', imageRefs: true } },
    }));
    check('旧 imageRefs 仍可导入', legacy.ok, JSON.stringify(legacy.issues));
    eq('旧 imageRefs 保留', legacy.items[0].imageRefs, true);
    check('旧 imageRefs 不会被偷换成 capability', !('capability' in legacy.items[0]),
        JSON.stringify(legacy.items[0]));
    eq('旧 imageRefs 导出仍是 imageRefs',
        JSON.stringify(mcpSpec.build(legacy.items).mcpServers['image-host'].imageRefs), 'true');

    // 两者同时出现也各自保留（旧配置升级到新字段的过渡形态）
    const both = mcpSpec.parseImport(JSON.stringify({
        mcpServers: { 'image-host': { url: 'http://127.0.0.1:1/mcp', capability: 'image-host', imageRefs: true } },
    }));
    check('capability 与 imageRefs 可共存', both.ok);
    eq('共存时 capability 保留', both.items[0].capability, 'image-host');
    eq('共存时 imageRefs 保留', both.items[0].imageRefs, true);

    // 默认数据（tools/sync-default-data.mjs 生成）必须能被插件解析
    const defBuilt = mcpSpec.build(DEFAULT_MCP.map(x => mcpSpec.normalizeItem(x)));
    eq('默认数据 image-host 输出 capability', defBuilt.mcpServers['image-host'].capability, 'image-host');
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
        { on: 'group_increase', prompt: tricky },
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
