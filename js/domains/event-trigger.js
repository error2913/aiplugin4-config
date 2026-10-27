// 事件触发分区：一份 JSON = { version: 1, rules: [...] }
// 对应插件「触发」→「事件触发规则」（分组：触发）。
//
// 与插件侧 schema v1 一一对应；生成器的「启用」是条目级开关：
// 关闭的规则只留在草稿里，**不会写进生成的 JSON**（也不产生 enabled 字段）。
//
// 规则字段（内部条目形态，扁平存放便于编辑面板绑定）：
//   name / on / platforms / sessions / exclude / match / prompt / toolChoice / enabled
// 输出时再组装成插件的嵌套形态：on + scope{platforms,sessions,exclude} + match + prompt + toolChoice。
import {
    isPlainObject, issue, parseDocument, platformLabel, readCollection, validateVersion,
} from './common.js';

/** 可用事件类型（与插件一致）；"*" 表示全部 */
export const EVENT_TYPES = [
    'group_increase', 'group_decrease', 'group_admin', 'group_ban', 'group_recall',
    'group_msg_emoji_like', 'essence', 'group_upload', 'group_card', 'friend_recall',
    'friend_add', 'group_joined', 'notify.poke', 'notify.group_name', 'notify.title',
    'notify.honor', 'notify.lucky_king', 'notify.profile_like', 'group_request', 'friend_request',
];

/** match.field 白名单（与插件一致） */
export const MATCH_FIELDS = [
    'event_type', 'post_type', 'notice_type', 'sub_type', 'request_type',
    'user_id', 'operator_id', 'group_id', 'message_id',
    'is_group', 'is_target_bot', 'platform', 'session_id',
];

export const TOOL_CHOICES = ['auto', 'none'];

export const MAX_RULES = 50;
export const MAX_MATCH = 10;
export const MAX_SESSIONS = 200;
export const MAX_NAME = 40;
export const MAX_PROMPT = 4000;

/** 导入文档里已知的顶层 / 条目 / scope 键；其余只 warning */
const KNOWN_DOC_KEYS = ['version', 'rules'];
const KNOWN_ITEM_KEYS = ['name', 'on', 'scope', 'match', 'prompt', 'toolChoice', 'enabled'];
const KNOWN_SCOPE_KEYS = ['platforms', 'sessions', 'exclude'];
const KNOWN_MATCH_KEYS = ['field', 'regex', 'equals'];

// ---------------------------------------------------------------- 默认 / 归一

export function newEventTriggerRule() {
    return {
        name: '',
        on: [],
        platforms: [],
        sessions: [],
        exclude: [],
        match: [],
        prompt: '',
        toolChoice: 'auto',
        enabled: true,
    };
}

/**
 * 导入的 on 形态：字符串（可逗号 / 空白分隔多个）或字符串数组 → 字符串数组。
 * 非法值写入 problems 并归一为空数组。
 */
export function parseOn(value, path, problems) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) {
        const out = [];
        value.forEach((raw, i) => {
            if (typeof raw !== 'string' || !raw.trim()) {
                if (problems) problems.push(issue(`${path}[${i}]`, '事件类型必须是非空字符串'));
                return;
            }
            out.push(raw.trim());
        });
        return out;
    }
    if (typeof value !== 'string') {
        if (problems) problems.push(issue(path, 'on 必须是字符串或字符串数组'));
        return [];
    }
    // 中文逗号与空白也当分隔符：手写时容错
    return value.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean);
}

/** 字符串数组字段（sessions / exclude / platforms）→ 去空字符串的新数组 */
function parseStringList(value, path, problems, label) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        if (problems) problems.push(issue(path, `${label} 必须是字符串数组`));
        return [];
    }
    const out = [];
    value.forEach((raw, i) => {
        if (typeof raw !== 'string') {
            if (problems) problems.push(issue(`${path}[${i}]`, `${label} 必须是字符串`));
            return;
        }
        const item = raw.trim();
        if (item) out.push(item);
    });
    return out;
}

