import { describe, expect, it, vi } from 'vitest'
import { computed, createScope, effect, event, model, store } from './core'

declare module './core' {
  interface Deps {
    api: { load(id: string, signal: AbortSignal): Promise<string> }
  }
}

const api = { load: async (id: string) => `user:${id}` }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

const globalReset = event()
const counter = model((id: string) => {
  const inc = event()
  const count = store(0)
    .on(inc, s => s + 1)
    .on(globalReset, () => 0)
  const load = effect((_: void, { deps, signal }) => deps.api.load(id, signal))
  const label = computed([count], c => `${id}:${c}`)
  return { inc, count, load, label }
})
const app = model(() => {
  const set = event<string>()
  const theme = store('light').on(set, (_, t) => t)
  return { set, theme, form: { name: store('') } }
})

describe('store + event', () => {
  const inc = event<number>()
  const reset = event()
  const count = store(0)
    .on(inc, (s, n) => s + n)
    .on(reset, () => 0)

  it('состояние живёт в scope, а не в сторе', () => {
    const a = createScope({ api })
    const b = createScope({ api })
    a.emit(inc, 2)
    a.emit(inc, 3)
    expect(a.get(count)).toBe(5)
    expect(b.get(count)).toBe(0)
    a.emit(reset)
    expect(a.get(count)).toBe(0)
  })

  it('подписки на стор и на событие', () => {
    const scope = createScope({ api })
    const onCount = vi.fn()
    const onInc = vi.fn()
    const off = scope.subscribe(count, onCount)
    scope.subscribe(inc, onInc)
    scope.emit(inc, 1)
    scope.set(count, 1) // без изменений — не уведомляем
    expect(onCount).toHaveBeenCalledTimes(1)
    expect(onCount).toHaveBeenCalledWith(1)
    expect(onInc).toHaveBeenCalledWith(1)
    off()
    scope.emit(inc, 1)
    expect(onCount).toHaveBeenCalledTimes(1)
  })
})

describe('computed', () => {
  const a = store(1)
  const b = store(2)
  const sum = computed([a, b], (x, y) => ({ value: x + y }))

  it('кэширует по значениям источников', () => {
    const scope = createScope({ api })
    const first = scope.get(sum)
    expect(first.value).toBe(3)
    expect(scope.get(sum)).toBe(first)
    scope.set(a, 10)
    expect(scope.get(sum).value).toBe(12)
  })

  it('уведомляет только при изменении результата', () => {
    const scope = createScope({ api })
    const even = computed([a], x => x % 2 === 0)
    const fn = vi.fn()
    scope.subscribe(even, fn)
    scope.set(a, 3) // нечётное → нечётное
    expect(fn).not.toHaveBeenCalled()
    scope.set(a, 4)
    expect(fn).toHaveBeenCalledWith(true)
  })
})

describe('effect', () => {
  it('pending, started/done, deps и scope в контексте', async () => {
    const load = effect(async (id: string, { deps, signal, scope }) => {
      expect(signal.aborted).toBe(false)
      scope.emit(log, 'inside')
      return deps.api.load(id, signal)
    })
    const log = event<string>()
    const user = store<string | null>(null).on(load.done, (_, { result }) => result)
    const scope = createScope({ api })
    const started = vi.fn()
    const logged = vi.fn()
    scope.subscribe(load.started, started)
    scope.subscribe(log, logged)

    const p = scope.run(load, '7')
    expect(scope.get(load.pending)).toBe(true)
    expect(started).toHaveBeenCalledWith('7')
    expect(logged).toHaveBeenCalledWith('inside')
    await expect(p).resolves.toBe('user:7')
    expect(scope.get(load.pending)).toBe(false)
    expect(scope.get(user)).toBe('user:7')
  })

  it('failed при ошибке, в том числе синхронной', async () => {
    const boom = effect<void, never>(() => {
      throw new Error('boom')
    })
    const error = store<unknown>(null).on(boom.failed, (_, { error }) => error)
    const scope = createScope({ api })
    await expect(scope.run(boom)).rejects.toThrow('boom')
    expect(scope.get(boom.pending)).toBe(false)
    expect(scope.get(error)).toBeInstanceOf(Error)
  })

  it('pending остаётся true, пока есть хоть один запуск', async () => {
    const wait = effect((ms: number) => tick(ms))
    const scope = createScope({ api })
    const p1 = scope.run(wait, 5)
    const p2 = scope.run(wait, 20)
    await p1
    expect(scope.get(wait.pending)).toBe(true)
    await p2
    expect(scope.get(wait.pending)).toBe(false)
  })

  it('отмена: reject с причиной, aborted вместо done/failed, pending сброшен', async () => {
    const load = effect(
      (_: void, { signal }) =>
        new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('late'), 50)
          signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)))
        }),
    )
    const scope = createScope({ api })
    const done = vi.fn()
    const failed = vi.fn()
    const aborted = vi.fn()
    scope.subscribe(load.done, done)
    scope.subscribe(load.failed, failed)
    scope.subscribe(load.aborted, aborted)

    const ctrl = new AbortController()
    const p = scope.run(load, undefined, ctrl.signal)
    const reason = new Error('cancelled')
    ctrl.abort(reason)
    await expect(p).rejects.toThrow('cancelled')
    expect(scope.get(load.pending)).toBe(false)
    expect(done).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    expect(aborted).toHaveBeenCalledWith({ params: undefined, reason })
  })

  it('отмена, если обработчик игнорирует сигнал: результат отбрасывается', async () => {
    const load = effect(async () => 'ignored')
    const scope = createScope({ api })
    const done = vi.fn()
    const aborted = vi.fn()
    scope.subscribe(load.done, done)
    scope.subscribe(load.aborted, aborted)
    const ctrl = new AbortController()
    const p = scope.run(load, undefined, ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toThrow(/abort/i)
    expect(done).not.toHaveBeenCalled()
    expect(aborted).toHaveBeenCalledTimes(1)
  })
})

