// 事件触发分区（v5）：一份 JSON = { version: 1, rules: [...] }
// 对应插件「触发」→「事件触发规则」（分组：触发）。
//
// 与插件侧 schema v1 一一对应（见 aiplugin4 src/event/trigger.ts）：
//   { on: 'group_increase', scope: { platforms, sessions, exclude }, match: [{field, equals|regex}], prompt }
// - 一条规则只绑一个**扁平**事件名（不再有 notify.*、不再有 on 数组、无 name、无 toolChoice）；
// - 生成器的「启用」是条目级开关：关闭的规则只留在草稿里，不会写进生成的 JSON；
// - match 内部是**规范数组**；导入时额外接受插件的对象糖 {"sub_type":"leave"}，生成时一律展开成数组。
//
// 纯逻辑（事件表 / 预设 / 迁移 / 校验 / 构建 / 导入）不碰 DOM，node 测试可直接 import。
import {
    isPlainObject, issue, parseDocument, parseJsonWithTrailingCommas, platformLabel,
    readCollection, validateVersion,
} from './common.js';

export const EVENT_TRIGGER_VERSION = 1;
export const MAX_RULES = 50;
export const MAX_MATCH = 10;
export const MAX_SESSIONS = 200;
export const MAX_PLATFORMS = 20;
export const MAX_PROMPT = 4000;

/** match.field 白名单（与插件 EVENT_TRIGGER_FIELDS 一致） */
export const MATCH_FIELDS = [
    'event_type', 'post_type', 'notice_type', 'sub_type', 'request_type',
    'user_id', 'operator_id', 'group_id', 'message_id',
    'is_group', 'is_target_bot', 'platform', 'session_id',
];

const BOOLEAN_FIELDS = ['is_group', 'is_target_bot'];

// ---------------------------------------------------------------- 事件表（唯一中文来源）

/**
 * 生成器下拉事件表（顺序 = 下拉分组顺序）。
 * 只列这些：profile_like 被插件硬排除；gray_tip / input_status 是噪音。
 * 英文预设提示词 = 选中事件时自动填充的初始 prompt（可改、可恢复）。
 */
export const EVENT_TABLE = [
    { on: 'group_increase', label: '入群', group: '群成员', prompt: 'A new member joined the group. Greet them briefly in character.' },
    { on: 'group_decrease', label: '退群', group: '群成员', prompt: 'A member left the group. React briefly in character if appropriate.' },
    { on: 'group_admin', label: '管理变更', group: '群成员', prompt: 'A group admin change happened. React briefly in character if appropriate.' },
    { on: 'group_ban', label: '禁言', group: '群成员', prompt: 'A group member was muted or unmuted. React briefly in character if appropriate.' },
    { on: 'group_card', label: '名片变更', group: '群成员', prompt: 'A member\'s group card changed. React briefly in character if appropriate.' },
    { on: 'group_recall', label: '撤回', group: '群消息', prompt: 'A group message was recalled. React briefly in character; do not speculate about unseen content.' },
    { on: 'group_upload', label: '文件上传', group: '群消息', prompt: 'Someone uploaded a file to the group. React briefly in character if appropriate.' },
    { on: 'group_msg_emoji_like', label: '表情回应', group: '群消息', prompt: 'Someone reacted to a message with an emoji. React briefly in character if appropriate.' },
    { on: 'essence', label: '精华消息', group: '群消息', prompt: 'A message was set as or removed from group essence. React briefly in character if appropriate.' },
    { on: 'group_name', label: '群名变更', group: '群信息', prompt: 'The group name changed. React briefly in character if appropriate.' },
    { on: 'title', label: '头衔变更', group: '群信息', prompt: 'A member\'s group title changed. React briefly in character if appropriate.' },
    { on: 'honor', label: '群荣誉', group: '群信息', prompt: 'A member received a group honor. React briefly in character if appropriate.' },
    { on: 'lucky_king', label: '运气王', group: '群信息', prompt: 'Someone won the lucky king red packet. React briefly in character if appropriate.' },
    { on: 'group_joined', label: '机器人入群', group: '机器人', prompt: 'You just joined this group. Say hello briefly in character.' },
    { on: 'poke', label: '戳一戳', group: '机器人', prompt: 'Someone poked you. Respond in character with a short reaction.' },
    { on: 'friend_add', label: '新好友', group: '好友', prompt: 'You have a new friend. Say hello briefly in character.' },
    { on: 'friend_recall', label: '好友撤回', group: '好友', prompt: 'Your friend recalled a message. React briefly in character.' },
    { on: 'group_request', label: '加群申请', group: '申请', prompt: 'A group join request arrived. Use tools such as call_ob11_api with set_group_add_request to handle it, then reply briefly if appropriate.' },
    { on: 'friend_request', label: '好友申请', group: '申请', prompt: 'A friend request arrived. Use tools such as call_ob11_api with set_friend_add_request to handle it, then reply briefly if appropriate.' },
];

