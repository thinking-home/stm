/**
 * Зависимости, доступные эффектам через `ctx.deps`.
 * Расширяется через declaration merging:
 *   declare module 'stm' { interface Deps { api: Api } }
 */
export interface Deps {}

export type Reducer<T, P> = (state: T, payload: P) => T

export interface Event<P = void> {
  /** обратный индекс: сторы, у которых есть редьюсер на это событие */
  readonly targets: Set<Store<any>>
  readonly _?: P
}

export interface Store<T> {
  readonly initial: T
  readonly reducers: Map<Event<any>, Reducer<T, any>>
  on<P>(event: Event<P>, reducer: Reducer<T, P>): Store<T>
}

export interface Computed<T> {
  readonly stores: readonly Readable<any>[]
  readonly fn: (...values: any[]) => T
}

export type Readable<T> = Store<T> | Computed<T>

export interface EffectCtx {
  readonly deps: Deps
  readonly signal: AbortSignal
  readonly scope: Scope
}

export interface Effect<P = void, R = void> {
  readonly handler: (params: P, ctx: EffectCtx) => Promise<R>
  readonly started: Event<P>
  readonly done: Event<{ params: P; result: R }>
  readonly failed: Event<{ params: P; error: unknown }>
  readonly aborted: Event<{ params: P; reason: unknown }>
  readonly pending: Store<boolean>
}

/** шаблон модели: фабрика без имени и без состояния */
export interface Model<K = void, T extends object = object> {
  readonly create: (key: K) => T
}

/** для `void` аргумент можно не передавать: `scope.emit(reset)`, `scope.run(load)`, `scope.model(app, 'root')` */
export type Params<P> = P extends void ? [params?: P] : [params: P]

type Unit = Store<any> | Computed<any> | Event<any> | Effect<any, any>

// Пока выполняется фабрика модели, все созданные юниты собираются сюда,
// чтобы Scope знал, что чистить при удалении экземпляра.
let collecting: Set<Unit> | undefined
const track = <U extends Unit>(unit: U): U => (collecting?.add(unit), unit)

export const event = <P = void>(): Event<P> => track({ targets: new Set() })

export const store = <T>(initial: T): Store<T> =>
  track<Store<T>>({
    initial,
    reducers: new Map(),
    on(event, reducer) {
      this.reducers.set(event, reducer)
      event.targets.add(this)
      return this
    },
  })

type Values<S> = { [K in keyof S]: S[K] extends Readable<infer V> ? V : never }

export const computed = <S extends readonly Readable<any>[], T>(
  stores: [...S],
  fn: (...values: Values<S>) => T,
): Computed<T> => track({ stores, fn })

export const effect = <P = void, R = void>(handler: Effect<P, R>['handler']): Effect<P, R> =>
  track<Effect<P, R>>({
    handler,
    started: event(),
    done: event(),
    failed: event(),
    aborted: event(),
    pending: store(false),
  })

export const model = <K = void, T extends object = object>(create: (key: K) => T): Model<K, T> => ({ create })

/** состояние скоупа: ключ типа → доменный ключ ('' если его нет) → путь стора в экземпляре → значение */
export type ScopeState = Record<string, Record<string, Record<string, unknown>>>

export interface ScopeOptions {
  /** сколько ждать после release владельца перед удалением экземпляра */
  unmountDelay?: number
  /** результат `serialize()`; применяется к экземплярам в момент их создания */
  state?: ScopeState
}

interface Instance {
  model: Model<any, any>
  inst: object
  units: Set<Unit>
  owner?: object
  timer?: ReturnType<typeof setTimeout>
}

const addr = (type: string, key: unknown) => (key === undefined ? type : `${type}/${String(key)}`)
const keyOf = (key: unknown) => (key === undefined ? '' : String(key))

