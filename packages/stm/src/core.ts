/**
 * Зависимости, доступные эффектам через `ctx.deps`.
 * Расширяется через declaration merging:
 *   declare module 'stm' { interface Deps { api: Api } }
 */
export interface Deps {}

export interface Event<P = void> {
  readonly _?: P
}

export interface Store<T> {
  readonly initial: T
}

export interface Computed<T> {
  readonly stores: readonly Readable<any>[]
  readonly fn: (...values: any[]) => T
}

export type Readable<T> = Store<T> | Computed<T>

/** для `void` аргумент можно не передавать: `emit(reset)`, `run(load)`, `scope.model(app, 'root')` */
export type Params<P> = P extends void ? [params?: P] : [params: P]

/** доменный ключ в адресе экземпляра */
export type Key = string | number

type RunArgs<P> = [...Params<P>, signal?: AbortSignal]

/** методы, общие для контекста модели и контекста эффекта */
export interface Ctx {
  readonly scope: Scope
  get<T>(unit: Readable<T>): T
  set<T>(store: Store<T>, value: T): void
  emit<P>(event: Event<P>, ...args: Params<P>): void
  run<P, R>(fx: Effect<P, R>, ...args: RunArgs<P>): Promise<R>
}

export interface EffectCtx extends Ctx {
  readonly deps: Deps
  readonly signal: AbortSignal
}

export interface ModelCtx extends Ctx {
  /** подписка на событие или стор; снимается при удалении экземпляра. Слушатели вызываются в порядке регистрации */
  on<T>(unit: Readable<T> | Event<T>, fn: (value: T) => void): () => void
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
export interface Model<P = void, T extends object = object> {
  readonly create: (params: P, ctx: ModelCtx) => T
}

/** тип экземпляра модели */
export type InstanceOf<M> = M extends Model<any, infer T> ? T : never

type Unit = Store<any> | Computed<any> | Event<any> | Effect<any, any>

// Пока выполняется фабрика модели, все созданные юниты собираются сюда,
// чтобы Scope знал, что чистить при удалении экземпляра.
let collecting: Set<Unit> | undefined

const inFactory = (name: string): void => {
  if (!collecting) throw new Error(`stm: ${name}() можно вызывать только внутри фабрики модели`)
}
const track = <U extends Unit>(unit: U): U => (collecting?.add(unit), unit)

/** событие можно объявить и вне модели: как общую шину для широковещательных сигналов */
export const event = <P = void>(): Event<P> => track({})

export const store = <T>(initial: T): Store<T> => (inFactory('store'), track({ initial }))

type Values<S> = { [K in keyof S]: S[K] extends Readable<infer V> ? V : never }

export const computed = <S extends readonly Readable<any>[], T>(
  stores: [...S],
  fn: (...values: Values<S>) => T,
): Computed<T> => (inFactory('computed'), track({ stores, fn }))

export const effect = <P = void, R = void>(handler: Effect<P, R>['handler']): Effect<P, R> => {
  inFactory('effect')
  return track<Effect<P, R>>({
    handler,
    started: event(),
    done: event(),
    failed: event(),
    aborted: event(),
    pending: store(false),
  })
}

export const model = <P = void, T extends object = object>(create: (params: P, ctx: ModelCtx) => T): Model<P, T> => ({
  create,
})

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
  unsubs: Array<() => void>
  owner?: object
  timer?: ReturnType<typeof setTimeout>
}

/** ключ адреса: явный, иначе примитивные params */
const addressKey = (params: unknown, key?: Key): Key | undefined =>
  key ?? (typeof params === 'string' || typeof params === 'number' ? params : undefined)
const addr = (type: string, key: Key | undefined) => (key === undefined ? type : `${type}/${key}`)
const keyOf = (key: Key | undefined) => (key === undefined ? '' : String(key))