/** 下拉分组（按 group 字段聚合，保持 EVENT_TABLE 顺序） */
export const EVENT_GROUPS = EVENT_TABLE.reduce((groups, event) => {
    let group = groups.find(item => item.label === event.group);
    if (!group) {
        group = { label: event.group, events: [] };
        groups.push(group);
    }
    group.events.push(event.on);
    return groups;
}, []);

export const EVENT_NAMES = EVENT_TABLE.map(item => item.on);
export const EVENT_LABELS = Object.fromEntries(EVENT_TABLE.map(item => [item.on, item.label]));
export const PRESET_PROMPTS = Object.fromEntries(EVENT_TABLE.map(item => [item.on, item.prompt]));

/** 自定义事件（不在事件表里）的兜底预设提示词 */
export const GENERIC_PRESET = 'An event occurred. React in character if appropriate.';

/** 选中事件时自动带入的预设条件（可删）；只有「戳一戳」带默认条件 */
export const DEFAULT_MATCH = {
    poke: [{ field: 'is_target_bot', equals: true }],
};

/** 条件编辑器里的字段清单（中文标签；高级字段排最后） */
export const CONDITION_FIELDS = [
    { value: 'user_id', label: '触发者 user_id', kind: 'text' },
    { value: 'operator_id', label: '操作者 operator_id', kind: 'text' },
    { value: 'group_id', label: '群号 group_id', kind: 'text' },
    { value: 'message_id', label: '消息ID message_id', kind: 'text' },
    { value: 'sub_type', label: '子类型 sub_type', kind: 'enum', options: ['approve', 'invite', 'leave', 'kick', 'ban', 'lift_ban', 'set', 'unset', 'add', 'delete'] },
    { value: 'request_type', label: '请求类型 request_type', kind: 'enum', options: ['group', 'friend'] },
    { value: 'platform', label: '平台 platform', kind: 'text' },
    { value: 'session_id', label: '会话ID session_id', kind: 'text' },
    { value: 'is_group', label: '是否群聊 is_group', kind: 'boolean' },
    { value: 'is_target_bot', label: '是否戳机器人 is_target_bot', kind: 'boolean' },
    { value: 'event_type', label: '事件类型 event_type（高级）', kind: 'text' },
    { value: 'notice_type', label: '通知类型 notice_type（高级）', kind: 'text' },
    { value: 'post_type', label: '事件大类 post_type（高级）', kind: 'text' },
];

const CONDITION_FIELD_MAP = Object.fromEntries(CONDITION_FIELDS.map(item => [item.value, item]));

/** 下拉里「自定义事件…」的哨兵值（内部 on 为空字符串时表示自定义） */
export const CUSTOM_EVENT = '';

// ---------------------------------------------------------------- 小工具

/** 旧版 notify.* 复合名 → 扁平名（notify.poke → poke） */
export function flattenEventName(value) {
    const name = String(value ?? '').trim();
    if (name.startsWith('notify.')) return name.slice('notify.'.length);
    return name;
}

/** 事件对应的英文预设提示词；自定义事件用通用兜底 */
export function presetFor(on) {
    return PRESET_PROMPTS[on] || GENERIC_PRESET;
}

/** 事件的显示名（卡片标题）；自定义事件显示事件名本身 */
export function eventLabel(on) {
    return EVENT_LABELS[on] || String(on ?? '').trim();
}