/** обходит объект экземпляра и вызывает fn для каждого стора с его путём вида `form.name` */
const walk = (obj: object, fn: (store: Store<any>, path: string) => void, prefix = ''): void => {
  for (const [name, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object') continue
    if ('reducers' in v) fn(v as Store<any>, prefix + name)
    else if (!('targets' in v || 'fn' in v || 'handler' in v) && Object.getPrototypeOf(v) === Object.prototype)
      walk(v, fn, prefix + name + '.')
  }
}

export class Scope {
  private values = new Map<Store<any>, unknown>()
  private cache = new Map<Computed<any>, [unknown[], unknown]>()
  private listeners = new Map<Unit, Set<(value: any) => void>>()
  private running = new Map<Effect<any, any>, Set<AbortController>>()
  private instances = new Map<string, Map<unknown, Instance>>()
  private owners = new WeakMap<object, Model<any, any>>()
  private state: ScopeState
  readonly unmountDelay: number

  constructor(
    readonly deps: Deps,
    { unmountDelay = 1000, state = {} }: ScopeOptions = {},
  ) {
    this.unmountDelay = unmountDelay
    this.state = state
  }

  get<T>(unit: Readable<T>): T {
    if (!('fn' in unit)) return this.values.has(unit) ? (this.values.get(unit) as T) : unit.initial
    const args = unit.stores.map(s => this.get(s))
    const hit = this.cache.get(unit)
    if (hit && hit[0].every((v, i) => Object.is(v, args[i]))) return hit[1] as T
    const value = unit.fn(...args)
    this.cache.set(unit, [args, value])
    return value
  }

  set<T>(store: Store<T>, value: T): void {
    if (Object.is(this.get(store), value)) return
    this.values.set(store, value)
    this.listeners.get(store)?.forEach(fn => fn(value))
  }

  emit<P>(event: Event<P>, ...[payload]: Params<P>): void {
    for (const s of event.targets) this.set(s, s.reducers.get(event)!(this.get(s), payload))
    this.listeners.get(event)?.forEach(fn => fn(payload))
  }

  subscribe<T>(unit: Readable<T> | Event<T>, fn: (value: T) => void): () => void {
    if ('fn' in unit) {
      let prev = this.get(unit)
      const check = () => {
        const next = this.get(unit)
        if (!Object.is(prev, next)) fn((prev = next))
      }
      const unsubs = unit.stores.map(s => this.subscribe(s, check))
      return () => unsubs.forEach(u => u())
    }
    let set = this.listeners.get(unit)
    if (!set) this.listeners.set(unit, (set = new Set()))
    set.add(fn)
    return () => void set.delete(fn)
  }

  run<P, R>(fx: Effect<P, R>, ...args: [...Params<P>, signal?: AbortSignal]): Promise<R> {
    const [params, signal] = args as unknown as [P, AbortSignal?]
    const ctrl = new AbortController()
    if (signal?.aborted) ctrl.abort(signal.reason)
    else signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })

    let running = this.running.get(fx)
    if (!running) this.running.set(fx, (running = new Set()))
    running.add(ctrl)
    this.set(fx.pending, true)
    this.emit(fx.started, ...([params] as Params<P>))

    // на один запуск срабатывает ровно одно из done / failed / aborted
    const finish = (ok: boolean, value: unknown): R => {
      running.delete(ctrl)
      const alive = this.running.get(fx) === running // экземпляр модели не удалён
      if (alive) this.set(fx.pending, running.size > 0)
      if (ctrl.signal.aborted) {
        if (alive) this.emit(fx.aborted, { params, reason: ctrl.signal.reason })
        throw ctrl.signal.reason
      }
      if (!ok) {
        this.emit(fx.failed, { params, error: value })
        throw value
      }
      this.emit(fx.done, { params, result: value as R })
      return value as R
    }
    return new Promise<R>(resolve =>
      resolve(fx.handler(params, { deps: this.deps, signal: ctrl.signal, scope: this })),
    ).then(
      result => finish(true, result),
      error => finish(false, error),
    )
  }

  /** экземпляр по адресу «ключ типа + доменный ключ»; создаётся при первом обращении */
  model<K, T extends object>(model: Model<K, T>, type: string, ...[key]: Params<K>): T {
    return this.instance(model, type, key).inst as T
  }

  /** стать владельцем экземпляра; второй владелец — ошибка. После release экземпляр удалится через unmountDelay */
  claim<K>(model: Model<K, any>, type: string, ...[key]: Params<K>): () => void {
    const e = this.instance(model, type, key)
    if (e.owner) throw new Error(`stm: у экземпляра ${addr(type, key)} уже есть владелец`)
    const owner = (e.owner = {})
    clearTimeout(e.timer)
    return () => {
      if (e.owner !== owner) return
      e.owner = undefined
      e.timer = setTimeout(() => this.dispose(type, key), this.unmountDelay)
    }
  }

  /** шаблон, из которого создан экземпляр */
  modelOf(inst: object): Model<any, any> | undefined {
    return this.owners.get(inst)
  }

  /** немедленно удаляет экземпляр: состояние, подписки, отменяет его запущенные эффекты */
  dispose(type: string, key?: unknown): void {
    const byKey = this.instances.get(type)
    const e = byKey?.get(key)
    if (!e) return
    byKey!.delete(key)
    clearTimeout(e.timer)
    for (const u of e.units) {
      this.listeners.delete(u)
      if ('reducers' in u) {
        this.values.delete(u)
        for (const ev of u.reducers.keys()) ev.targets.delete(u)
      } else if ('fn' in u) {
        this.cache.delete(u)
      } else if ('handler' in u) {
        const running = this.running.get(u)
        this.running.delete(u)
        running?.forEach(c => c.abort())
      }
    }
  }

  /** изменённые сторы всех экземпляров; эффекты, события и computed не попадают */
  serialize(): ScopeState {
    const out: ScopeState = {}
    for (const [type, byKey] of this.instances)
      for (const [key, e] of byKey) {
        const values: Record<string, unknown> = {}
        walk(e.inst, (s, path) => {
          if (this.values.has(s)) values[path] = this.values.get(s)
        })
        if (Object.keys(values).length) (out[type] ??= {})[keyOf(key)] = values
      }
    return out
  }

  private instance(model: Model<any, any>, type: string, key: unknown): Instance {
    let byKey = this.instances.get(type)
    if (!byKey) this.instances.set(type, (byKey = new Map()))
    const found = byKey.get(key)
    if (found) {
      if (found.model !== model) throw new Error(`stm: адрес ${addr(type, key)} занят экземпляром другого шаблона`)
      return found
    }
    const units = new Set<Unit>()
    const prev = collecting
    collecting = units
    let inst: object
    try {
      inst = model.create(key)
    } finally {
      collecting = prev
    }
    const saved = this.state[type]?.[keyOf(key)]
    if (saved) walk(inst, (s, path) => path in saved && this.set(s, saved[path]))
    const e: Instance = { model, inst, units }
    byKey.set(key, e)
    this.owners.set(inst, model)
    return e
  }
}

export const createScope = (deps: Deps, options?: ScopeOptions): Scope => new Scope(deps, options)
