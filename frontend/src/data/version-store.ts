import { SEED_ROWS } from './seed'
import type {
  CommitOptions,
  CommitResult,
  ConfirmationRecord,
  DataSnapshot,
  EntryRow,
  ReadonlyRow,
} from './types'

/**
 * 版本化数据访问边界。
 *
 * 设计要点：
 * - 每次确认提交都会生成一个全新的不可变快照（DataSnapshot），读侧永远只在快照上查询，
 *   编辑过程中不会暴露「改了一半」的可变列表；
 * - 提交是原子的：变更集里的多张表（血缘关系 + 字段版本确认记录）要么一起生效，
 *   要么整体不生效，不存在拼接状态；
 * - expectedVersion 做乐观并发控制，过期读取提交时直接拒绝，不会覆盖新版本；
 * - idempotencyKey 保证重复确认幂等，重放首次结果而不是再产生一个版本；
 * - 无关表的只读查询各自取当前快照即可并行，不需要全局刷新串行化。
 */

const STORAGE_KEY = 'data-layer-studio:versioned'
/** 旧版（无版本）数据的键，首次升级时迁移后保留备份，不破坏原存储约定。 */
const LEGACY_STORAGE_KEY = 'data-layer-studio:entries'

type PersistedState = {
  version: number
  confirmedAt: number
  tables: Record<string, EntryRow[]>
  confirmations: ConfirmationRecord[]
  idempotency: Record<string, string>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 递归冻结：快照对外只读，任何就地修改在开发期就会抛错，而不是悄悄污染视图。 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== null && typeof child === 'object') {
      deepFreeze(child)
    }
  }
  return Object.freeze(value)
}

function seedTables(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

function baselineState(): PersistedState {
  return {
    version: 0,
    confirmedAt: Date.now(),
    tables: seedTables(),
    confirmations: [],
    idempotency: {},
  }
}

/** 旧版无版本存储平滑迁移：用户已有的改动不丢，迁成 version=1 的首个确认视图。 */
function migrateLegacy(): PersistedState | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    const legacy = JSON.parse(raw) as Record<string, EntryRow[]>
    const state = baselineState()
    state.tables = { ...state.tables, ...clone(legacy) }
    state.version = 1
    return state
  } catch {
    return null
  }
}

function loadPersisted(): PersistedState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return baselineState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedState
      if (
        typeof parsed.version === 'number' &&
        parsed.tables &&
        Array.isArray(parsed.confirmations)
      ) {
        return {
          version: parsed.version,
          confirmedAt: parsed.confirmedAt ?? Date.now(),
          tables: parsed.tables,
          confirmations: parsed.confirmations,
          idempotency: parsed.idempotency ?? {},
        }
      }
    } catch {
      // 落盘内容损坏时落到基线，绝不把半截数据当作已确认视图。
    }
  }
  const migrated = migrateLegacy() ?? baselineState()
  persist(migrated)
  return migrated
}

function persist(state: PersistedState): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function toSnapshot(state: PersistedState): DataSnapshot {
  return deepFreeze({
    version: state.version,
    confirmedAt: state.confirmedAt,
    tables: state.tables,
  })
}

let state: PersistedState | null = null

function currentState(): PersistedState {
  if (state === null) {
    state = loadPersisted()
  }
  return state
}

type Listener = (snapshot: DataSnapshot) => void
const listeners = new Set<Listener>()

/** 订阅确认版本推进：页面可据此提示「视图已过期」，而不是靠全局刷新掩盖。 */
export function subscribeVersions(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(snapshot: DataSnapshot): void {
  for (const listener of listeners) {
    listener(snapshot)
  }
}

/**
 * 跨标签页一致：另一个标签页提交会写入同一个 localStorage，
 * 监听 storage 事件把本页内存视图切到最新已确认版本并通知订阅者，
 * 避免本页长期停留在旧快照、再用旧 expectedVersion 提交。
 */
function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY || state === null) {
    return
  }
  const reloaded = loadPersisted()
  if (reloaded.version !== state.version) {
    state = reloaded
    notify(toSnapshot(reloaded))
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', handleStorageEvent)
}

/** 当前已确认视图（不可变慢照）。 */
export function currentSnapshot(): DataSnapshot {
  return toSnapshot(currentState())
}

export function currentVersion(): number {
  return currentState().version
}