function effectiveOn(item) {
    if (!item) return '';
    if (typeof item.on === 'string' && item.on.trim()) return item.on.trim();
    if (typeof item.customOn === 'string') return item.customOn.trim();
    return '';
}

function cloneMatch(list) {
    return JSON.parse(JSON.stringify(Array.isArray(list) ? list : []));
}

function sameRow(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** 一个 equals 值是否匹配布尔字段（true / "true" 都算 true） */
function isTrueValue(value) {
    return value === true || value === 'true';
}

/**
 * 事件切换时套用预设（供编辑面板 onFieldChange 使用，纯函数便于 node 测试）：
 * - prompt 为空 / 仍等于上一事件的预设 → 填新事件预设；用户改过则不动；
 * - match 与上一事件的默认条件一致 → 换成新事件默认条件；
 *   否则保留用户条件，并补上/移除对应事件的预设条件（只动预设那几行）。
 */
export function applyEventSelection(draft, prevOn, nextOn) {
    draft.on = nextOn;
    const prompt = typeof draft.prompt === 'string' ? draft.prompt : '';
    const prevPreset = presetFor(prevOn);
    const nextPreset = presetFor(nextOn);
    if (!prompt.trim() || prompt === prevPreset) draft.prompt = nextPreset;

    const prevDefault = DEFAULT_MATCH[prevOn] || [];
    const nextDefault = DEFAULT_MATCH[nextOn] || [];
    let match = cloneMatch(draft.match);
    if (sameRow(match, prevDefault)) {
        match = cloneMatch(nextDefault);
    } else {
        if (prevDefault.length > 0 && nextDefault.length === 0) {
            match = match.filter(row => !prevDefault.some(def => sameRow(row, def)));
        }
        const missing = nextDefault.filter(def => !match.some(row => sameRow(row, def)));
        if (missing.length > 0) match = cloneMatch(missing).concat(match);
    }
    draft.match = match;
    return draft;
}

// ---------------------------------------------------------------- 归一 / 迁移

/**
 * 读取 scope / match 的字符串列表：接受数组，也接受逗号 / 换行分隔的字符串（插件同样兼容）。
 */
function readStringList(value, path, problems, label, max) {
    if (value === undefined || value === null) return [];
    let list;
    if (typeof value === 'string') {
        list = value.split(/[,，\n]/);
    } else if (Array.isArray(value)) {
        list = value;
    } else {
        if (problems) problems.push(issue(path, `${label}必须是字符串或字符串数组`));
        return [];
    }
    const out = [];
    for (const raw of list) {
        if (typeof raw !== 'string') {
            if (problems) problems.push(issue(path, `${label}的每一项必须是字符串`));
            continue;
        }
        const text = raw.trim();
        if (text) out.push(text);
    }
    if (max && out.length > max) {
        problems.push(issue(path, `${label}最多 ${max} 个（当前 ${out.length} 个）`));
    }
    return out;
}

/** 布尔字段的 equals 归一：字符串 "true"/"false" → 布尔 */
function normalizeEquals(field, value) {
    if (BOOLEAN_FIELDS.includes(field)) {
        if (value === 'true') return true;
        if (value === 'false') return false;
    }
    return value;
}

/**
 * 解析 match（数组规范形态或对象糖）→ 规范数组。
 * 与插件 readMatch 同一口径；problems 传入时逐条报错（导入用），不传时宽容归一（草稿用）。
 */
function readMatch(value, path, problems, warnings) {
    if (value === undefined || value === null) return [];
    const rows = [];
    const pushRow = (field, op, raw) => {
        const row = { field };
        if (op === 'regex') row.regex = raw;
        else row.equals = normalizeEquals(field, raw);
        rows.push(row);
    };

    if (Array.isArray(value)) {
        if (value.length > MAX_MATCH) {
            (problems || []).push(issue(path, `match 最多 ${MAX_MATCH} 条（当前 ${value.length} 条）`));
        }
        value.forEach((entry, i) => {
            const entryPath = `${path}[${i}]`;
            if (!isPlainObject(entry)) {
                (problems || []).push(issue(entryPath, '条件必须是对象 {field, regex} 或 {field, equals}'));
                return;
            }
            if (warnings) {
                for (const key of Object.keys(entry)) {
                    if (!['field', 'regex', 'equals'].includes(key)) {
                        warnings.push(issue(`${entryPath}.${key}`, `未知条件键「${key}」，已忽略`));
                    }
                }
            }
            if (typeof entry.field !== 'string' || !MATCH_FIELDS.includes(entry.field)) {
                (problems || []).push(issue(`${entryPath}.field`, `field 必须是白名单字段：${MATCH_FIELDS.join('、')}`));
                return;
            }
            // 与插件一致：null 视为未设置
            const hasRegex = entry.regex !== undefined && entry.regex !== null;
            const hasEquals = entry.equals !== undefined && entry.equals !== null;
            if (hasRegex === hasEquals) {
                (problems || []).push(issue(entryPath, 'regex 与 equals 必须二选一'));
                return;
            }
            if (hasRegex) {
                if (typeof entry.regex !== 'string') {
                    (problems || []).push(issue(`${entryPath}.regex`, 'regex 必须是字符串'));
                    return;
                }
                try {
                    new RegExp(entry.regex);
                } catch (e) {
                    (problems || []).push(issue(`${entryPath}.regex`, `regex 不是合法正则：${e instanceof Error ? e.message : String(e)}`));
                    return;
                }
                pushRow(entry.field, 'regex', entry.regex);
                return;
            }
            if (!['string', 'number', 'boolean'].includes(typeof entry.equals)) {
                (problems || []).push(issue(`${entryPath}.equals`, 'equals 只支持字符串 / 数字 / 布尔值'));
                return;
            }
            pushRow(entry.field, 'equals', entry.equals);
        });
        return rows;
    }

    if (isPlainObject(value)) {
        // 对象糖：{"sub_type":"leave","is_target_bot":true} → 等值条件（正则请用数组形态）
        for (const [field, raw] of Object.entries(value)) {
            if (!MATCH_FIELDS.includes(field)) {
                (problems || []).push(issue(`${path}.${field}`, `field 必须是白名单字段：${MATCH_FIELDS.join('、')}`));
                continue;
            }
            if (raw === null || raw === undefined || typeof raw === 'object') {
                (problems || []).push(issue(`${path}.${field}`, '对象形态的值只支持字符串 / 数字 / 布尔（正则请用数组形态）'));
                continue;
            }
            pushRow(field, 'equals', raw);
        }
        return rows;
    }

    (problems || []).push(issue(path, 'match 必须是数组或对象（对象形态示例：{"sub_type":"leave"}）'));
    return rows;
}

/** 把 match 的 JSON 文本解析成条件行（条件编辑器的「直接编辑 JSON」与保存校验共用） */
export function parseConditionsText(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: true, value: [] };
    let value;
    try {
        value = parseJsonWithTrailingCommas(raw);
    } catch (e) {
        return { ok: false, error: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
    }
    const problems = [];
    const rows = readMatch(value, '$', problems);
    if (problems.length > 0) {
        return { ok: false, error: problems.map(p => `${p.path} ${p.msg}`).join('；') };
    }
    return { ok: true, value: rows };
}

/**
 * 归一一个规则条目（导入 / localStorage 草稿迁移 / 编辑面板保存共用）。
 * 兼容旧版生成器输出：
 *  - 丢弃 name、toolChoice；
 *  - on 数组 → 取第一个并 warning（其余事件请拆成多条规则）；
 *  - notify.poke 等复合名 → 扁平名；
 *  - match 对象糖 → 展开成数组；
 *  - 命中事件表 → 回填下拉；否则进「自定义事件」。
 */
export function normalizeEventTriggerRule(item, problems, path, warnings) {
    const src = isPlainObject(item) ? item : {};
    const p = path || '$';

    const scope = isPlainObject(src.scope) ? src.scope : null;
    if (src.scope !== undefined && src.scope !== null && !scope && problems) {
        problems.push(issue(`${p}.scope`, 'scope 必须是对象（{platforms,sessions,exclude}）'));
    }
    const scopeOf = (key) => (scope && scope[key] !== undefined ? scope[key] : src[key]);
    const platforms = readStringList(scopeOf('platforms'), `${p}.scope.platforms`, problems, '平台列表', MAX_PLATFORMS);
    const sessions = readStringList(scopeOf('sessions'), `${p}.scope.sessions`, problems, '会话白名单', MAX_SESSIONS);
    const exclude = readStringList(scopeOf('exclude'), `${p}.scope.exclude`, problems, '排除会话', MAX_SESSIONS);

    // ---- on（单字符串；旧数组迁移取第一个）
    let rawOn = '';
    if (Array.isArray(src.on)) {
        const first = src.on.find(value => typeof value === 'string' && value.trim());
        rawOn = typeof first === 'string' ? first.trim() : '';
        if (warnings) {
            warnings.push(rawOn
                ? issue(`${p}.on`, src.on.length > 1
                    ? `旧规则 on 是数组，已取第一个「${rawOn}」；其余事件请拆成多条规则`
                    : `on 是数组，已取第一个「${rawOn}」（新格式要求单个事件字符串）`)
                : issue(`${p}.on`, 'on 数组里没有可用的事件名'));
        }
        if (!rawOn && problems) problems.push(issue(`${p}.on`, 'on 数组里没有可用的事件名'));
    } else if (typeof src.on === 'string') {
        rawOn = src.on.trim();
    } else if (src.on !== undefined && src.on !== null && problems) {
        problems.push(issue(`${p}.on`, 'on 必须是单个事件字符串（一条规则只绑一个事件）'));
    }
    rawOn = flattenEventName(rawOn);
    if (rawOn === '*') {
        (problems || []).push(issue(`${p}.on`, '旧版通配符 "*" 已不再支持：一条规则只绑一个具体事件'));
        rawOn = '';
    }

    let on = '';
    let customOn = '';
    if (rawOn && EVENT_NAMES.includes(rawOn)) {
        on = rawOn;
    } else if (rawOn) {
        customOn = rawOn;
    } else if (typeof src.customOn === 'string' && src.customOn.trim()) {
        // 生成器内部草稿形态：on 为空 + customOn 存自定义事件名
        customOn = src.customOn.trim();
    }

    // ---- match
    const match = readMatch(src.match, `${p}.match`, problems, warnings);

    return {
        on,
        customOn,
        platforms,
        sessions,
        exclude,
        match,
        prompt: typeof src.prompt === 'string' ? src.prompt : '',
        // enabled 只是生成器的 UI 开关，不写进 JSON；这里从草稿 / 旧配置里恢复状态
        enabled: src.enabled !== false,
    };
}

// ---------------------------------------------------------------- 校验

function checkStringList(array, path, label, problems, itemLabel, max) {
    if (!Array.isArray(array)) {
        problems.push(issue(path, `${label}必须是字符串数组`));
        return;
    }
    array.forEach((value, i) => {
        if (typeof value !== 'string' || !value.trim()) {
            problems.push(issue(`${path}[${i}]`, `${itemLabel}必须是非空字符串`));
        }
    });
    if (max && array.length > max) {
        problems.push(issue(path, `${label}最多 ${max} 个（当前 ${array.length} 个）`));
    }
}

/** 校验一条 match 条件（面板草稿可能不合法；导入时已在 readMatch 里报过，这里兜底） */
function validateCondition(row, path, problems) {
    if (!isPlainObject(row)) {
        problems.push(issue(path, '条件必须是对象 {field, regex} 或 {field, equals}'));
        return;
    }
    if (typeof row.field !== 'string' || !MATCH_FIELDS.includes(row.field)) {
        problems.push(issue(`${path}.field`, `field 只支持：${MATCH_FIELDS.join('、')}`));
    }
    const hasRegex = Object.prototype.hasOwnProperty.call(row, 'regex') && row.regex !== null && row.regex !== undefined;
    const hasEquals = Object.prototype.hasOwnProperty.call(row, 'equals') && row.equals !== null && row.equals !== undefined;
    if (hasRegex === hasEquals) {
        problems.push(issue(path, 'regex 与 equals 必须二选一（有且只有一个）'));
    }
    if (hasRegex) {
        if (typeof row.regex !== 'string') {
            problems.push(issue(`${path}.regex`, 'regex 必须是字符串'));
        } else {
            try {
                new RegExp(row.regex);
            } catch (e) {
                problems.push(issue(`${path}.regex`, `regex 不是合法正则：${e instanceof Error ? e.message : String(e)}`));
            }
        }
    }
    if (hasEquals && !['string', 'number', 'boolean'].includes(typeof row.equals)) {
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

        const on = effectiveOn(item);
        if (!on) {
            problems.push(issue(`${path}.on`, '事件必填（从下拉选择，或填写自定义事件名）'));
        } else if (!/^[a-z0-9_]+$/.test(on)) {
            problems.push(issue(`${path}.on`, `非法事件名「${on}」：只能用小写字母、数字、下划线（插件同样拒绝）`));
        } else if (!EVENT_NAMES.includes(on)) {
            if (on === 'profile_like' || on === 'gray_tip' || on === 'input_status') {
                warnings.push(issue(`${path}.on`, `「${on}」被插件硬排除，不会触发`));
            } else {
                warnings.push(issue(`${path}.on`, `未知事件「${on}」：插件可能不识别或协议端不上报，可能不会触发`));
            }
        }

        checkStringList(item.platforms, `${path}.scope.platforms`, '平台列表', problems, '平台名', MAX_PLATFORMS);
        checkStringList(item.sessions, `${path}.scope.sessions`, '会话白名单', problems, '会话 UNI-ID', MAX_SESSIONS);
        checkStringList(item.exclude, `${path}.scope.exclude`, '排除会话', problems, '排除会话 UNI-ID', MAX_SESSIONS);

        const match = Array.isArray(item.match) ? item.match : [];
        if (item.match !== undefined && !Array.isArray(item.match)) {
            problems.push(issue(`${path}.match`, 'match 必须是数组'));
        }
        if (match.length > MAX_MATCH) {
            problems.push(issue(`${path}.match`, `match 最多 ${MAX_MATCH} 条（当前 ${match.length} 条）`));
        }
        match.forEach((row, j) => validateCondition(row, `${path}.match[${j}]`, problems));

        if (typeof item.prompt !== 'string' || !item.prompt.trim()) {
            problems.push(issue(`${path}.prompt`, `prompt 必填（1~${MAX_PROMPT} 字）`));
        } else if (item.prompt.length > MAX_PROMPT) {
            problems.push(issue(`${path}.prompt`, `prompt 最长 ${MAX_PROMPT} 字（当前 ${item.prompt.length} 字）`));
        }
    });
    return { problems, warnings };
}