/** 把 match 条目归一成 {field, regex} / {field, equals}，丢掉其它键（未知键由导入层 warning） */
function normalizeMatchEntry(entry) {
    if (!isPlainObject(entry)) return entry;
    const out = { field: entry.field };
    if (Object.prototype.hasOwnProperty.call(entry, 'regex')) out.regex = entry.regex;
    if (Object.prototype.hasOwnProperty.call(entry, 'equals')) out.equals = entry.equals;
    return out;
}

/**
 * 归一一个规则条目。兼容两种来源：
 *  - 导入的插件形态：{ on, scope: { platforms, sessions, exclude }, match, … }
 *  - 生成器内部 / 草稿形态：扁平的 platforms / sessions / exclude
 * problems 可选：传入时同时做类型检查（导入用），不传时只做宽容归一（编辑面板 / 草稿用）。
 */
export function normalizeEventTriggerRule(item, problems, path) {
    const src = isPlainObject(item) ? item : {};
    const p = path || '$';
    const scope = isPlainObject(src.scope) ? src.scope : null;
    const scopeOf = (key) => (scope && scope[key] !== undefined ? scope[key] : src[key]);

    const platforms = parseStringList(scopeOf('platforms'), `${p}.scope.platforms`, problems, 'platforms');
    const sessions = parseStringList(scopeOf('sessions'), `${p}.scope.sessions`, problems, 'sessions');
    const exclude = parseStringList(scopeOf('exclude'), `${p}.scope.exclude`, problems, 'exclude');

    const matchValue = src.match === undefined || src.match === null ? [] : src.match;
    let match = [];
    if (!Array.isArray(matchValue)) {
        if (problems) problems.push(issue(`${p}.match`, 'match 必须是数组（[{field,regex}] 或 [{field,equals}]）'));
    } else {
        match = matchValue.map(normalizeMatchEntry);
    }

    const toolChoice = typeof src.toolChoice === 'string' && src.toolChoice.trim()
        ? src.toolChoice.trim()
        : 'auto';

    return {
        name: typeof src.name === 'string' ? src.name : '',
        on: parseOn(src.on, `${p}.on`, problems),
        platforms,
        sessions,
        exclude,
        match,
        prompt: typeof src.prompt === 'string' ? src.prompt : '',
        toolChoice,
        // enabled 只是生成器的 UI 开关，不写进 JSON；这里从草稿 / 旧配置里恢复状态
        enabled: src.enabled !== false,
    };
}

// ---------------------------------------------------------------- 校验

function checkStringList(array, path, label, problems, itemLabel, max) {
    if (!Array.isArray(array)) {
        problems.push(issue(path, `${label} 必须是字符串数组`));
        return;
    }
    array.forEach((value, i) => {
        if (typeof value !== 'string' || !value.trim()) {
            problems.push(issue(`${path}[${i}]`, `${itemLabel}必须是非空字符串`));
        }
    });
    if (max && array.length > max) {
        problems.push(issue(path, `${label} 最多 ${max} 个（当前 ${array.length} 个）`));
    }
}

/** 校验一条 match 条件（已归一，但面板草稿可能不合法） */
function validateMatchEntry(entry, path, problems) {
    if (!isPlainObject(entry)) {
        problems.push(issue(path, 'match 条目必须是对象 {field, regex} 或 {field, equals}'));
        return;
    }
    if (typeof entry.field !== 'string' || !MATCH_FIELDS.includes(entry.field)) {
        problems.push(issue(`${path}.field`, `field 只支持：${MATCH_FIELDS.join('、')}`));
    }
    const hasRegex = Object.prototype.hasOwnProperty.call(entry, 'regex');
    const hasEquals = Object.prototype.hasOwnProperty.call(entry, 'equals');
    if (hasRegex === hasEquals) {
        problems.push(issue(path, 'regex 与 equals 必须二选一（有且只有一个）'));
    }
    if (hasRegex) {
        if (typeof entry.regex !== 'string') {
            problems.push(issue(`${path}.regex`, 'regex 必须是字符串'));
        } else {
            try {
                // 只校验能否编译，不执行
                new RegExp(entry.regex);
            } catch (e) {
                problems.push(issue(`${path}.regex`, `regex 不是合法正则：${e instanceof Error ? e.message : String(e)}`));
            }
        }
    }
    if (hasEquals && !['string', 'number', 'boolean'].includes(typeof entry.equals)) {
        problems.push(issue(`${path}.equals`, 'equals 必须是字符串 / 数字 / 布尔值'));
    }
}

