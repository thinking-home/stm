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
  readonly pending: Store<boolean>
}

export interface Model<K, T> {
  readonly create: (key: K) => T
}

/** для `void` аргумент можно не передавать: `scope.emit(reset)`, `scope.run(load)` */
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
  track<Effect<P, R>>({ handler, started: event(), done: event(), failed: event(), pending: store(false) })

export const model = <K, T>(create: (key: K) => T): Model<K, T> => ({ create })

interface Instance {
  inst: unknown
  units: Set<Unit>
  refs: number
  timer?: ReturnType<typeof setTimeout>
}

export class Scope {
  private values = new Map<Store<any>, unknown>()
  private cache = new Map<Computed<any>, [unknown[], unknown]>()
  private listeners = new Map<Unit, Set<(value: any) => void>>()
  private running = new Map<Effect<any, any>, Set<AbortController>>()
  private instances = new Map<Model<any, any>, Map<unknown, Instance>>()

  constructor(
    readonly deps: Deps,
    /** сколько ждать после последнего release перед удалением экземпляра модели */
    readonly unmountDelay = 1000,
  ) {}

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

    const settle = () => {
      running.delete(ctrl)
      // если экземпляр модели уже удалён, его сторы не трогаем
      if (this.running.get(fx) === running) this.set(fx.pending, running.size > 0)
    }
    return new Promise<R>(resolve =>
      resolve(fx.handler(params, { deps: this.deps, signal: ctrl.signal, scope: this })),
    ).then(
      result => {
        settle()
        if (ctrl.signal.aborted) throw ctrl.signal.reason
        this.emit(fx.done, { params, result })
        return result
      },
      error => {
        settle()
        if (ctrl.signal.aborted) throw ctrl.signal.reason
        this.emit(fx.failed, { params, error })
        throw error
      },
    )
  }

  /** экземпляр модели по ключу; создаётся при первом обращении */
  model<K, T>(model: Model<K, T>, key: K): T {
    return this.instance(model, key).inst as T
  }

  /** удерживает экземпляр; возвращает release, после последнего release экземпляр удалится через unmountDelay */
  retain<K>(model: Model<K, any>, key: K): () => void {
    const e = this.instance(model, key)
    e.refs++
    clearTimeout(e.timer)
    return () => {
      if (--e.refs === 0) e.timer = setTimeout(() => this.dispose(model, key), this.unmountDelay)
    }
  }

  /** немедленно удаляет экземпляр: состояние, подписки, отменяет его запущенные эффекты */
  dispose<K>(model: Model<K, any>, key: K): void {
    const byKey = this.instances.get(model)
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

  private instance<K>(model: Model<K, any>, key: K): Instance {
    let byKey = this.instances.get(model)
    if (!byKey) this.instances.set(model, (byKey = new Map()))
    let e = byKey.get(key)
    if (!e) {
      const units = new Set<Unit>()
      const prev = collecting
      collecting = units
      try {
        byKey.set(key, (e = { inst: model.create(key), units, refs: 0 }))
      } finally {
        collecting = prev
      }
    }
    return e
  }
}

export const createScope = (deps: Deps, unmountDelay?: number): Scope => new Scope(deps, unmountDelay)