// ---------------------------------------------------------------- 构建

function canonicalMatch(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => {
        const field = row && typeof row.field === 'string' ? row.field : '';
        if (row && row.regex !== undefined && row.regex !== null) {
            return { field, regex: row.regex };
        }
        return { field, equals: row ? row.equals : undefined };
    });
}

export function buildEventTriggerRules(items) {
    const list = (Array.isArray(items) ? items : []).filter(item => item && item.enabled !== false);
    return {
        version: EVENT_TRIGGER_VERSION,
        rules: list.map(item => ({
            on: effectiveOn(item),
            scope: {
                platforms: Array.isArray(item.platforms) ? item.platforms : [],
                sessions: Array.isArray(item.sessions) ? item.sessions : [],
                exclude: Array.isArray(item.exclude) ? item.exclude : [],
            },
            match: canonicalMatch(item.match),
            prompt: typeof item.prompt === 'string' ? item.prompt : '',
        })),
    };
}

// ---------------------------------------------------------------- 导入 / 文件

/** 已知的（已从插件 schema 移除的）旧生成器字段 */
const LEGACY_ITEM_KEYS = ['name', 'toolChoice'];
const KNOWN_DOC_KEYS = ['version', 'rules'];
const KNOWN_ITEM_KEYS = ['on', 'scope', 'match', 'prompt', 'enabled'];
const KNOWN_SCOPE_KEYS = ['platforms', 'sessions', 'exclude'];