export function validateEventTriggerRules(items) {
    const problems = [];
    const warnings = [];
    const list = Array.isArray(items) ? items : [];
    // 「启用」只控制是否写进 JSON：停用条目不参与校验、也不计入条数上限
    const enabled = list.filter(item => item && item.enabled !== false);
    if (enabled.length > MAX_RULES) {
        problems.push(issue('$.rules', `规则最多 ${MAX_RULES} 条（当前 ${enabled.length} 条）`));
    }
    enabled.forEach((item, i) => {
        const path = `$.rules[${i}]`;

        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!name) {
            problems.push(issue(`${path}.name`, 'name 必填（1~40 字）'));
        } else if (name.length > MAX_NAME) {
            problems.push(issue(`${path}.name`, `name 最长 ${MAX_NAME} 字（当前 ${name.length} 字）`));
        }

        const on = Array.isArray(item.on) ? item.on : [];
        if (on.length === 0) {
            problems.push(issue(`${path}.on`, 'on 必填（事件类型，可多个；也可填 "*" 表示全部）'));
        }
        on.forEach((type, j) => {
            if (type !== '*' && !EVENT_TYPES.includes(type)) {
                problems.push(issue(`${path}.on[${j}]`, `未知事件类型 ${JSON.stringify(type)}；可用事件见编辑面板说明，支持 "*"`));
            }
        });

        checkStringList(item.platforms, `${path}.scope.platforms`, 'platforms', problems, '平台名');
        checkStringList(item.sessions, `${path}.scope.sessions`, 'sessions', problems, '会话 UNI-ID', MAX_SESSIONS);
        checkStringList(item.exclude, `${path}.scope.exclude`, 'exclude', problems, '排除会话 UNI-ID', MAX_SESSIONS);

        const match = Array.isArray(item.match) ? item.match : [];
        if (item.match !== undefined && !Array.isArray(item.match)) {
            problems.push(issue(`${path}.match`, 'match 必须是数组'));
        }
        if (match.length > MAX_MATCH) {
            problems.push(issue(`${path}.match`, `match 最多 ${MAX_MATCH} 条（当前 ${match.length} 条）`));
        }
        match.forEach((entry, j) => validateMatchEntry(entry, `${path}.match[${j}]`, problems));

        if (typeof item.prompt !== 'string' || !item.prompt.trim()) {
            problems.push(issue(`${path}.prompt`, `prompt 必填（1~${MAX_PROMPT} 字）`));
        } else if (item.prompt.length > MAX_PROMPT) {
            problems.push(issue(`${path}.prompt`, `prompt 最长 ${MAX_PROMPT} 字（当前 ${item.prompt.length} 字）`));
        }

        if (!TOOL_CHOICES.includes(item.toolChoice)) {
            problems.push(issue(`${path}.toolChoice`, 'toolChoice 只支持 auto / none'));
        }
    });
    return { problems, warnings };
}

// ---------------------------------------------------------------- 构建

export function buildEventTriggerRules(items) {
    const list = (Array.isArray(items) ? items : []).filter(item => item && item.enabled !== false);
    return {
        version: 1,
        rules: list.map(item => {
            // 宽容：内部条目是数组，手写的旧对象 / 测试数据可能是字符串
            const on = parseOn(item.on, '$.on').filter(type => type.trim());
            const rule = {
                name: String(item.name ?? '').trim(),
                // 单个事件输出字符串（与插件示例一致），多个输出数组
                on: on.length === 1 ? on[0] : on,
                scope: {
                    platforms: Array.isArray(item.platforms) ? item.platforms : [],
                    sessions: Array.isArray(item.sessions) ? item.sessions : [],
                    exclude: Array.isArray(item.exclude) ? item.exclude : [],
                },
                match: (Array.isArray(item.match) ? item.match : []).map((entry) => {
                    const out = { field: entry && entry.field };
                    if (entry && entry.regex !== undefined) out.regex = entry.regex;
                    else if (entry && entry.equals !== undefined) out.equals = entry.equals;
                    return out;
                }),
                prompt: typeof item.prompt === 'string' ? item.prompt : '',
            };
            // auto 是插件默认值：省略不写，保持输出干净
            if (item.toolChoice === 'none') rule.toolChoice = 'none';
            return rule;
        }),
    };
}

