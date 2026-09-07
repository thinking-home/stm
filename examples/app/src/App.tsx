import { useRef } from 'react'
import { ModelProvider, useCreateLocalModel, useCreateModel, useEvent, useModel, useRun, useStore } from 'stm-react'
import { app, details, user } from './models'

// потребитель: экземпляр user пришёл из провайдера владельца
function UserTitle() {
  const m = useModel(user)
  const title = useStore(m.title)
  const pending = useStore(m.load.pending)
  const status = useStore(m.status)
  return (
    <>
      <h3>{title}</h3>
      <p>{pending ? 'Загрузка…' : status}</p>
    </>
  )
}

// владелец экземпляра user/id и локального экземпляра details
function UserCard({ id }: { id: string }) {
  const m = useCreateModel(user, 'user', id)
  const ui = useCreateLocalModel(details)
  const { remove } = useModel(app)

  const pending = useStore(m.load.pending)
  const open = useStore(ui.open)
  const run = useRun(m.load)
  const like = useEvent(m.like)
  const toggle = useEvent(ui.toggle)
  const onRemove = useEvent(remove)
  const ctrl = useRef<AbortController | null>(null)

  const load = () => {
    ctrl.current?.abort()
    ctrl.current = new AbortController()
    run(undefined, ctrl.current.signal).catch(() => {})
  }

  return (
    <div className="card">
      <ModelProvider value={m}>
        <UserTitle />
      </ModelProvider>
      <button onClick={load} disabled={pending}>Загрузить</button>
      <button onClick={() => ctrl.current?.abort()} disabled={!pending}>Отменить</button>
      <button onClick={() => like()}>❤</button>
      <button onClick={() => onRemove(id)}>Удалить</button>
      <button onClick={() => toggle()}>{open ? 'Скрыть' : 'Подробнее'}</button>
      {open && <p>Адрес экземпляра: user/{id}. Этот блок открыт локальной моделью с ключом из useId.</p>}
    </div>
  )
}

export function App() {
  const root = useCreateModel(app, 'root')
  const ids = useStore(root.ids)
  const add = useEvent(root.add)
  return (
    <ModelProvider value={root}>
      <main>
        <h1>stm · модели по ключу</h1>
        <button onClick={() => add()}>Добавить карточку</button>
        <div className="cards">
          {ids.map(id => (
            <UserCard key={id} id={id} />
          ))}
        </div>
        <p>
          Карточка владеет экземпляром user/id и отдаёт его заголовку через провайдер. Удалённая карточка через секунду
          теряет состояние, а её незавершённая загрузка отменяется.
        </p>
      </main>
    </ModelProvider>
  )
}
