// 五个内容分区（角色 / 技能 / MCP / 知识库 / 事件触发）的注册表。
import { rolesSpec } from './roles.js';
import { skillsSpec } from './skills.js';
import { mcpSpec } from './mcp.js';
import { kbSpec } from './kb.js';
import { eventTriggerSpec } from './event-trigger.js';

export const DOMAIN_SPECS = [rolesSpec, skillsSpec, mcpSpec, kbSpec, eventTriggerSpec];

export function specById(id) {
    return DOMAIN_SPECS.find(s => s.id === id) || null;
}
