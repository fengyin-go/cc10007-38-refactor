<template>
  <section class="page" data-module="lineage">
    <header class="page-head">
      <div>
        <h2>血缘追踪管理</h2>
        <p class="page-desc">维护数据血缘关系的输入、执行约束与结果记录，为血缘追踪提供可验证的数据工程流程。</p>
        <VersionBadge class="page-version" :view-version="viewVersion" />
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记血缘关系</button>
        <button class="btn" type="button" @click="exportRows">导出血缘追踪清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="button" @click="reload">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <section class="lineage-panel">
      <h3>血缘可达路径核对（以血缘追踪关系为主对象，基于确认视图 v{{ viewVersion }}）</h3>
      <form class="filter-bar" @submit.prevent="tracePaths">
        <label class="filter-item">
          <span>起点表名（上游）</span>
          <input v-model="traceFrom" list="lineage-table-names" placeholder="输入起点表名" />
        </label>
        <label class="filter-item">
          <span>终点表名（下游）</span>
          <input v-model="traceTo" list="lineage-table-names" placeholder="输入终点表名" />
        </label>
        <label class="filter-item">
          <span>遍历范围</span>
          <select v-model="includeUnconfirmed">
            <option :value="false">仅已启用（已确认链路）</option>
            <option :value="true">含未确认关系</option>
          </select>
        </label>
        <button class="btn primary" type="submit">核对可达路径</button>
      </form>
      <datalist id="lineage-table-names">
        <option v-for="name in tableNames" :key="name" :value="name" />
      </datalist>
      <p v-if="traceMessage" class="error-text">{{ traceMessage }}</p>
      <ul v-if="traceResults.length" class="path-list">
        <li v-for="(path, pathIndex) in traceResults" :key="pathIndex">
          路径 {{ pathIndex + 1 }}：
          <template v-for="(hop, hopIndex) in path.hops" :key="hop.relationId">
            <span>{{ hop.fromTable }}</span>
            <span> —[{{ hop.relationNo }}·{{ hop.status }}]→ </span>
            <span v-if="hopIndex === path.hops.length - 1">{{ hop.toTable }}</span>
          </template>
          <span
            class="path-tag"
            :class="path.hasUnconfirmed ? 'path-tag--unconfirmed' : 'path-tag--confirmed'"
          >
            {{ path.hasUnconfirmed ? '含未确认关系' : '全链路已确认' }}
          </span>
        </li>
      </ul>
      <p v-else-if="traced" class="page-desc">当前确认视图下，两张表之间不存在可达路径。</p>
    </section>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无血缘追踪数据，可先登记血缘关系</td>
        </tr>
      </tbody>
    </table>

    <section v-if="confirmations.length" class="lineage-panel">
      <h3>字段版本确认记录（关系修改与字段版本确认同版本生效）</h3>
      <table class="data-table confirm-table">
        <thead>
          <tr>
            <th>确认版本</th>
            <th>基线版本</th>
            <th>血缘关系</th>
            <th>关联字段定义</th>
            <th>确认说明</th>
            <th>确认时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in confirmationView" :key="item.key">
            <td>v{{ item.version }}</td>
            <td>v{{ item.baseVersion }}</td>
            <td>{{ item.lineageIds.join('、') || '—' }}</td>
            <td>{{ item.schemaIds.join('、') || '未匹配同表字段' }}</td>
            <td>{{ item.reason }}</td>
            <td>{{ formatTime(item.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条血缘追踪记录 · 当前确认视图 v{{ viewVersion }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmLineageChange,
  downloadEntries,
  lineagePaths,
  listConfirmations,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { lineageTableNames } from '@/data/lineage'
import type { ConfirmationRecord, EntryRow, LineagePath } from '@/data/types'
import VersionBadge from '@/components/VersionBadge.vue'

const meta = moduleMeta('lineage')
const columns = ["关系编号", "上游表名", "下游表名", "来源字段", "目标字段", "转换函数", "采集批次", "关系版本"]
const actions = ["提交校验", "启用关系", "停用关系"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "血缘关系总数", "value": 0}, {"label": "已启用关系", "value": 0}, {"label": "待校验关系", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const viewVersion = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 可达路径核对的表单状态。
const traceFrom = ref('')
const traceTo = ref('')
const includeUnconfirmed = ref(false)
const traceResults = ref<readonly LineagePath[]>([])
const traceMessage = ref('')
const traced = ref(false)
const tableNames = ref<string[]>([])

// 字段版本确认流水。
const confirmations = ref<readonly ConfirmationRecord[]>([])
const confirmationView = computed(() =>
  [...confirmations.value].sort((a, b) => b.version - a.version).slice(0, 10),
)

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '血缘关系登记入口尚未接入审批流'
}

/**
 * 关系修改走联合确认：血缘关系流转与字段版本确认在同一个原子提交里，
 * 并携带本页视图版本做乐观并发控制，过期视图会被明确拒绝而不是覆盖新版本。
 */
function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = confirmLineageChange(Number(row.id), action, {
    expectedVersion: viewVersion.value,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function tracePaths() {
  traceMessage.value = ''
  if (!traceFrom.value.trim() || !traceTo.value.trim()) {
    traceMessage.value = '请同时填写起点表名与终点表名'
    traceResults.value = []
    traced.value = false
    return
  }
  const payload = lineagePaths(traceFrom.value, traceTo.value, {
    includeUnconfirmed: includeUnconfirmed.value,
  })
  traceResults.value = payload.paths
  traced.value = true
}

async function reload() {
  errorMessage.value = ''
  try {
    // 血缘列表与元数据字段表互不相关：两个只读查询并行发起，不做全局刷新；
    // 确认流水是只读系统表，并行读取后统一核对版本。
    const [lineagePage, schemaPage, confirmationBook] = await Promise.all([
      listEntries(meta.key, filters.value),
      listEntries('schema'),
      Promise.resolve(listConfirmations()),
    ])
    rows.value = lineagePage.items
    total.value = lineagePage.total
    viewVersion.value = lineagePage.viewVersion
    confirmations.value = confirmationBook.items
    tableNames.value = lineageTableNames()
    // 并行查询必须落在同一确认视图上，否则视为读取失败，不展示拼接状态。
    const versions = new Set([
      lineagePage.viewVersion,
      schemaPage.viewVersion,
      confirmationBook.viewVersion,
    ])
    if (versions.size !== 1) {
      throw new Error('并行查询命中了不同确认版本，请重新查询')
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '血缘追踪列表读取失败'
  }
}

onMounted(reload)
</script>
