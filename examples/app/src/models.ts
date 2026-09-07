import { computed, effect, event, model, store } from 'stm'
import type { Api, User } from './api'

declare module 'stm' {
  interface Deps {
    api: Api
  }
}

/** корневая модель: список карточек; владелец — App */
export const app = model((_, ctx) => {
  const add = event()
  const remove = event<string>()
  const ids = store(['1', '2'])
  ctx.on(add, () => ctx.set(ids, [...ctx.get(ids), String(Math.max(0, ...ctx.get(ids).map(Number)) + 1)]))
  ctx.on(remove, id => ctx.set(ids, ctx.get(ids).filter(x => x !== id)))
  return { add, remove, ids }
})

/** доменная модель: адрес user/id; владелец — карточка */
export const user = model((id: string, ctx) => {
  const load = effect((_: void, { deps, signal }) => deps.api.user(id, signal))
  const data = store<User | null>(null)
  const status = store('')
  const like = event()
  const likes = store(0)
  const title = computed([data, likes], (u, n) => `${u ? u.name : `#${id}`} · ${n} ❤`)

  ctx.on(load.started, () => ctx.set(status, ''))
  ctx.on(load.done, ({ result }) => ctx.set(data, result))
  ctx.on(load.failed, ({ error }) =>
    ctx.set(status, `Ошибка: ${error instanceof Error ? error.message : String(error)}`),
  )
  ctx.on(load.aborted, () => ctx.set(status, 'Отменено'))
  ctx.on(like, () => ctx.set(likes, ctx.get(likes) + 1))

  return { load, data, status, like, title }
})

/** локальная модель: приватное состояние карточки, адрес из useId, начальное значение из params */
export const details = model(({ open: initial }: { open: boolean }, ctx) => {
  const toggle = event()
  const open = store(initial)
  ctx.on(toggle, () => ctx.set(open, !ctx.get(open)))
  return { toggle, open }
})