/** 收集未知键（只 warning，不拒绝）；旧字段给出更明确的迁移提示 */
function collectUnknownKeys(value, path, warnings) {
    if (!isPlainObject(value)) return;
    for (const key of Object.keys(value)) {
        if (KNOWN_ITEM_KEYS.includes(key)) continue;
        if (LEGACY_ITEM_KEYS.includes(key)) {
            warnings.push(issue(`${path}.${key}`, `旧字段「${key}」已从 schema 移除，导入时丢弃`));
        } else {
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
        return normalizeEventTriggerRule(item, problems, path, warnings);
    });

    const result = validateEventTriggerRules(items);
    problems.push(...result.problems);
    warnings.push(...result.warnings);
    if (problems.length > 0) return { ok: false, issues: problems };
    return { ok: true, items, warnings };
}

/** .json 文件 → 规则列表（与「导入…」同一套解析/迁移） */
export function eventTriggerFromFile(_filename, text) {
    return parseEventTriggerImport(text);
}

// ---------------------------------------------------------------- spec

const EVENT_OPTION_GROUPS = EVENT_GROUPS.map(group => ({
    label: group.label,
    options: group.events.map(on => [on, EVENT_LABELS[on]]),
}));

const PROMPT_PLACEHOLDERS = '{event_text} {event_json} {event_type} {user_id} {operator_id} {group_id} {message_id} {session_id} {platform} {flag} {comment} {sub_type}';

