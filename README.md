# stm

Минималистичный state manager для React в духе nanostores. Монорепозиторий на pnpm workspaces.

```
packages/stm          ядро: store, event, computed, effect, model, Scope
packages/stm-react    хуки и провайдеры, зависит от stm через workspace:*
examples/app          Vite + React, чтобы проверять руками
```

- `store`, `event`, `computed`, `effect` — описания без состояния. Всё состояние живёт в `Scope`.
- `model` — шаблон набора юнитов. Сторы, эффекты и computed объявляются только внутри его фабрики, связи между ними описываются через контекст `ctx.on`. События можно объявлять и вне модели, как общую шину.
- `effect` — async-функция с событиями `started` / `done` / `failed` / `aborted`, стором `pending`, `AbortSignal` и доступом к `deps` скоупа.
- Экземпляр модели адресуется строкой, живёт, пока у него есть владелец, и умеет сериализоваться. Подробнее: [docs/MODEL.md](docs/MODEL.md).

## Пример: список с локальной моделью на каждый элемент

### Модели

```ts
// models.ts
import { effect, event, model, store, type InstanceOf } from 'stm'

// зависимости, доступные эффектам
declare module 'stm' {
  interface Deps { api: { items(signal: AbortSignal): Promise<Item[]> } }
}

export interface Item { id: string; title: string }

/** корневая модель приложения: список элементов */
export const app = model((_, ctx) => {
  const load = effect((_: void, { deps, signal }) => deps.api.items(signal))
  const remove = event<string>()
  const items = store<Item[]>([])

  ctx.on(load.done, ({ result }) => ctx.set(items, result))
  ctx.on(remove, id => ctx.set(items, ctx.get(items).filter(i => i.id !== id)))

  return { load, remove, items }
})

/** локальная модель элемента списка: корневой экземпляр приходит через params */
export const item = model(({ id, root }: { id: string; root: InstanceOf<typeof app> }, ctx) => {
  const toggle = event()
  const remove = event()
  const done = store(false)

  ctx.on(toggle, () => ctx.set(done, !ctx.get(done)))
  ctx.on(remove, () => ctx.emit(root.remove, id)) // своё событие → событие корневой модели

  return { id, toggle, remove, done }
})
```

Слушатели `ctx.on` вызываются в порядке регистрации, вложенный `emit` выполняется синхронно. Поэтому в фабрике сначала описывают обновления состояния, потом реакции на него.

### Корневой экземпляр создаётся вне компонентов

```tsx
// main.tsx
import { createRoot } from 'react-dom/client'
import { createScope } from 'stm'
import { ModelProvider, ScopeProvider } from 'stm-react'

const scope = createScope({ api })
const root = scope.model(app, 'root')   // адрес 'root', владелец не нужен: живёт вместе со скоупом
scope.run(root.load).catch(console.error)

createRoot(document.getElementById('root')!).render(
  <ScopeProvider value={scope}>
    <ModelProvider value={root}>
      <List />
    </ModelProvider>
  </ScopeProvider>,
)
```

### Элемент списка владеет локальной моделью

```tsx
// List.tsx
import { ModelProvider, useCreateLocalModel, useEvent, useModel, useStore } from 'stm-react'

function List() {
  const { items } = useModel(app)                     // корневой экземпляр из провайдера
  return <ul>{useStore(items).map(i => <ListItem key={i.id} id={i.id} />)}</ul>
}

function ListItem({ id }: { id: string }) {
  const root = useModel(app)
  const m = useCreateLocalModel(item, { id, root })   // адрес из useId, живёт, пока смонтирован элемент
  return (
    <ModelProvider value={m}>
      <li>
        <ItemTitle /> <ItemActions />
      </li>
    </ModelProvider>
  )
}

// вложенные компоненты берут локальную модель через useModel, корневую — тоже
function ItemTitle() {
  const { id, done } = useModel(item)
  const { items } = useModel(app)
  const isDone = useStore(done)
  const title = useStore(items).find(i => i.id === id)?.title
  return <span style={{ textDecoration: isDone ? 'line-through' : 'none' }}>{title}</span>
}

function ItemActions() {
  const { toggle, remove } = useModel(item)
  const onToggle = useEvent(toggle)
  const onRemove = useEvent(remove)                    // remove локальной модели → app.remove(id)
  return (
    <>
      <button onClick={() => onToggle()}>✓</button>
      <button onClick={() => onRemove()}>Удалить</button>
    </>
  )
}
```

После размонтирования элемента его локальный экземпляр удаляется через `unmountDelay` (по умолчанию 1 с, как в nanostores), так что StrictMode и быстрые перемонтирования не пересоздают модель. Экземпляр, который нужен нескольким компонентам, создаёт их общий предок через `useCreateModel(model, 'адрес', params)` и отдаёт вниз провайдером.

## Скоуп без React

```ts
const root = scope.model(app, 'root')            // получить или создать экземпляр по адресу
const release = scope.claim(app, 'root')         // стать владельцем; второй владелец → ошибка
release()                                        // удалится через unmountDelay
scope.dispose('root')                            // удалить сразу

scope.emit(root.remove, '1')
scope.get(root.items)
scope.subscribe(root.items, items => console.log(items))
await scope.run(root.load, undefined, ctrl.signal) // AbortSignal последним аргументом — отмена

const state = scope.serialize()                  // { root: { items: [...] } }
createScope(deps, { state })                     // гидрация: значения применяются при создании экземпляров
```

Отменённый запуск отклоняется причиной отмены и эмитит `aborted` с `{ params, reason }` вместо `done` или `failed`. События срабатывают в момент завершения обработчика, `pending` обновляется прямо перед ними.

## Команды

```sh
pnpm install
pnpm test        # vitest по всем пакетам
pnpm typecheck   # tsc -b по графу project references
pnpm dev         # examples/app на http://localhost:5173
```

Внутренние пакеты не собираются: `exports` указывают на `.ts` исходники, Vite и vitest читают их напрямую. Перед публикацией в npm понадобится сборка (например, tsdown) и замена `exports` на `dist`.
