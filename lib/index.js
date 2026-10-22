/**
 * dsh-session-status — 宿主侧。
 *
 * 唯一的职责：导出实时 Config，供 `dsh-session-status` entry 的配置表单读写。
 * 内置三态作为 schema 默认值；浏览器 resolveLabels 始终合并内置项。
 * 无 webServer、无 subprocess —— 纯配置表单。
 *
 * 解析顺序（settings provider）：schema 默认值 → base → 用户层。
 * 注意：mergeLayers 对数组是「整体替换」语义，所以一旦用户写入 labels，
 * resolved.labels 不再含默认内置项 —— 浏览器端 resolveLabels（lib/status-store.js
 * 与 lib/client.js 内联同款）始终把内置三态合并回来，这才是「内置态不可删」的真正保证。
 */
import z from '@deepseek-ai/schemastery'
import { BUILTIN_LABELS, LABEL_ICONS } from './status-store.js'

export const name = 'dsh-session-status'
export const inject = ['settings']

const LabelSchema = z.object({
  key: z.string(),
  name: z.string(),
  color: z.string(),
  builtin: z.boolean().default(false),
  // 自定义标签的 icon（LABEL_ICONS 之一）；旧数据无此字段 → 默认 'tag'，零迁移。
  icon: z.union([...LABEL_ICONS]).default('tag'),
})

/** settings namespace 的完整结构：自定义标签列表 + 会话 → 标签 key 映射 + 内置标签颜色覆盖。 */
export const STATUS_SCHEMA = z.object({
  labels: z.array(LabelSchema).default(BUILTIN_LABELS).volatile(),
  sessions: z.dict(z.string()).default({}).volatile(),
  // 内置三态的颜色覆盖（key → { color }），用户层写入；不写则用内置默认色。
  overrides: z.dict(z.object({ color: z.string() })).default({}).volatile(),
})

export const Config = STATUS_SCHEMA

/** @param ctx - 宿主上下文（inject: ['settings'] 保证 ctx.settings 可用）。 */
export function apply(ctx) {
  ctx.effect(() => ctx.settings.configure({ auto: false }), 'dsh-session-status: settings presentation')
}