describe('model', () => {
  it('адрес = ключ типа + доменный ключ; экземпляры изолированы', () => {
    const scope = createScope({ api })
    const a = scope.model(counter, 'counter', 'a')
    const b = scope.model(counter, 'counter', 'b')
    const other = scope.model(counter, 'other', 'a') // тот же доменный ключ под другим ключом типа
    expect(scope.model(counter, 'counter', 'a')).toBe(a)
    expect(other).not.toBe(a)
    scope.emit(a.inc)
    scope.emit(a.inc)
    scope.emit(b.inc)
    expect(scope.get(a.label)).toBe('a:2')
    expect(scope.get(b.label)).toBe('b:1')
    expect(scope.get(other.count)).toBe(0)
    scope.emit(globalReset)
    expect(scope.get(a.count)).toBe(0)
    expect(scope.get(b.count)).toBe(0)
  })

  it('из одного шаблона можно создать несколько корневых экземпляров', () => {
    const scope = createScope({ api })
    const left = scope.model(app, 'left')
    const right = scope.model(app, 'right')
    scope.emit(left.set, 'dark')
    expect(scope.get(left.theme)).toBe('dark')
    expect(scope.get(right.theme)).toBe('light')
    expect(scope.modelOf(left)).toBe(app)
  })

  it('другой шаблон по занятому адресу — ошибка', () => {
    const scope = createScope({ api })
    const other = model(() => ({ x: store(1) }))
    scope.model(app, 'root')
    expect(() => scope.model(other, 'root')).toThrow(/другого шаблона/)
  })

  it('claim: один владелец, release с задержкой, повторный claim отменяет удаление', async () => {
    const scope = createScope({ api }, { unmountDelay: 5 })
    const release = scope.claim(counter, 'counter', 'a')
    const a = scope.model(counter, 'counter', 'a')
    expect(() => scope.claim(counter, 'counter', 'a')).toThrow(/владелец/)
    scope.emit(a.inc)

    release()
    release() // повторный release ничего не ломает
    const release2 = scope.claim(counter, 'counter', 'a') // успели вернуться — экземпляр тот же
    await tick(10)
    expect(scope.model(counter, 'counter', 'a')).toBe(a)
    expect(scope.get(a.count)).toBe(1)

    release2()
    await tick(10)
    const fresh = scope.model(counter, 'counter', 'a')
    expect(fresh).not.toBe(a)
    expect(scope.get(fresh.count)).toBe(0)
  })

  it('dispose: отменяет эффекты, отвязывает редьюсеры от глобальных событий, не пишет в scope', async () => {
    const scope = createScope({ api })
    const a = scope.model(counter, 'counter', 'a')
    const b = scope.model(counter, 'counter', 'b')
    const p = scope.run(a.load)
    const aborts = store(0).on(a.load.aborted, n => n + 1) // глобальный стор слушает событие экземпляра
    expect(scope.get(a.load.pending)).toBe(true)

    scope.dispose('counter', 'a')
    await expect(p).rejects.toThrow(/abort/i)
    expect(scope.get(aborts)).toBe(0) // после удаления экземпляра его события не эмитятся
    expect(globalReset.targets.has(a.count)).toBe(false)
    expect(globalReset.targets.has(b.count)).toBe(true)
    expect(scope.get(a.load.pending)).toBe(false)
    // @ts-expect-error приватное поле, проверяем отсутствие утечки
    expect(scope.values.has(a.load.pending)).toBe(false)
    expect(scope.model(counter, 'counter', 'a')).not.toBe(a)
  })
})

describe('serialize / state', () => {
  it('serialize отдаёт изменённые сторы по адресам и путям; эффекты и computed не попадают', async () => {
    const scope = createScope({ api })
    const a = scope.model(counter, 'counter', 'a')
    const root = scope.model(app, 'root')
    scope.model(counter, 'counter', 'b') // без изменений — в JSON не попадает
    scope.emit(a.inc)
    await scope.run(a.load) // pending менялся, но это стор эффекта
    scope.emit(root.set, 'dark')
    scope.set(root.form.name, 'Ann')
    expect(scope.serialize()).toEqual({
      counter: { a: { count: 1 } },
      root: { '': { theme: 'dark', 'form.name': 'Ann' } },
    })
  })

  it('state применяется при создании экземпляра; незнакомые пути игнорируются', () => {
    const state = { counter: { a: { count: 5, ghost: 1 } }, root: { '': { theme: 'dark' } } }
    const scope = createScope({ api }, { state })
    const a = scope.model(counter, 'counter', 'a')
    expect(scope.get(a.count)).toBe(5)
    expect(scope.get(a.label)).toBe('a:5')
    expect(scope.get(scope.model(counter, 'counter', 'b').count)).toBe(0)
    expect(scope.get(scope.model(app, 'root').theme)).toBe('dark')
  })
})
