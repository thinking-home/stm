# @thinking-home/stm-react

Хуки и провайдеры React для `@thinking-home/stm`: `useStore`, `useEvent`, `useRun`, `useCreateModel`, `useCreateLocalModel`, `useModel`, `ScopeProvider`, `ModelProvider`.

```sh
pnpm add @thinking-home/stm @thinking-home/stm-react
```

```tsx
import { ModelProvider, ScopeProvider, useCreateModel, useModel, useStore } from '@thinking-home/stm-react'

function UserPage({ id }: { id: string }) {
  const m = useCreateModel(user, `user/${id}`, id) // владелец экземпляра
  return <ModelProvider value={m}><UserName /></ModelProvider>
}

function UserName() {
  const { data } = useModel(user)                  // потребитель
  return <span>{useStore(data)?.name}</span>
}

<ScopeProvider value={scope}><UserPage id="1" /></ScopeProvider>
```

Требует React 18 или новее. Документация и примеры: репозиторий проекта, `README.md` и `docs/MODEL.md`.
