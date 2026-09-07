import { describe, expect, it, vi } from 'vitest'
import { computed, createScope, effect, event, model, store, type InstanceOf } from './core'

declare module './core' {
  interface Deps {
    api: { load(id: string, signal: AbortSignal): Promise<string> }
  }
}

const api = { load: async (id: string) => `user:${id}` }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

const reset = event() // статическое событие: общая шина

const counter = model((id: string, ctx) => {
  const inc = event<number>()
  const count = store(0)
  const label = computed([count], c => `${id}:${c}`)
  const load = effect((_: void, { deps, signal }) => deps.api.load(id, signal))
  const user = store<string | null>(null)
  ctx.on(inc, n => ctx.set(count, ctx.get(count) + n))
  ctx.on(reset, () => ctx.set(count, 0))
  ctx.on(load.done, ({ result }) => ctx.set(user, result))
  return { inc, count, label, load, user }
})

const app = model((_, ctx) => {
  const set = event<string>()
  const theme = store('light')
  ctx.on(set, t => ctx.set(theme, t))
  return { set, theme, form: { name: store('') } }
})

describe('юниты', () => {
  it('store, effect и computed только внутри фабрики; event можно снаружи', () => {
    expect(() => store(0)).toThrow(/внутри фабрики/)
    expect(() => effect(async () => {})).toThrow(/внутри фабрики/)
    expect(() => computed([], () => 1)).toThrow(/внутри фабрики/)
    expect(event()).toBeTypeOf('object')
  })

  it('состояние живёт в scope: у каждого скоупа свой экземпляр', () => {
    const s1 = createScope({ api })
    const s2 = createScope({ api })
    const a = s1.model(counter, 'counter', 'x')
    const b = s2.model(counter, 'counter', 'x')
    s1.emit(a.inc, 2)
    s1.emit(a.inc, 3)
    expect(s1.get(a.count)).toBe(5)
    expect(s2.get(b.count)).toBe(0)
    s1.emit(reset)
    expect(s1.get(a.count)).toBe(0)
  })

  it('слушатели вызываются в порядке регистрации, вложенный emit синхронный', () => {
    const log: string[] = []
    const chain = model((_, ctx) => {
      const first = event()
      const second = event()
      ctx.on(first, () => (log.push('a'), ctx.emit(second)))
      ctx.on(second, () => log.push('b'))
      ctx.on(first, () => log.push('c'))
      return { first }
    })
    const scope = createScope({ api })
    scope.emit(scope.model(chain, 'chain').first)
    expect(log).toEqual(['a', 'b', 'c'])
  })

  it('подписка на стор: только при изменении, отписка работает', () => {
    const scope = createScope({ api })
    const a = scope.model(counter, 'counter', 'x')
    const fn = vi.fn()
    const off = scope.subscribe(a.count, fn)
    scope.emit(a.inc, 1)
    scope.set(a.count, 1) // без изменений — не уведомляем
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(1)
    off()
    scope.emit(a.inc, 1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('computed', () => {
  const calc = model(() => {
    const a = store(1)
    const b = store(2)
    return { a, b, sum: computed([a, b], (x, y) => ({ value: x + y })), even: computed([a], x => x % 2 === 0) }
  })

  it('кэширует по значениям источников', () => {
    const scope = createScope({ api })
    const c = scope.model(calc, 'calc')
    const first = scope.get(c.sum)
    expect(first.value).toBe(3)
    expect(scope.get(c.sum)).toBe(first)
    scope.set(c.a, 10)
    expect(scope.get(c.sum).value).toBe(12)
  })

  it('уведомляет только при изменении результата', () => {
    const scope = createScope({ api })
    const c = scope.model(calc, 'calc')
    const fn = vi.fn()
    scope.subscribe(c.even, fn)
    scope.set(c.a, 3) // нечётное → нечётное
    expect(fn).not.toHaveBeenCalled()
    scope.set(c.a, 4)
    expect(fn).toHaveBeenCalledWith(true)
  })
})

describe('effect', () => {
  const loader = model((id: string, ctx) => {
    const log = event<string>()
    const load = effect(async (_: void, { deps, signal, emit }) => {
      expect(signal.aborted).toBe(false)
      emit(log, 'inside')
      return deps.api.load(id, signal)
    })
    const user = store<string | null>(null)
    const error = store<unknown>(null)
    const boom = effect<void, never>(() => {
      throw new Error('boom')
    })
    const wait = effect((ms: number) => tick(ms))
    const slow = effect(
      (_: void, { signal }) =>
        new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('late'), 50)
          signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)))
        }),
    )
    const ignoring = effect(async () => 'ignored')
    ctx.on(load.done, ({ result }) => ctx.set(user, result))
    ctx.on(boom.failed, ({ error: e }) => ctx.set(error, e))
    return { log, load, user, error, boom, wait, slow, ignoring }
  })

  it('pending, started/done, deps и методы контекста', async () => {
    const scope = createScope({ api })
    const l = scope.model(loader, 'loader', '7')
    const started = vi.fn()
    const logged = vi.fn()
    scope.subscribe(l.load.started, started)
    scope.subscribe(l.log, logged)

    const p = scope.run(l.load)
    expect(scope.get(l.load.pending)).toBe(true)
    expect(started).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledWith('inside')
    await expect(p).resolves.toBe('user:7')
    expect(scope.get(l.load.pending)).toBe(false)
    expect(scope.get(l.user)).toBe('user:7')
  })

  it('failed при ошибке, в том числе синхронной', async () => {
    const scope = createScope({ api })
    const l = scope.model(loader, 'loader', '7')
    await expect(scope.run(l.boom)).rejects.toThrow('boom')
    expect(scope.get(l.boom.pending)).toBe(false)
    expect(scope.get(l.error)).toBeInstanceOf(Error)
  })

  it('pending остаётся true, пока есть хоть один запуск', async () => {
    const scope = createScope({ api })
    const l = scope.model(loader, 'loader', '7')
    const p1 = scope.run(l.wait, 5)
    const p2 = scope.run(l.wait, 20)
    await p1
    expect(scope.get(l.wait.pending)).toBe(true)
    await p2
    expect(scope.get(l.wait.pending)).toBe(false)
  })

  it('отмена: reject с причиной, aborted вместо done/failed, pending сброшен', async () => {
    const scope = createScope({ api })
    const l = scope.model(loader, 'loader', '7')
    const done = vi.fn()
    const failed = vi.fn()
    const aborted = vi.fn()
    scope.subscribe(l.slow.done, done)
    scope.subscribe(l.slow.failed, failed)
    scope.subscribe(l.slow.aborted, aborted)

    const ctrl = new AbortController()
    const p = scope.run(l.slow, undefined, ctrl.signal)
    const reason = new Error('cancelled')
    ctrl.abort(reason)
    await expect(p).rejects.toThrow('cancelled')
    expect(scope.get(l.slow.pending)).toBe(false)
    expect(done).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    expect(aborted).toHaveBeenCalledWith({ params: undefined, reason })
  })

  it('отмена, если обработчик игнорирует сигнал: результат отбрасывается', async () => {
    const scope = createScope({ api })
    const l = scope.model(loader, 'loader', '7')
    const done = vi.fn()
    const aborted = vi.fn()
    scope.subscribe(l.ignoring.done, done)
    scope.subscribe(l.ignoring.aborted, aborted)
    const ctrl = new AbortController()
    const p = scope.run(l.ignoring, undefined, ctrl.signal)
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
    scope.emit(a.inc, 1)
    scope.emit(a.inc, 1)
    scope.emit(b.inc, 1)
    expect(scope.get(a.label)).toBe('a:2')
    expect(scope.get(b.label)).toBe('b:1')
    expect(scope.get(other.count)).toBe(0)
    scope.emit(reset)
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

  it('params: объект с явным ключом, действует только при создании', () => {
    const form = model(({ initial }: { initial: string }) => ({ name: store(initial) }))
    const scope = createScope({ api })
    const f = scope.model(form, 'form', { initial: 'Ann' }, '1')
    expect(scope.get(f.name)).toBe('Ann')
    expect(scope.model(form, 'form', { initial: 'Bob' }, '1')).toBe(f) // тот же адрес — тот же экземпляр
    expect(scope.get(f.name)).toBe('Ann')
    expect(scope.model(form, 'form', { initial: 'Bob' })).not.toBe(f) // без ключа — другой адрес
  })

  it('claim: один владелец, release с задержкой, повторный claim отменяет удаление', async () => {
    const scope = createScope({ api }, { unmountDelay: 5 })
    const release = scope.claim(counter, 'counter', 'a')
    const a = scope.model(counter, 'counter', 'a')
    expect(() => scope.claim(counter, 'counter', 'a')).toThrow(/владелец/)
    scope.emit(a.inc, 1)

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

  it('dispose: отменяет эффекты, снимает подписки экземпляра, не пишет в scope', async () => {
    const scope = createScope({ api })
    const a = scope.model(counter, 'counter', 'a')
    const b = scope.model(counter, 'counter', 'b')
    const p = scope.run(a.load)
    const aborted = vi.fn()
    scope.subscribe(a.load.aborted, aborted)
    expect(scope.get(a.load.pending)).toBe(true)

    scope.dispose('counter', 'a')
    await expect(p).rejects.toThrow(/abort/i)
    expect(aborted).not.toHaveBeenCalled() // после удаления экземпляра его события не эмитятся
    scope.emit(reset) // слушатель удалённого экземпляра снят: значение в scope не появляется
    // @ts-expect-error приватное поле, проверяем отсутствие утечки
    expect(scope.values.has(a.count)).toBe(false)
    // @ts-expect-error приватное поле
    expect(scope.values.has(a.load.pending)).toBe(false)
    expect(scope.get(b.count)).toBe(0)
    expect(scope.model(counter, 'counter', 'a')).not.toBe(a)
  })
})

describe('общение моделей', () => {
  const router = model((_, ctx) => {
    const navigate = event<{ route: string; id: string }>()
    const current = store({ route: 'home', id: '' })
    ctx.on(navigate, r => ctx.set(current, r))
    return { navigate, current }
  })

  const page = model(({ id, router: r }: { id: string; router: InstanceOf<typeof router> }, ctx) => {
    const load = effect((id: string, { deps, signal }) => deps.api.load(id, signal))
    const data = store<string | null>(null)
    ctx.on(r.navigate, ({ route, id: target }) => {
      if (route === 'page' && target === id) ctx.run(load, id)
    })
    ctx.on(load.done, ({ result }) => ctx.set(data, result))
    return { load, data, router: r }
  })

  it('экземпляр роутера передаётся странице через params; страница реагирует на его события', async () => {
    const scope = createScope({ api })
    const r = scope.model(router, 'router')
    const p = scope.model(page, 'page', { id: '1', router: r }, '1')

    scope.emit(r.navigate, { route: 'page', id: '2' })
    expect(scope.get(p.load.pending)).toBe(false) // чужой маршрут
    scope.emit(r.navigate, { route: 'page', id: '1' })
    expect(scope.get(p.load.pending)).toBe(true) // роутер обновил current раньше, чем страница отреагировала
    expect(scope.get(r.current)).toEqual({ route: 'page', id: '1' })
    await tick()
    expect(scope.get(p.data)).toBe('user:1')

    scope.dispose('page', '1')
    scope.emit(r.navigate, { route: 'page', id: '1' }) // подписки страницы сняты
    expect(scope.get(p.load.pending)).toBe(false)
  })

  it('вложенный экземпляр не сериализуется под адресом родителя', () => {
    const scope = createScope({ api })
    const r = scope.model(router, 'router')
    scope.model(page, 'page', { id: '1', router: r }, '1')
    scope.emit(r.navigate, { route: 'home', id: '' })
    expect(scope.serialize()).toEqual({ router: { '': { current: { route: 'home', id: '' } } } })
  })
})

describe('serialize / state', () => {
  it('serialize отдаёт изменённые сторы по адресам и путям; эффекты и computed не попадают', async () => {
    const scope = createScope({ api })
    const a = scope.model(counter, 'counter', 'a')
    const root = scope.model(app, 'root')
    scope.model(counter, 'counter', 'b') // без изменений — в JSON не попадает
    scope.emit(a.inc, 1)
    await scope.run(a.load) // pending менялся, но это стор эффекта; user изменился
    scope.emit(root.set, 'dark')
    scope.set(root.form.name, 'Ann')
    expect(scope.serialize()).toEqual({
      counter: { a: { count: 1, user: 'user:a' } },
      root: { '': { theme: 'dark', 'form.name': 'Ann' } },
    })
  })

  it('state применяется при создании без уведомления слушателей; незнакомые пути игнорируются', () => {
    const watched = vi.fn()
    const form = model((_, ctx) => {
      const name = store('')
      ctx.on(name, watched)
      return { name }
    })
    const state = { counter: { a: { count: 5, ghost: 1 } }, form: { '': { name: 'Ann' } } }
    const scope = createScope({ api }, { state })
    const a = scope.model(counter, 'counter', 'a')
    expect(scope.get(a.count)).toBe(5)
    expect(scope.get(a.label)).toBe('a:5')
    expect(scope.get(scope.model(counter, 'counter', 'b').count)).toBe(0)
    const f = scope.model(form, 'form')
    expect(scope.get(f.name)).toBe('Ann')
    expect(watched).not.toHaveBeenCalled()
    scope.set(f.name, 'Bob')
    expect(watched).toHaveBeenCalledWith('Bob')
  })
})
