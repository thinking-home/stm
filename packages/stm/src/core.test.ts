import { describe, expect, it, vi } from 'vitest'
import { computed, createScope, effect, event, model, store } from './core'

declare module './core' {
  interface Deps {
    api: { load(id: string, signal: AbortSignal): Promise<string> }
  }
}

const api = { load: async (id: string) => `user:${id}` }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

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

  it('отмена: reject с причиной, без done/failed, pending сброшен', async () => {
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
    scope.subscribe(load.done, done)
    scope.subscribe(load.failed, failed)

    const ctrl = new AbortController()
    const p = scope.run(load, undefined, ctrl.signal)
    ctrl.abort(new Error('cancelled'))
    await expect(p).rejects.toThrow('cancelled')
    expect(scope.get(load.pending)).toBe(false)
    expect(done).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  })

  it('отмена, если обработчик игнорирует сигнал: результат отбрасывается', async () => {
    const load = effect(async () => 'ignored')
    const scope = createScope({ api })
    const done = vi.fn()
    scope.subscribe(load.done, done)
    const ctrl = new AbortController()
    const p = scope.run(load, undefined, ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toThrow(/abort/i)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('model', () => {
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

  it('экземпляры по ключу изолированы, один и тот же ключ — один экземпляр', () => {
    const scope = createScope({ api })
    const a = scope.model(counter, 'a')
    const b = scope.model(counter, 'b')
    expect(scope.model(counter, 'a')).toBe(a)
    scope.emit(a.inc)
    scope.emit(a.inc)
    scope.emit(b.inc)
    expect(scope.get(a.label)).toBe('a:2')
    expect(scope.get(b.label)).toBe('b:1')
    scope.emit(globalReset)
    expect(scope.get(a.count)).toBe(0)
    expect(scope.get(b.count)).toBe(0)
  })

  it('retain/release: удаление после unmountDelay, retain отменяет удаление', async () => {
    const scope = createScope({ api }, 5)
    const release1 = scope.retain(counter, 'a')
    const release2 = scope.retain(counter, 'a')
    const a = scope.model(counter, 'a')
    scope.emit(a.inc)

    release1()
    await tick(10)
    expect(scope.model(counter, 'a')).toBe(a) // ещё удерживается

    release2()
    const release3 = scope.retain(counter, 'a') // успели вернуться — не удаляем
    await tick(10)
    expect(scope.model(counter, 'a')).toBe(a)
    expect(scope.get(a.count)).toBe(1)

    release3()
    await tick(10)
    const fresh = scope.model(counter, 'a')
    expect(fresh).not.toBe(a)
    expect(scope.get(fresh.count)).toBe(0)
  })

  it('dispose: отменяет эффекты, отвязывает редьюсеры от глобальных событий, не пишет в scope', async () => {
    const scope = createScope({ api })
    const a = scope.model(counter, 'a')
    const b = scope.model(counter, 'b')
    const p = scope.run(a.load)
    expect(scope.get(a.load.pending)).toBe(true)

    scope.dispose(counter, 'a')
    await expect(p).rejects.toThrow(/abort/i)
    expect(globalReset.targets.has(a.count)).toBe(false)
    expect(globalReset.targets.has(b.count)).toBe(true)
    expect(scope.get(a.load.pending)).toBe(false)
    // @ts-expect-error приватное поле, проверяем отсутствие утечки
    expect(scope.values.has(a.load.pending)).toBe(false)
    expect(scope.model(counter, 'a')).not.toBe(a)
  })
})
