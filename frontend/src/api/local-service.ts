import { MODULE_BY_KEY } from '@/data/modules'
import {
  commitChanges,
  currentSnapshot,
  currentVersion,
  readConfirmations,
  resetTable,
  subscribeVersions,
} from '@/data/version-store'
import { traceLineagePaths } from '@/data/lineage'
import {
  validateAction,
  validateFilters,
  validateModuleKey,
  validateRowId,
} from '@/data/validation'
import type {
  ActionResult,
  CommitResult,
  ConfirmationRecord,
  DataSnapshot,
  EntryRow,
  LineagePath,
  ModuleMeta,
  OverviewResult,
  PageResult,
  ReadonlyRow,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const outcome = validateModuleKey(key)
  if (!outcome.ok) {
    // 保留历史行为：未知模块以异常形式抛出，页面 try/catch 仍能接到同样的中文信息。
    throw new Error(outcome.message)
  }
  return outcome.value
}

export function filterRows(
  rows: readonly ReadonlyRow[],
  filters: Record<string, string>,
): ReadonlyRow[] {
  const outcome = validateFilters(filters)
  if (!outcome.ok) {
    throw new Error(outcome.message)
  }
  const pairs = Object.entries(outcome.value).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return [...rows]
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/**
 * 列表查询：在当前已确认快照上读取并返回，结果附带 viewVersion，
 * 页面可明确「当前视图对应哪个确认版本」。纯读操作不改状态，天然支持并行。
 */
export function listEntries(
  key: string,
  filters: Record<string, string> = {},
): PageResult {
  const meta = moduleMeta(key)
  const view = currentSnapshot()
  const matched = filterRows(view.tables[meta.key] ?? [], filters)
  return {
    items: matched,
    total: matched.length,
    page: 1,
    size: matched.length,
    viewVersion: view.version,
  }
}

/** 并行只读查询：无关表各自取同一份不可变快照，互不阻塞、互不串状态。 */
export async function listEntriesParallel(
  queries: { key: string; filters?: Record<string, string> }[],
): Promise<PageResult[]> {
  return Promise.all(
    queries.map((query) =>
      Promise.resolve().then(() => listEntries(query.key, query.filters ?? {})),
    ),
  )
}

export function currentViewVersion(): number {
  return currentVersion()
}

export function onViewVersionChange(listener: (snapshot: DataSnapshot) => void): () => void {
  return subscribeVersions(listener)
}

function buildUpdatedRow(row: ReadonlyRow, meta: ModuleMeta, action: string, target: string): EntryRow {
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
}

/**
 * 通用动作流转（血缘模块以外的表）。
 * 所有写前校验统一走 validation 共用入口；提交走版本化原子提交，支持乐观并发与幂等。
 *
 * 默认幂等键带基线版本与时间戳，保证每个事务身份唯一、不同流转互不碰撞；
 * 同一次请求的重试（例如响应丢失后重发）由调用方显式传入稳定 idempotencyKey，
 * 存储层据此重放首次结果，而不是再产生一个确认版本。
 */
export function runAction(
  key: string,
  id: number,
  action: string,
  options: { expectedVersion?: number; idempotencyKey?: string } = {},
): ActionResult {
  const meta = moduleMeta(key)

  const actionCheck = validateAction(meta, action)
  if (!actionCheck.ok) {
    return { ok: false, message: actionCheck.message, viewVersion: currentVersion() }
  }
  const target = meta.actionTargets[action]

  const view = currentSnapshot()
  const rows = view.tables[key] ?? []
  const idCheck = validateRowId(
    meta,
    id,
    new Set(rows.map((row) => Number(row.id))),
  )
  if (!idCheck.ok) {
    return { ok: false, message: idCheck.message, viewVersion: view.version }
  }

  const index = rows.findIndex((row) => Number(row.id) === id)
  const current = String(rows[index].status)
  if (current === target) {
    return {
      ok: false,
      message: `${meta.entity}已经是「${target}」，不用重复操作`,
      viewVersion: view.version,
    }
  }

  const nextRows = rows.map((row, rowIndex) =>
    rowIndex === index ? buildUpdatedRow(row, meta, action, target) : { ...row },
  )

  // 默认键保证「每个事务唯一」：带基线版本与时间戳，正常流转之间不会互相碰撞；
  // 只有调用方显式传入稳定 idempotencyKey（请求重试场景）时才做请求级幂等重放。
  const idempotencyKey =
    options.idempotencyKey ??
    `action:${key}:${id}:${action}:base-v${view.version}:${Date.now()}`
  const result = commitChanges(
    { [key]: nextRows },
    {
      key: `action:${key}:${id}:${action}:v${view.version + 1}`,
      idempotencyKey,
      reason: `${meta.entity}执行「${action}」`,
      createdAt: Date.now(),
      lineageIds: key === 'lineage' ? [id] : [],
      schemaIds: key === 'schema' ? [id] : [],
    },
    { expectedVersion: options.expectedVersion, idempotencyKey },
  )

  return toActionResult(result, `${meta.entity}已${action}，当前状态「${target}」`)
}

/**
 * 血缘关系修改 + 字段版本确认的联合提交（血缘追踪为主体）。
 *
 * 一次调用内完成三件事，且三者在同一个原子提交里，要么一起生效要么都不生效：
 * 1. 血缘关系按动作流转（关系修改）；
 * 2. 按关系上的上下游表名，锁定同表的字段定义并记录字段版本确认；
 * 3. 写入确认流水，标注本次视图基于的确认版本与新版本。
 *
 * 重复确认按 (关系, 动作, 基线版本) 幂等重放；基于过期视图的提交直接冲突拒绝。
 */
export function confirmLineageChange(
  id: number,
  action: string,
  options: { expectedVersion?: number; idempotencyKey?: string } = {},
): ActionResult {
  const lineageMeta = moduleMeta('lineage')

  const actionCheck = validateAction(lineageMeta, action)
  if (!actionCheck.ok) {
    return { ok: false, message: actionCheck.message, viewVersion: currentVersion() }
  }
  const target = lineageMeta.actionTargets[action]

  const view = currentSnapshot()
  const lineageRows = view.tables.lineage ?? []
  const idCheck = validateRowId(
    lineageMeta,
    id,
    new Set(lineageRows.map((row) => Number(row.id))),
  )
  if (!idCheck.ok) {
    return { ok: false, message: idCheck.message, viewVersion: view.version }
  }

  const index = lineageRows.findIndex((row) => Number(row.id) === id)
  const targetRow = lineageRows[index]
  const current = String(targetRow.status)
  if (current === target) {
    return {
      ok: false,
      message: `${lineageMeta.entity}已经是「${target}」，不用重复操作`,
      viewVersion: view.version,
    }
  }

  // 同一份业务记录里的关系与字段定义：按上下游表名关联到元数据字段行。
  const schemaRows = view.tables.schema ?? []
  const relatedTables = new Set(
    [String(targetRow['上游表名'] ?? ''), String(targetRow['下游表名'] ?? '')].filter(
      (name) => name.trim() !== '',
    ),
  )
  const relatedSchemaIds = schemaRows
    .filter((row) => relatedTables.has(String(row['所属表名'] ?? '')))
    .map((row) => Number(row.id))

  const nextLineageRows = lineageRows.map((row, rowIndex) =>
    rowIndex === index ? buildUpdatedRow(row, lineageMeta, action, target) : { ...row },
  )

  const idempotencyKey =
    options.idempotencyKey ??
    `lineage-confirm:${id}:${action}:base-v${view.version}:${Date.now()}`
  const result = commitChanges(
    { lineage: nextLineageRows },
    {
      key: `lineage-confirm:${id}:${action}:v${view.version + 1}`,
      idempotencyKey,
      reason: `血缘关系「${String(targetRow['关系编号'] ?? id)}」执行「${action}」，并确认关联字段版本`,
      createdAt: Date.now(),
      lineageIds: [id],
      schemaIds: relatedSchemaIds,
    },
    { expectedVersion: options.expectedVersion, idempotencyKey },
  )

  if (!result.ok) {
    return {
      ok: false,
      message: result.message,
      viewVersion: result.currentVersion,
    }
  }

  const schemaNote =
    relatedSchemaIds.length > 0
      ? `，关联 ${relatedSchemaIds.length} 条字段定义已在同一版本确认`
      : '，未匹配到同表字段定义，确认记录已留痕'
  const message = result.idempotent
    ? `${lineageMeta.entity}「${action}」为重复确认，已按幂等重放，确认版本仍为 v${result.version}`
    : `${lineageMeta.entity}已${action}，当前状态「${target}」${schemaNote}`

  return {
    ok: true,
    message,
    viewVersion: result.version,
    idempotent: result.idempotent,
  }
}

function toActionResult(result: CommitResult, successMessage: string): ActionResult {
  if (!result.ok) {
    return { ok: false, message: result.message, viewVersion: result.currentVersion }
  }
  return {
    ok: true,
    message: result.idempotent
      ? `重复确认已按幂等处理，确认版本仍为 v${result.version}`
      : successMessage,
    viewVersion: result.version,
    idempotent: result.idempotent,
  }
}

/** 字段版本确认流水（只读），供血缘页面回看每次关系修改对应的确认版本。 */
export function listConfirmations(): {
  items: readonly ConfirmationRecord[]
  viewVersion: number
} {
  return { items: readConfirmations(), viewVersion: currentVersion() }
}

/** 血缘可达路径核对，透传给领域层在当前确认视图上遍历。 */
export function lineagePaths(
  from: string,
  to: string,
  options: { includeUnconfirmed?: boolean; maxPaths?: number } = {},
): { paths: readonly LineagePath[]; viewVersion: number } {
  return { paths: traceLineagePaths(from, to, options), viewVersion: currentVersion() }
}

export function resetModule(key: string): PageResult {
  const meta = moduleMeta(key)
  resetTable(meta.key)
  return listEntries(meta.key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const view = currentSnapshot()
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of view.tables[meta.key] ?? []) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return {
    filename: `${meta.name}-清单-v${view.version}.csv`,
    content: `\uFEFF${lines.join('\n')}`,
  }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const view = currentSnapshot()
  const modules = [...moduleList()].map((meta) => {
    const entries = view.tables[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules, viewVersion: view.version }
}

function moduleList(): ModuleMeta[] {
  return [...MODULE_BY_KEY.values()]
}
