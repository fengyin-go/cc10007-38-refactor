<template>
  <section class="page" data-module="dwd">
    <header class="page-head">
      <div>
        <h2>明细层建模管理</h2>
        <p class="page-desc">维护明细层建模配置的输入、执行约束与结果记录，为明细层建模提供可验证的数据工程流程。</p>
        <VersionBadge class="page-version" :view-version="viewVersion" />
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记明细表</button>
        <button class="btn" type="button" @click="exportRows">导出明细层建模清单</button>
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
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无明细层建模数据，可先登记明细表</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条明细层建模记录 · 当前确认视图 v{{ viewVersion }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import VersionBadge from '@/components/VersionBadge.vue'

const meta = moduleMeta('dwd')
const columns = ["表编号", "业务域", "明细表名", "源表依赖", "清洗规则", "去重策略", "分区粒度", "刷新周期"]
const actions = ["提交审核", "启用建模", "停用建模"]
const statuses = ["草稿", "待审核", "已启用", "已停用"]
const stats = [{"label": "明细表总数", "value": 0}, {"label": "已启用表", "value": 0}, {"label": "待审核表", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const viewVersion = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '明细表登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, {
    expectedVersion: viewVersion.value,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    viewVersion.value = payload.viewVersion
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '明细层建模列表读取失败'
  }
}

onMounted(reload)
</script>
