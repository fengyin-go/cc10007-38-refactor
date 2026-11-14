/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

/** 读侧返回的行一律只读：一次查询拿到的是已确认视图，不允许调用方就地改写。 */
export type ReadonlyRow = Readonly<EntryRow>

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

/**
 * 已确认视图（快照）：一次查询在某个确认版本上看到的全部数据。
 * 快照一经生成即不可变，后续提交只会产生新版本，不会回头改写旧视图。
 */
export type DataSnapshot = {
  /** 单调递增的确认版本号，0 为播种基线，每次成功提交 +1。 */
  readonly version: number
  /** 该版本确认的时间（毫秒时间戳，持久化后跨刷新仍可还原）。 */
  readonly confirmedAt: number
  /** 各业务表在该版本下的不可变行集合。 */
  readonly tables: Readonly<Record<string, readonly ReadonlyRow[]>>
}

export type PageResult = {
  items: ReadonlyRow[]
  total: number
  page: number
  size: number
  /** 本次列表读取所对应的确认版本。 */
  viewVersion: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 动作提交后的最新确认版本；未产生提交（校验失败/幂等重放前）时可能缺省。 */
  viewVersion?: number
  /** 命中幂等记录时为 true：重复确认没有产生新版本。 */
  idempotent?: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
  viewVersion: number
}

/** 统一校验入口的返回结构：读侧（查询参数）与写侧（动作请求）共用一种写法。 */
export type ValidationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

/** 提交一组表变更时的乐观并发参数。 */
export type CommitOptions = {
  /** 调用方读取时依据的版本；与当前版本不一致则拒绝提交，过期读取不得覆盖新版本。 */
  expectedVersion?: number
  /** 幂等键：相同键的重复提交直接重放首次结果，不再产生新版本。 */
  idempotencyKey?: string
  /** 本次提交的说明，会随确认记录一起留痕。 */
  reason?: string
}

export type CommitFailure = {
  ok: false
  message: string
  currentVersion: number
  conflict: boolean
}

export type CommitSuccess = {
  ok: true
  /** 提交后生效的确认版本。 */
  version: number
  snapshot: DataSnapshot
  idempotent: boolean
  /** 本次提交写入的确认记录。 */
  confirmation: ConfirmationRecord
}

export type CommitResult = CommitSuccess | CommitFailure

/** 字段版本确认记录：关系修改与字段版本确认在同一次提交里一起落账。 */
export type ConfirmationRecord = {
  readonly key: string
  readonly idempotencyKey: string
  readonly version: number
  readonly baseVersion: number
  readonly reason: string
  readonly createdAt: number
  /** 本次一起确认的血缘关系编号。 */
  readonly lineageIds: readonly number[]
  /** 本次一起确认的字段定义编号。 */
  readonly schemaIds: readonly number[]
}

/** 血缘可达路径上的一跳。 */
export type LineageHop = {
  readonly relationId: number
  readonly relationNo: string
  readonly fromTable: string
  readonly toTable: string
  readonly status: string
}

export type LineagePath = {
  /** 起点表名。 */
  readonly from: string
  /** 终点表名。 */
  readonly to: string
  /** 起点到终点的逐跳关系，空数组表示起点即终点。 */
  readonly hops: readonly LineageHop[]
  /** 路径上是否含未确认（非已启用）的关系。 */
  readonly hasUnconfirmed: boolean
}