// ---------------------------------------------------------------- 导入 / 文件

/** 收集未知键（只 warning，不拒绝） */
function collectUnknownKeys(value, path, warnings) {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
        if (!KNOWN_ITEM_KEYS.includes(key)) {
            warnings.push(issue(`${path}.${key}`, `未知键「${key}」，插件只 warning，会忽略`));
        }
    }
    if (isPlainObject(value.scope)) {
        for (const key of Object.keys(value.scope)) {
            if (!KNOWN_SCOPE_KEYS.includes(key)) {
                warnings.push(issue(`${path}.scope.${key}`, `未知 scope 键「${key}」，插件只 warning，会忽略`));
            }
        }
    }
    if (Array.isArray(value.match)) {
        value.match.forEach((entry, i) => {
            if (!isPlainObject(entry)) return;
            for (const key of Object.keys(entry)) {
                if (!KNOWN_MATCH_KEYS.includes(key)) {
                    warnings.push(issue(`${path}.match[${i}].${key}`, `未知 match 键「${key}」，插件只 warning，会忽略`));
                }
            }
        });
    }
}

/** 解析整份 JSON（支持裸数组）；校验通过返回 {ok:true, items, warnings} */
export function parseEventTriggerImport(text) {
    const parsed = parseDocument(text, 'rules', '事件触发规则');
    if (!parsed.ok) return { ok: false, issues: parsed.issues };

    const problems = [];
    const warnings = [];
    validateVersion(parsed.value.version, problems);
    for (const key of Object.keys(parsed.value)) {
        if (!KNOWN_DOC_KEYS.includes(key)) {
            warnings.push(issue(`$.${key}`, `未知顶层键「${key}」，插件只 warning，会忽略`));
        }
    }

    const list = readCollection(parsed.value, 'rules', problems);
    if (list.length > MAX_RULES) {
        problems.push(issue('$.rules', `规则最多 ${MAX_RULES} 条（当前 ${list.length} 条）`));
    }
    const items = list.map((item, i) => {
        const path = `$.rules[${i}]`;
        collectUnknownKeys(item, path, warnings);
        return normalizeEventTriggerRule(item, problems, path);
    });

    const result = validateEventTriggerRules(items);
    problems.push(...result.problems);
    warnings.push(...result.warnings);
    if (problems.length > 0) return { ok: false, issues: problems };
    return { ok: true, items, warnings };
}

/** .json 文件 → 规则列表（与「导入…」同一套解析） */
export function eventTriggerFromFile(_filename, text) {
    return parseEventTriggerImport(text);
}

// ---------------------------------------------------------------- spec

const ON_FIELD_NOTE = [
    '可填单个事件、逗号分隔多个，或 "*"（全部）。可用事件：',
    'group_increase、group_decrease、group_admin、group_ban、group_recall、group_msg_emoji_like、',
    'essence、group_upload、group_card、friend_recall、friend_add、group_joined、',
    'notify.poke、notify.group_name、notify.title、notify.honor、notify.lucky_king、notify.profile_like、',
    'group_request、friend_request。',
].join('');

const MATCH_FIELD_NOTE = [
    '最多 10 条；每条 {field, regex} 或 {field, equals} 二选一。field 可用：',
    'event_type、post_type、notice_type、sub_type、request_type、user_id、operator_id、group_id、',
    'message_id、is_group、is_target_bot、platform、session_id。',
].join('');

