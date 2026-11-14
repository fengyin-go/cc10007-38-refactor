import { MODULE_BY_KEY } from './modules'
import type { ModuleMeta, ValidationOutcome } from './types'

/**
 * 统一校验入口。
 *
 * 原先读侧（列表查询参数）和写侧（动作请求）各写各的判断、返回形状也不一致；
 * 现在两类校验都收敛到 validate() 这一个共用入口，统一以 ValidationOutcome 表达结果，
 * 具体规则只声明「取值 + 是否合法 + 不合法时的提示」。
 */

export type Rule<T> = {
  /** 被校验的原始值。 */
  value: T
  /** 合法判定，返回 true 表示通过。 */
  isValid: (value: T) => boolean
  /** 不合法时给读者的中文提示。 */
  message: string
}

export function validate<T>(rule: Rule<T>): ValidationOutcome<T> {
  try {
    if (rule.isValid(rule.value)) {
      return { ok: true, value: rule.value }
    }
  } catch {
    // 判定过程自身抛错也按校验失败处理，避免异常穿透到页面。
  }
  return { ok: false, message: rule.message }
}

/** 模块名是否已登记：读侧查询与写侧动作都要先过这一关。 */
export function validateModuleKey(key: string): ValidationOutcome<ModuleMeta> {
  return validate({
    value: key,
    isValid: (candidate) => MODULE_BY_KEY.has(candidate),
    message: `没有登记名为 ${key} 的业务模块`,
  }).ok
    ? { ok: true, value: MODULE_BY_KEY.get(key) as ModuleMeta }
    : { ok: false, message: `没有登记名为 ${key} 的业务模块` }
}

/** 查询侧：筛选条件必须是字段名到检索词的映射，检索词统一按空白判定。 */
export function validateFilters(
  filters: Record<string, string> | undefined,
): ValidationOutcome<Record<string, string>> {
  return validate({
    value: filters ?? {},
    isValid: (candidate): candidate is Record<string, string> =>
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Object.values(candidate).every((term) => typeof term === 'string'),
    message: '查询条件必须是「字段名 -> 检索词」的映射',
  })
}

/** 动作侧：动作必须在模块登记的动作清单内。 */
export function validateAction(
  meta: ModuleMeta,
  action: string,
): ValidationOutcome<string> {
  return validate({
    value: action,
    isValid: (candidate) => Object.prototype.hasOwnProperty.call(meta.actionTargets, candidate),
    message: `${meta.entity}没有登记「${action}」这个动作`,
  })
}

/** 动作侧：记录编号必须能在当前视图里找到对应行。 */
export function validateRowId(
  meta: ModuleMeta,
  id: number,
  ids: ReadonlySet<number>,
): ValidationOutcome<number> {
  return validate({
    value: id,
    isValid: (candidate) => Number.isFinite(candidate) && ids.has(candidate),
    message: `没有找到编号为 ${id} 的${meta.entity}`,
  })
}
