import { computed, effect, event, model, store } from 'stm'
import type { Api, User } from './api'

declare module 'stm' {
  interface Deps {
    api: Api
  }
}

export const user = model((id: string) => {
  const load = effect((_: void, { deps, signal }) => deps.api.user(id, signal))
  const data = store<User | null>(null).on(load.done, (_, { result }) => result)
  const error = store<string | null>(null)
    .on(load.started, () => null)
    .on(load.failed, (_, { error }) => (error instanceof Error ? error.message : String(error)))
  const like = event()
  const likes = store(0).on(like, n => n + 1)
  const title = computed([data, likes], (u, n) => `${u ? u.name : `#${id}`} · ${n} ❤`)
  return { load, data, error, like, title }
})
