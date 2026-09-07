# @thinking-home/stm

Минималистичный state manager: сторы, события, эффекты и модели по адресам. Всё состояние живёт в `Scope`, сами юниты — описания без состояния.

```sh
pnpm add @thinking-home/stm
```

```ts
import { createScope, effect, event, model, store } from '@thinking-home/stm'

const counter = model((id: string, ctx) => {
  const inc = event<number>()
  const count = store(0)
  const load = effect((_: void, { deps, signal }) => deps.api.load(id, signal))
  ctx.on(inc, n => ctx.set(count, ctx.get(count) + n))
  return { inc, count, load }
})

const scope = createScope({ api })
const c = scope.model(counter, 'counter/1', '1')
scope.emit(c.inc, 2)
scope.get(c.count) // 2
```

Биндинги для React: `@thinking-home/stm-react`. Документация и примеры: репозиторий проекта, `README.md` и `docs/MODEL.md`.