export const eventTriggerSpec = {
    id: 'eventTrigger',
    navLabel: '事件触发',
    title: '事件触发规则',
    itemLabel: '规则',
    hint: '顺序 = 优先级（首条命中）；关闭的规则不写入 JSON',
    configKey: '事件触发规则',
    configGroup: '触发',
    collectionKey: 'rules',
    importPlaceholder: '{"version":1,"rules":[{"on":"group_increase","scope":{"platforms":["QQ"],"sessions":[],"exclude":[]},"match":[{"field":"is_target_bot","equals":true}],"prompt":"A new member joined the group. Greet them briefly in character."}]}',
    fileBase: 'aiplugin4-事件触发规则',
    storageKey: 'aiplugin4-config-event-trigger-draft',
    accept: '.json',
    fileHint: '支持事件触发规则 JSON（新 v1 格式；旧版含 name / toolChoice / on 数组的 JSON 会自动迁移）',
    emptyText: '还没有事件触发规则，点「+ 添加规则」或把 .json 文件拖进来',
    fields: [
        {
            key: 'on',
            label: '事件',
            type: 'select',
            optionGroups: EVENT_OPTION_GROUPS,
            options: [[CUSTOM_EVENT, '自定义事件…']],
            note: '一个规则只绑定一个事件；需要多个事件请建多条规则。下拉事件都是插件已知的扁平事件名。',
        },
        {
            key: 'customOn',
            label: '自定义事件名',
            type: 'text',
            visibleIf: (draft) => !draft.on,
            placeholder: '如 custom_event',
            note: '只能用小写字母、数字、下划线（插件同样校验）；协议端未上报的事件不会触发。',
        },
        {
            key: 'prompt',
            label: '触发提示词',
            type: 'textarea',
            rows: 8,
            required: true,
            actionLabel: '恢复预设提示词',
            onAction(draft) {
                draft.prompt = presetFor(draft.on);
                return true;
            },
            placeholder: PRESET_PROMPTS.group_increase,
            note: `1~4000 字；选中事件时自动填充英文预设（不提供中文预设）。可编辑；点「恢复预设提示词」还原。占位符：${PROMPT_PLACEHOLDERS}（未知占位符渲染为空）。`,
        },
        {
            key: 'scope',
            type: 'details',
            summary: '作用范围（高级，默认全部）',
            fields: [
                {
                    key: 'platforms',
                    label: '平台白名单',
                    type: 'platform',
                    placeholder: 'QQ, DISCORD（留空 = 所有平台）',
                    note: `对应 scope.platforms；留空 = 不限制平台，最多 ${MAX_PLATFORMS} 个`,
                },
                {
                    key: 'sessions',
                    label: '限定会话（每行一个 UNI-ID）',
                    type: 'lines',
                    rows: 3,
                    placeholder: 'QQ-Group:123456',
                    note: `对应 scope.sessions；留空 = 所有会话，最多 ${MAX_SESSIONS} 个`,
                },
                {
                    key: 'exclude',
                    label: '排除会话（每行一个 UNI-ID）',
                    type: 'lines',
                    rows: 3,
                    placeholder: 'QQ-Group:654321',
                    note: `对应 scope.exclude；留空 = 不排除任何会话，最多 ${MAX_SESSIONS} 个`,
                },
            ],
        },
        {
            key: 'match',
            label: '触发条件（match）',
            type: 'conditions',
            rows: 6,
            conditionFields: CONDITION_FIELDS,
            addLabel: '+ 添加条件',
            jsonLabel: '直接编辑 JSON',
            emptyText: '没有条件（事件命中即触发）',
            parseText: parseConditionsText,
            note: `最多 ${MAX_MATCH} 条，全部满足才触发；每条 {field, equals} 或 {field, regex} 二选一。输出始终是规范数组。`,
        },
    ],
    defaults: [],
    newItem() {
        return {
            on: EVENT_TABLE[0].on,
            customOn: '',
            platforms: [],
            sessions: [],
            exclude: [],
            match: [],
            prompt: PRESET_PROMPTS[EVENT_TABLE[0].on],
            enabled: true,
        };
    },
    normalizeItem(item) { return normalizeEventTriggerRule(item); },
    validate: validateEventTriggerRules,
    build: buildEventTriggerRules,
    parseImport: parseEventTriggerImport,
    fromFile: eventTriggerFromFile,
    /** 事件切换钩子（通用层调用）：填预设提示词 + 预设条件，并让面板重渲染 */
    onFieldChange(fieldKey, value, prevValue, draft) {
        if (fieldKey !== 'on') return false;
        applyEventSelection(draft, prevValue, value);
        return true;
    },
    /** 卡片标题 = 中文短事件名 / 自定义事件名 */
    cardTitle(item) {
        const on = effectiveOn(item);
        return eventLabel(on) || '（未设置事件）';
    },
    cardMeta(item) {
        const on = effectiveOn(item);
        const unknown = on && !EVENT_NAMES.includes(on) ? ' · 自定义事件' : '';
        const sessions = Array.isArray(item.sessions) ? item.sessions : [];
        const exclude = Array.isArray(item.exclude) ? item.exclude : [];
        const scopeText = sessions.length > 0
            ? `限 ${sessions.length} 个会话`
            : (exclude.length > 0 ? `排除 ${exclude.length} 个会话` : '所有会话');
        const matchCount = Array.isArray(item.match) ? item.match.length : 0;
        const promptLength = typeof item.prompt === 'string' ? item.prompt.length : 0;
        return `${platformLabel(item.platforms)} · ${scopeText} · ${matchCount} 条条件 · 提示词 ${promptLength} 字${unknown}`;
    },
    usage: [
        '点「+ 添加规则」或卡片上的「编辑」；事件从下拉选中文短名，一个规则只绑一个事件。',
        '选中事件会自动填入英文预设提示词（可改）；点「恢复预设提示词」还原。需要多个事件请建多条规则。',
        '「触发条件」可视化编辑（等于 / 匹配正则），全部条件满足才触发；高级场景可展开「直接编辑 JSON」。',
        '「作用范围（高级）」默认全部平台 / 会话；可限定平台白名单、会话白名单 / 排除会话。',
        '「戳一戳」会自动带一条「是否戳机器人 = true」条件（避免戳别人也触发），可删；其他事件默认无条件。',
        '加群申请 / 好友申请也会正常触发响应：加群申请是主场景；好友申请可能因双方已是好友而无法投递。',
        '点「复制全部」，粘到海豹 → JS插件 → 插件设置 → aiplugin4 →「触发」→「事件触发规则」；重载 JS 生效。',
        '卡片头的「启用」开关只决定是否把该规则写进生成配置（关闭 = 直接移除，不写 enabled 字段）。',
    ],
};
