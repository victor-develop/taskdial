/**
 * server 发来的 intent 怎么落到状态上。
 *
 * 纯函数：不碰 Tauri、不碰网络，只是把 HTTP 语义翻译成一串 reducer 调用 ——
 * 状态机还是 model.ts 里唯一那份，这里绝不复刻规则，只在规则挡住时
 * 给出人话的错误（server 端映射成 422）。
 */
import type { Model, State } from './model'

export type Intent =
  | { op: 'addSlice'; name?: string; lenMin?: number }
  | { op: 'updateSlice'; id: string; name?: string; lenMin?: number }
  | { op: 'removeSlice'; id: string }
  | { op: 'pause'; reason?: string }
  | { op: 'resume' }

export type IntentResult = { ok: true; next: State } | { ok: false; error: string }

const fail = (error: string): IntentResult => ({ ok: false, error })

/** 字段存在时校验类型；undefined/null 一律当「没给」 */
function optStr(o: Record<string, unknown>, key: string): string | undefined | Error {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  return typeof v === 'string' ? v : new Error(`${key} 得是字符串`)
}

function optNum(o: Record<string, unknown>, key: string): number | undefined | Error {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : new Error(`${key} 得是数字`)
}

export function applyIntent(model: Model, s: State, raw: unknown): IntentResult {
  if (typeof raw !== 'object' || raw === null) return fail('intent 得是一个 JSON 对象')
  const o = raw as Record<string, unknown>

  switch (o.op) {
    case 'addSlice': {
      const name = optStr(o, 'name')
      if (name instanceof Error) return fail(name.message)
      const lenMin = optNum(o, 'lenMin')
      if (lenMin instanceof Error) return fail(lenMin.message)
      if (name !== undefined && !name.trim()) return fail('name 不能是空的')
      if (s.slices.length >= 8) return fail(`已经有 ${s.slices.length} 片了，上限 8，加不了`)

      let next = model.reducer(s, { type: 'addSlice' })
      const id = next.slices[next.slices.length - 1].id
      if (name !== undefined) {
        next = model.reducer(next, { type: 'rename', id, name: name.trim().slice(0, 60) })
      }
      if (lenMin !== undefined) {
        // reducer 自己会把片长夹在 1–180
        next = model.reducer(next, { type: 'setLen', id, min: lenMin })
      }
      return { ok: true, next }
    }

    case 'updateSlice': {
      if (typeof o.id !== 'string') return fail('缺 id')
      if (!s.slices.some((sl) => sl.id === o.id)) return fail(`没有这一片：${o.id}`)
      const name = optStr(o, 'name')
      if (name instanceof Error) return fail(name.message)
      const lenMin = optNum(o, 'lenMin')
      if (lenMin instanceof Error) return fail(lenMin.message)
      if (name === undefined && lenMin === undefined) return fail('至少给 name 或 lenMin 一个字段')
      if (name !== undefined && !name.trim()) return fail('name 不能是空的')

      let next = s
      if (name !== undefined) {
        next = model.reducer(next, { type: 'rename', id: o.id, name: name.trim().slice(0, 60) })
      }
      if (lenMin !== undefined) {
        next = model.reducer(next, { type: 'setLen', id: o.id, min: lenMin })
      }
      return { ok: true, next }
    }

    case 'removeSlice': {
      if (typeof o.id !== 'string') return fail('缺 id')
      if (!s.slices.some((sl) => sl.id === o.id)) return fail(`没有这一片：${o.id}`)
      if (s.slices.length <= 3) return fail(`只剩 ${s.slices.length} 片了，下限 3，删不掉`)
      return { ok: true, next: model.reducer(s, { type: 'removeSlice', id: o.id }) }
    }

    case 'pause': {
      const reason = optStr(o, 'reason')
      if (reason instanceof Error) return fail(reason.message)
      if (s.phase !== 'running') return fail(`当前是 ${s.phase}，只有 running 才能暂停`)
      let next = model.reducer(s, { type: 'pause' })
      if (reason !== undefined && reason.trim()) {
        // reducer 自己会把原因截到 40 字
        next = model.reducer(next, { type: 'setPauseReason', reason })
      }
      return { ok: true, next }
    }

    case 'resume': {
      if (s.phase !== 'paused') return fail(`当前是 ${s.phase}，只有 paused 才能继续`)
      return { ok: true, next: model.reducer(s, { type: 'resume' }) }
    }

    default:
      return fail(
        typeof o.op === 'string' ? `不认识的操作：${o.op}` : 'intent 里没有 op 字段',
      )
  }
}