/** обходит объект экземпляра и вызывает fn для каждого стора с его путём вида `form.name` */
const walk = (
  obj: object,
  fn: (store: Store<any>, path: string) => void,
  skip: (v: object) => boolean,
  prefix = '',
): void => {
  for (const [name, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object' || skip(v)) continue
    if ('initial' in v) fn(v as Store<any>, prefix + name)
    else if (!('fn' in v || 'handler' in v) && Object.getPrototypeOf(v) === Object.prototype)
      walk(v, fn, skip, prefix + name + '.')
  }
}

export class Scope {
  private values = new Map<Store<any>, unknown>()
  private cache = new Map<Computed<any>, [unknown[], unknown]>()
  private listeners = new Map<Unit, Set<(value: any) => void>>()
  private running = new Map<Effect<any, any>, Set<AbortController>>()
  private instances = new Map<string, Map<Key | undefined, Instance>>()
  private owners = new WeakMap<object, Model<any, any>>()
  private state: ScopeState
  private api: Ctx
  readonly unmountDelay: number

  constructor(
    readonly deps: Deps,
    { unmountDelay = 1000, state = {} }: ScopeOptions = {},
  ) {
    this.unmountDelay = unmountDelay
    this.state = state
    this.api = {
      scope: this,
      get: this.get.bind(this),
      set: this.set.bind(this),
      emit: this.emit.bind(this),
      run: this.run.bind(this),
    }
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

  run<P, R>(fx: Effect<P, R>, ...args: RunArgs<P>): Promise<R> {
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
      resolve(fx.handler(params, { ...this.api, deps: this.deps, signal: ctrl.signal })),
    ).then(
      result => finish(true, result),
      error => finish(false, error),
    )
  }

  /** экземпляр по адресу «ключ типа + доменный ключ»; создаётся при первом обращении, params действуют только при создании */
  model<P, T extends object>(model: Model<P, T>, type: string, ...args: [...Params<P>, key?: Key]): T {
    const [params, key] = args as unknown as [P, Key?]
    return this.instance(model, type, params, addressKey(params, key)).inst as T
  }

  /** стать владельцем экземпляра; второй владелец — ошибка. После release экземпляр удалится через unmountDelay */
  claim<P>(model: Model<P, any>, type: string, ...args: [...Params<P>, key?: Key]): () => void {
    const [params, rawKey] = args as unknown as [P, Key?]
    const key = addressKey(params, rawKey)
    const e = this.instance(model, type, params, key)
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
  dispose(type: string, key?: Key): void {
    const byKey = this.instances.get(type)
    const e = byKey?.get(key)
    if (!e) return
    byKey!.delete(key)
    clearTimeout(e.timer)
    e.unsubs.forEach(off => off())
    for (const u of e.units) {
      this.listeners.delete(u)
      if ('initial' in u) this.values.delete(u)
      else if ('fn' in u) this.cache.delete(u)
      else if ('handler' in u) {
        const running = this.running.get(u)
        this.running.delete(u)
        running?.forEach(c => c.abort())
      }
    }
  }

  /** изменённые сторы всех экземпляров; эффекты, события, computed и вложенные экземпляры не попадают */
  serialize(): ScopeState {
    const out: ScopeState = {}
    for (const [type, byKey] of this.instances)
      for (const [key, e] of byKey) {
        const values: Record<string, unknown> = {}
        walk(
          e.inst,
          (s, path) => {
            if (this.values.has(s)) values[path] = this.values.get(s)
          },
          v => this.owners.has(v),
        )
        if (Object.keys(values).length) (out[type] ??= {})[keyOf(key)] = values
      }
    return out
  }

  private instance(model: Model<any, any>, type: string, params: unknown, key: Key | undefined): Instance {
    let byKey = this.instances.get(type)
    if (!byKey) this.instances.set(type, (byKey = new Map()))
    const found = byKey.get(key)
    if (found) {
      if (found.model !== model) throw new Error(`stm: адрес ${addr(type, key)} занят экземпляром другого шаблона`)
      return found
    }
    const units = new Set<Unit>()
    const unsubs: Array<() => void> = []
    const ctx: ModelCtx = {
      ...this.api,
      on: (unit, fn) => {
        const off = this.subscribe(unit, fn)
        unsubs.push(off)
        return off
      },
    }
    const prev = collecting
    collecting = units
    let inst: object
    try {
      inst = model.create(params, ctx)
    } finally {
      collecting = prev
    }
    // сохранённое состояние применяется без уведомления слушателей: это инициализация, а не изменение
    const saved = this.state[type]?.[keyOf(key)]
    if (saved)
      walk(
        inst,
        (s, path) => {
          if (path in saved) this.values.set(s, saved[path])
        },
        v => this.owners.has(v),
      )
    const e: Instance = { model, inst, units, unsubs }
    byKey.set(key, e)
    this.owners.set(inst, model)
    return e
  }
}

export const createScope = (deps: Deps, options?: ScopeOptions): Scope => new Scope(deps, options)
