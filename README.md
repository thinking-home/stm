# stm

Минималистичный state manager для React в духе nanostores. Монорепозиторий на pnpm workspaces.

```
packages/stm          ядро: store, event, computed, effect, model, Scope
packages/stm-react    хуки и провайдеры, зависит от stm через workspace:*
examples/app          Vite + React, чтобы проверять руками
```

- `store`, `event`, `computed`, `effect`, `model` — описания без состояния. Всё состояние живёт в `Scope`.
- `effect` — async-функция с событиями `started` / `done` / `failed` / `aborted`, стором `pending`, `AbortSignal` и доступом к `deps` скоупа.
- `model` — шаблон набора юнитов. Экземпляр адресуется ключом типа и доменным ключом, живёт, пока у него есть владелец, и умеет сериализоваться.

## Ядро

```ts
import { createScope, store, event, computed, effect, model } from 'stm'

// зависимости, доступные эффектам
declare module 'stm' {
  interface Deps { api: { user(id: string, signal: AbortSignal): Promise<User> } }
}

const inc = event<number>()
const reset = event()
const count = store(0)
  .on(inc, (s, n) => s + n)
  .on(reset, () => 0)
const doubled = computed([count], c => c * 2)

const load = effect(async (id: string, { deps, signal, scope }) => deps.api.user(id, signal))
const user = store<User | null>(null).on(load.done, (_, { result }) => result)

const scope = createScope({ api })
scope.emit(inc, 2)
scope.get(doubled)          // 4
scope.subscribe(count, v => console.log(v))
await scope.run(load, '7')  // ctrl.signal третьим аргументом — отмена
scope.get(load.pending)     // false
```

Отменённый запуск отклоняется причиной отмены и эмитит `aborted` с `{ params, reason }` вместо `done` или `failed`. События срабатывают в момент завершения обработчика, `pending` обновляется прямо перед ними.

## Модели по ключу

Подробнее про модели, экземпляры и их жизненный цикл: [docs/MODEL.md](docs/MODEL.md).

```ts
const todo = model((id: string) => {
  const toggle = event()
  const done = store(false).on(toggle, d => !d)
  const save = effect((_: void, { deps, signal, scope }) => deps.api.save(id, scope.get(done), signal))
  return { toggle, done, save }
})

scope.model(todo, 'todo', '1')                   // экземпляр по адресу todo/1 (get-or-create)
const release = scope.claim(todo, 'todo', '1')   // стать владельцем; второй владелец → ошибка
release()                                        // удалится через unmountDelay
scope.dispose('todo', '1')                       // удалить сразу

const state = scope.serialize()                  // { todo: { '1': { done: true } } }
createScope(deps, { state })                     // гидрация: значения применяются при создании экземпляров
```

## React

```tsx
import { ScopeProvider, ModelProvider, useCreateModel, useCreateLocalModel, useModel, useStore, useEvent, useRun } from 'stm-react'

function TodoPage({ id }: { id: string }) {
  const m = useCreateModel(todo, 'todo', id)     // владелец: создаёт экземпляр и держит, пока смонтирован
  return <ModelProvider value={m}><Todo /></ModelProvider>
}

function Todo() {
  const { toggle, done, save } = useModel(todo)  // потребитель: экземпляр из провайдера выше
  const isDone = useStore(done)
  const pending = useStore(save.pending)
  const onToggle = useEvent(toggle)
  const run = useRun(save)
  return <button disabled={pending} onClick={() => { onToggle(); run() }}>{isDone ? '✓' : '·'}</button>
}

const ui = useCreateLocalModel(details)          // приватный экземпляр компонента, ключ типа из useId

<ScopeProvider value={scope}>
  <TodoPage id="1" />
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