export const eventTriggerSpec = {
    id: 'eventTrigger',
    navLabel: '事件触发',
    title: '事件触发规则',
    itemLabel: '规则',
    hint: '顺序 = 插件里的规则匹配顺序；关闭的规则不写入 JSON',
    configKey: '事件触发规则',
    configGroup: '触发',
    collectionKey: 'rules',
    importPlaceholder: '{"version":1,"rules":[{"name":"入群欢迎","on":"group_increase","scope":{"platforms":["QQ"],"sessions":[],"exclude":[]},"match":[{"field":"operator_id","regex":".+"}],"prompt":"新成员 {user_id} 入群了。","toolChoice":"none"}]}',
    fileBase: 'aiplugin4-事件触发规则',
    storageKey: 'aiplugin4-config-event-trigger-draft',
    accept: '.json',
    fileHint: '支持事件触发规则 JSON（与「触发 → 事件触发规则」同格式；也支持裸数组）',
    emptyText: '还没有事件触发规则，点「+ 添加规则」或把 .json 文件拖进来',
    fields: [
        {
            key: 'name',
            label: '规则名',
            type: 'text',
            required: true,
            maxLength: MAX_NAME,
            placeholder: '如：入群欢迎',
            note: '1~40 字，仅用于生成器里辨认规则',
        },
        {
            key: 'on',
            label: '事件类型',
            type: 'text',
            required: true,
            placeholder: '如：group_increase；多个用逗号分隔；全部填 *',
            note: ON_FIELD_NOTE,
        },
        {
            key: 'platforms',
            label: '平台白名单',
            type: 'platform',
            placeholder: 'QQ, DISCORD（留空 = 所有平台）',
            note: '对应 scope.platforms；留空 = 不限制平台',
        },
        {
            key: 'sessions',
            label: '限定会话（每行一个 UNI-ID）',
            type: 'lines',
            rows: 4,
            placeholder: 'QQ-Group:123456',
            note: `对应 scope.sessions；留空 = 所有会话，最多 ${MAX_SESSIONS} 个`,
        },
        {
            key: 'exclude',
            label: '排除会话（每行一个 UNI-ID）',
            type: 'lines',
            rows: 4,
            placeholder: 'QQ-Group:654321',
            note: `对应 scope.exclude；留空 = 不排除任何会话，最多 ${MAX_SESSIONS} 个`,
        },
        {
            key: 'match',
            label: '匹配条件（JSON 数组）',
            type: 'json',
            jsonKind: 'array',
            rows: 6,
            placeholder: '[{"field":"operator_id","regex":".+"}]',
            note: MATCH_FIELD_NOTE,
        },
        {
            key: 'prompt',
            label: '提示词',
            type: 'textarea',
            rows: 10,
            required: true,
            placeholder: '新成员 {user_id} 入群了。请以角色身份用一句话欢迎，不要复述系统提示。',
            note: '1~4000 字。可用占位符：{user_id} {operator_id} {group_id} {session_id} {platform} {event_text} {event_json} {flag} {comment} {sub_type}',
        },
        {
            key: 'toolChoice',
            label: '工具调用',
            type: 'select',
            options: [['auto', 'auto（允许 AI 调用工具，默认）'], ['none', 'none（纯文本回复，不调用工具）']],
            note: 'auto 是插件默认值，生成时省略；none 会写进 JSON',
        },
    ],
    defaults: [],
    newItem: newEventTriggerRule,
    normalizeItem(item) { return normalizeEventTriggerRule(item); },
    validate: validateEventTriggerRules,
    build: buildEventTriggerRules,
    parseImport: parseEventTriggerImport,
    fromFile: eventTriggerFromFile,
    cardMeta(item) {
        const on = Array.isArray(item.on) ? item.on.join(', ') : '';
        const platform = platformLabel(item.platforms);
        const matchCount = Array.isArray(item.match) ? item.match.length : 0;
        return `${on || '未设置事件'} · ${platform}${matchCount > 0 ? ` · ${matchCount} 条匹配` : ''}`;
    },
    usage: [
        '点「+ 添加规则」或卡片上的「编辑」；插件里已有的规则 JSON 可以粘进「导入…」接着改。',
        'on 是触发事件（可多个或 "*"）；scope 限定平台 / 会话 / 排除会话；match 再按事件字段过滤；prompt 是交给 AI 的提示词。',
        'group_request / friend_request 事件也会正常触发响应：group_request 是主场景；friend_request 可能因双方已是好友而无法投递。',
        '点「复制全部」，粘到海豹 → JS插件 → 插件设置 → aiplugin4 →「触发」→「事件触发规则」。',
        '卡片头的「启用」开关只决定是否把该规则写进生成配置（关闭 = 直接移除，不写 enabled 字段）；重载 JS 生效。',
    ],
};
