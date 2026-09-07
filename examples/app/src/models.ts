import { computed, effect, event, model, store } from 'stm'
import type { Api, User } from './api'

declare module 'stm' {
  interface Deps {
    api: Api
  }
}

/** корневая модель: список карточек; владелец — App */
export const app = model(() => {
  const add = event()
  const remove = event<string>()
  const ids = store(['1', '2'])
    .on(add, ids => [...ids, String(Math.max(0, ...ids.map(Number)) + 1)])
    .on(remove, (ids, id) => ids.filter(x => x !== id))
  return { add, remove, ids }
})

/** доменная модель: адрес user/id; владелец — карточка */
export const user = model((id: string) => {
  const load = effect((_: void, { deps, signal }) => deps.api.user(id, signal))
  const data = store<User | null>(null).on(load.done, (_, { result }) => result)
  const status = store('')
    .on(load.started, () => '')
    .on(load.failed, (_, { error }) => `Ошибка: ${error instanceof Error ? error.message : String(error)}`)
    .on(load.aborted, () => 'Отменено')
  const like = event()
  const likes = store(0).on(like, n => n + 1)
  const title = computed([data, likes], (u, n) => `${u ? u.name : `#${id}`} · ${n} ❤`)
  return { load, data, status, like, title }
})

/** локальная модель: приватное состояние карточки, ключ типа из useId */
export const details = model(() => {
  const toggle = event()
  const open = store(false).on(toggle, v => !v)
  return { toggle, open }
})
