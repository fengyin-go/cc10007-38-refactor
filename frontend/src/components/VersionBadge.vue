<template>
  <span class="version-badge" :class="{ 'version-badge--stale': stale }" :title="title">
    <span class="version-badge__dot" />
    确认视图 v{{ viewVersion }}
    <template v-if="stale"> · 已有新版本 v{{ latestVersion }}，请重新查询</template>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { currentViewVersion, onViewVersionChange } from '@/api/local-service'

/**
 * 明确标注当前页面数据对应的确认版本。
 * 其它标签页/操作推进了版本时，徽标提示视图过期，而不是靠全局刷新掩盖一致性问题。
 */
const props = defineProps<{ viewVersion: number }>()

const latestVersion = ref(currentViewVersion())
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = onViewVersionChange((snapshot) => {
    latestVersion.value = snapshot.version
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
})

const stale = computed(() => latestVersion.value > props.viewVersion)
const title = computed(() =>
  stale.value
    ? `本页数据来自确认版本 v${props.viewVersion}，当前最新版本 v${latestVersion.value}`
    : `本页数据来自确认版本 v${props.viewVersion}，与最新确认版本一致`,
)
</script>
