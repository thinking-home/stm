# stm

Минималистичный state manager для React в духе nanostores. Монорепозиторий на pnpm workspaces.

```
packages/stm          ядро: store, event, computed, effect, model, Scope
packages/stm-react    хуки и провайдеры, зависит от stm через workspace:*
examples/app          Vite + React, чтобы проверять руками
```

- `store`, `event`, `computed`, `effect` — описания без состояния. Всё состояние живёт в `Scope`.
- `model` — шаблон набора юнитов. Сторы, эффекты и computed объявляются только внутри его фабрики, связи между ними описываются через контекст `ctx.on`.
- `effect` — async-функция с событиями `started` / `done` / `failed` / `aborted`, стором `pending`, `AbortSignal` и доступом к `deps` скоупа.
- Экземпляр модели адресуется ключом типа и доменным ключом, живёт, пока у него есть владелец, и умеет сериализоваться.

## Ядро

```ts
import { createScope, store, event, computed, effect, model } from 'stm'

// зависимости, доступные эффектам
declare module 'stm' {
  interface Deps { api: { user(id: string, signal: AbortSignal): Promise<User> } }
}

const user = model((id: string, ctx) => {
  const inc = event<number>()
  const reset = event()
  const count = store(0)
  const doubled = computed([count], c => c * 2)
  const load = effect(async (_: void, { deps, signal }) => deps.api.user(id, signal))
  const data = store<User | null>(null)

  ctx.on(inc, n => ctx.set(count, ctx.get(count) + n))
  ctx.on(reset, () => ctx.set(count, 0))
  ctx.on(load.done, ({ result }) => ctx.set(data, result))

  return { inc, reset, count, doubled, load, data }
})

const scope = createScope({ api })
const u = scope.model(user, 'user', '7')   // экземпляр по адресу user/7
scope.emit(u.inc, 2)
scope.get(u.doubled)                        // 4
scope.subscribe(u.count, v => console.log(v))
await scope.run(u.load)                     // ctrl.signal вторым аргументом — отмена
scope.get(u.load.pending)                   // false
```

Отменённый запуск отклоняется причиной отмены и эмитит `aborted` с `{ params, reason }` вместо `done` или `failed`. События срабатывают в момент завершения обработчика, `pending` обновляется прямо перед ними.

Слушатели `ctx.on` вызываются в порядке регистрации, вложенный `emit` выполняется синхронно. Поэтому в фабрике сначала описывают обновления состояния, потом реакции на него.

## Модели по ключу

Подробнее про модели, экземпляры, их жизненный цикл и связи между ними: [docs/MODEL.md](docs/MODEL.md).

```ts
scope.model(user, 'user', '1')                   // получить или создать; строковые params становятся ключом
scope.model(page, 'page', { id, router }, id)    // params-объект: ключ явно
const release = scope.claim(user, 'user', '1')   // стать владельцем; второй владелец → ошибка
release()                                        // удалится через unmountDelay
scope.dispose('user', '1')                       // удалить сразу

const state = scope.serialize()                  // { user: { '1': { count: 2 } } }
createScope(deps, { state })                     // гидрация: значения применяются при создании экземпляров
```

## React

```tsx
import { ScopeProvider, ModelProvider, useCreateModel, useCreateLocalModel, useModel, useStore, useEvent, useRun } from 'stm-react'

function UserPage({ id }: { id: string }) {
  const m = useCreateModel(user, 'user', id)     // владелец: создаёт экземпляр и держит, пока смонтирован
  return <ModelProvider value={m}><Counter /></ModelProvider>
}

function Counter() {
  const { inc, count, load } = useModel(user)    // потребитель: экземпляр из провайдера выше
  const value = useStore(count)
  const pending = useStore(load.pending)
  const onInc = useEvent(inc)
  const run = useRun(load)
  return <button disabled={pending} onClick={() => { onInc(1); run() }}>{value}</button>
}

const ui = useCreateLocalModel(details, { open: false })  // приватный экземпляр компонента, ключ типа из useId

<ScopeProvider value={scope}>
  <UserPage id="1" />
</ScopeProvider>
```

Экземпляр создаёт ровно один компонент. После его размонтирования экземпляр удаляется через `unmountDelay` (по умолчанию 1 с, как в nanostores), так что StrictMode и быстрые перемонтирования не пересоздают модель.

```sh
pnpm install
pnpm test        # vitest по всем пакетам
pnpm typecheck   # tsc -b по графу project references
pnpm dev         # examples/app на http://localhost:5173
```

Внутренние пакеты не собираются: `exports` указывают на `.ts` исходники, Vite и vitest читают их напрямую. Перед публикацией в npm понадобится сборка (например, tsdown) и замена `exports` на `dist`.
