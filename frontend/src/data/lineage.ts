import { readTable } from './version-store'
import type { LineageHop, LineagePath, ReadonlyRow } from './types'

/**
 * 血缘追踪领域逻辑：一切可达性分析都以「血缘追踪」为主对象，
 * 在一次已确认视图上做图遍历，遍历期间视图不会被写入改动。
 */

const UPSTREAM_FIELD = '上游表名'
const DOWNSTREAM_FIELD = '下游表名'
const RELATION_NO_FIELD = '关系编号'
const ACTIVE_STATUS = '已启用'

function text(row: ReadonlyRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function toHop(row: ReadonlyRow): LineageHop {
  return {
    relationId: Number(row.id),
    relationNo: text(row, RELATION_NO_FIELD),
    fromTable: text(row, UPSTREAM_FIELD),
    toTable: text(row, DOWNSTREAM_FIELD),
    status: String(row.status),
  }
}

/** 当前确认视图里出现过的全部表名，供页面做路径检索的候选提示。 */
export function lineageTableNames(): string[] {
  const names = new Set<string>()
  for (const row of readTable('lineage')) {
    const upstream = text(row, UPSTREAM_FIELD)
    const downstream = text(row, DOWNSTREAM_FIELD)
    if (upstream) names.add(upstream)
    if (downstream) names.add(downstream)
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

function activeRows(includeUnconfirmed: boolean): ReadonlyRow[] {
  const rows = readTable('lineage')
  return includeUnconfirmed ? [...rows] : rows.filter((row) => String(row.status) === ACTIVE_STATUS)
}

/**
 * 核对从 from 到 to 的血缘可达路径。
 *
 * @param includeUnconfirmed true 时把草稿/待校验/已停用关系也纳入遍历，
 *                           并在结果里用 hasUnconfirmed 标出路径上的未确认关系；
 *                           默认只沿「已启用」关系走已确认链路。
 * @param maxPaths 最多返回多少条路径，防止环状图上结果无限膨胀。
 */
export function traceLineagePaths(
  from: string,
  to: string,
  options: { includeUnconfirmed?: boolean; maxPaths?: number } = {},
): LineagePath[] {
  const start = from.trim()
  const target = to.trim()
  if (!start || !target) {
    return []
  }

  const includeUnconfirmed = options.includeUnconfirmed ?? false
  const maxPaths = options.maxPaths ?? 20

  // 邻接表在同一张不可变快照上一次性构建，遍历过程中不受任何提交影响。
  const adjacency = new Map<string, LineageHop[]>()
  for (const row of activeRows(includeUnconfirmed)) {
    const hop = toHop(row)
    if (!hop.fromTable || !hop.toTable) {
      continue
    }
    const edges = adjacency.get(hop.fromTable) ?? []
    edges.push(hop)
    adjacency.set(hop.fromTable, edges)
  }

  const results: LineagePath[] = []
  // 记录当前 DFS 路径上的关系编号，既防环也保证同一条边不会在单条路径里重复。
  const pathEdges: LineageHop[] = []
  const edgeIdsOnPath = new Set<number>()

  const buildPath = (): LineagePath => ({
    from: start,
    to: target,
    hops: pathEdges.map((hop) => ({ ...hop })),
    hasUnconfirmed: pathEdges.some((hop) => hop.status !== ACTIVE_STATUS),
  })

  const dfs = (node: string): void => {
    if (results.length >= maxPaths) {
      return
    }
    if (node === target) {
      results.push(buildPath())
      return
    }
    for (const hop of adjacency.get(node) ?? []) {
      if (edgeIdsOnPath.has(hop.relationId)) {
        continue
      }
      edgeIdsOnPath.add(hop.relationId)
      pathEdges.push(hop)
      dfs(hop.toTable)
      pathEdges.pop()
      edgeIdsOnPath.delete(hop.relationId)
      if (results.length >= maxPaths) {
        return
      }
    }
  }

  dfs(start)
  return results.map((path) => Object.freeze(path) as LineagePath)
}

/** 便捷判断：两张表之间是否存在已确认的可达链路。 */
export function isReachable(from: string, to: string): boolean {
  return traceLineagePaths(from, to, { maxPaths: 1 }).length > 0
}
