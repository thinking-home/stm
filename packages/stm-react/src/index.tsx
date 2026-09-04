import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Effect, Event, Model, Params, Readable, Scope } from 'stm'

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

const ModelCtx = createContext<ReadonlyMap<Model<any, any>, unknown>>(new Map())

export function ModelProvider<K, T>({ model, id, children }: { model: Model<K, T>; id: K; children?: ReactNode }) {
  const scope = useScope()
  const parent = useContext(ModelCtx)
  const inst = scope.model(model, id)
  const value = useMemo(() => new Map(parent).set(model, inst), [parent, model, inst])
  useEffect(() => scope.retain(model, id), [scope, model, id])
  return <ModelCtx.Provider value={value}>{children}</ModelCtx.Provider>
}

export function useModel<T>(model: Model<any, T>): T {
  const inst = useContext(ModelCtx).get(model)
  if (inst === undefined) throw new Error('stm: нет <ModelProvider> для этой модели')
  return inst as T
}