/** 按表只读查询：无关表之间互不影响，可并行调用。 */
export function readTable(key: string): readonly ReadonlyRow[] {
  const snapshot = currentSnapshot()
  return snapshot.tables[key] ?? Object.freeze([])
}

export function readConfirmations(): readonly ConfirmationRecord[] {
  return currentState().confirmations.map((item) => deepFreeze({ ...item }))
}

function isPlainTableMap(value: unknown): value is Record<string, EntryRow[]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every(
    (rows) => Array.isArray(rows) && rows.every((row) => row && typeof row === 'object'),
  )
}

/**
 * 原子提交。
 * @param changes 本次要整体生效的表变更（传入的是可变草稿，提交时深拷贝，调用方之后的改动不影响已提交数据）
 * @param confirmation 不携带 version/baseVersion 的确认记录内容，版本由存储层统一落账
 */
export function commitChanges(
  changes: Record<string, EntryRow[]>,
  confirmation: Omit<ConfirmationRecord, 'version' | 'baseVersion'>,
  options: CommitOptions = {},
): CommitResult {
  if (!isPlainTableMap(changes)) {
    return {
      ok: false,
      message: '提交内容必须是「表名 -> 行数组」的变更集',
      currentVersion: currentState().version,
      conflict: false,
    }
  }

  const before = currentState()

  // 乐观并发：基于旧视图的提交一律拒绝，过期读取不能覆盖新版本。
  if (
    options.expectedVersion !== undefined &&
    options.expectedVersion !== before.version
  ) {
    return {
      ok: false,
      message: `视图已过期：读取基于版本 v${options.expectedVersion}，当前已确认版本为 v${before.version}，请重新查询后再提交`,
      currentVersion: before.version,
      conflict: true,
    }
  }

  // 幂等：相同确认键直接重放首次结果，不产生新版本、不重复写关系。
  if (options.idempotencyKey) {
    const replayedKey = before.idempotency[options.idempotencyKey]
    if (replayedKey !== undefined) {
      const replayed = before.confirmations.find((item) => item.key === replayedKey)
      if (replayed) {
        return {
          ok: true,
          version: replayed.version,
          snapshot: toSnapshot(before),
          idempotent: true,
          confirmation: deepFreeze({ ...replayed }),
        }
      }
    }
  }

  const nextVersion = before.version + 1
  const record: ConfirmationRecord = deepFreeze({
    ...confirmation,
    version: nextVersion,
    baseVersion: before.version,
  })

  // 在草稿上构造下一版，任何一步异常都不会触碰当前状态，保证「要么都生效，要么都不生效」。
  const nextState: PersistedState = {
    version: nextVersion,
    confirmedAt: Date.now(),
    tables: { ...before.tables, ...clone(changes) },
    confirmations: [...before.confirmations, record],
    idempotency: options.idempotencyKey
      ? { ...before.idempotency, [options.idempotencyKey]: record.key }
      : before.idempotency,
  }

  try {
    // 先持久化再切换内存视图：落盘失败时当前已确认视图保持不变。
    persist(nextState)
  } catch (error) {
    return {
      ok: false,
      message: `确认版本落盘失败，本次修改未生效：${
        error instanceof Error ? error.message : String(error)
      }`,
      currentVersion: before.version,
      conflict: false,
    }
  }

  state = nextState
  const snapshot = toSnapshot(nextState)
  notify(snapshot)
  return { ok: true, version: nextVersion, snapshot, idempotent: false, confirmation: record }
}

/**
 * 把单张表恢复到播种基线，本身也是一次原子确认提交。
 * 默认键保证每次重置都是独立事务；请求重试幂等由调用方通过 options.idempotencyKey 提供。
 */
export function resetTable(
  key: string,
  options: { idempotencyKey?: string } = {},
): CommitResult {
  const before = currentState()
  const idempotencyKey =
    options.idempotencyKey ?? `reset:${key}:base-v${before.version}:${Date.now()}`
  const changes = { [key]: clone(SEED_ROWS[key] ?? []) }
  return commitChanges(
    changes,
    {
      key: `reset:${key}:v${before.version + 1}`,
      idempotencyKey,
      reason: `重置模块「${key}」到播种基线`,
      createdAt: Date.now(),
      lineageIds: [],
      schemaIds: [],
    },
    { idempotencyKey },
  )
}

export function storageKey(): string {
  return STORAGE_KEY
}
