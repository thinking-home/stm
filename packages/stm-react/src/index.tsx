import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Effect, Event, Key, Model, Params, Readable, Scope } from 'stm'

const ScopeCtx = createContext<Scope | null>(null)

export const ScopeProvider = ScopeCtx.Provider

export function useScope(): Scope {
  const scope = useContext(ScopeCtx)
  if (!scope) throw new Error('stm: оберните дерево в <ScopeProvider value={scope}>')
  return scope
}

export function useStore<T>(store: Readable<T>): T {
  const scope = useScope()
  const subscribe = useCallback((cb: () => void) => scope.subscribe(store, cb), [scope, store])
  const get = () => scope.get(store)
  return useSyncExternalStore(subscribe, get, get)
}

export function useEvent<P>(event: Event<P>): (...args: Params<P>) => void {
  const scope = useScope()
  return useCallback((...args: Params<P>) => scope.emit(event, ...args), [scope, event])
}

type RunArgs<P> = [...Params<P>, signal?: AbortSignal]

export function useRun<P, R>(fx: Effect<P, R>): (...args: RunArgs<P>) => Promise<R> {
  const scope = useScope()
  return useCallback((...args: RunArgs<P>) => scope.run(fx, ...args), [scope, fx])
}

/** создаёт экземпляр по адресу «ключ типа + доменный ключ» и владеет им, пока компонент смонтирован */
export function useCreateModel<P, T extends object>(
  model: Model<P, T>,
  type: string,
  ...args: [...Params<P>, key?: Key]
): T {
  const scope = useScope()
  const inst = scope.model(model, type, ...args)
  // экземпляр меняется только вместе с адресом, поэтому params в зависимостях не нужны
  useEffect(() => scope.claim(model, type, ...args), [scope, model, type, inst])
  return inst
}

/** то же, но ключ типа берётся из useId: приватный экземпляр этого компонента */
export function useCreateLocalModel<P, T extends object>(model: Model<P, T>, ...params: Params<P>): T {
  return useCreateModel(model, useId(), ...params)
}

const ModelCtx = createContext<ReadonlyMap<Model<any, any>, object>>(new Map())

/** отдаёт экземпляр вниз по дереву; ничего не создаёт и не удерживает */
export function ModelProvider({ value, children }: { value: object; children?: ReactNode }) {
  const scope = useScope()
  const parent = useContext(ModelCtx)
  const model = scope.modelOf(value)
  if (!model) throw new Error('stm: в ModelProvider передан не экземпляр модели этого скоупа')
  const ctx = useMemo(() => new Map(parent).set(model, value), [parent, model, value])
  return <ModelCtx.Provider value={ctx}>{children}</ModelCtx.Provider>
}

/** экземпляр, который положил в ModelProvider кто-то выше по дереву */
export function useModel<T extends object>(model: Model<any, T>): T {
  const inst = useContext(ModelCtx).get(model)
  if (!inst) throw new Error('stm: нет <ModelProvider> с экземпляром этой модели')
  return inst as T
}
