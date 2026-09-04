import { useRef, useState } from 'react'
import { ModelProvider, useEvent, useModel, useRun, useStore } from 'stm-react'
import { user } from './models'

function UserCard({ onRemove }: { onRemove: () => void }) {
  const m = useModel(user)
  const title = useStore(m.title)
  const pending = useStore(m.load.pending)
  const error = useStore(m.error)
  const run = useRun(m.load)
  const like = useEvent(m.like)
  const ctrl = useRef<AbortController | null>(null)

  const load = () => {
    ctrl.current?.abort()
    ctrl.current = new AbortController()
    run(undefined, ctrl.current.signal).catch(() => {})
  }

  return (
    <div className="card">
      <h3>{title}</h3>
      <p>{pending ? 'Загрузка…' : error ? `Ошибка: ${error}` : ''}</p>
      <button onClick={load} disabled={pending}>Загрузить</button>
      <button onClick={() => ctrl.current?.abort()} disabled={!pending}>Отменить</button>
      <button onClick={() => like()}>❤</button>
      <button onClick={onRemove}>Удалить</button>
    </div>
  )
}

export function App() {
  const [ids, setIds] = useState(['1', '2'])
  const [next, setNext] = useState(3)
  const [twice, setTwice] = useState(false)
  const shown = twice ? [...ids, ids[0]] : ids

  return (
    <main>
      <h1>stm · модели по ключу</h1>
      <button onClick={() => (setIds([...ids, String(next)]), setNext(next + 1))}>Добавить карточку</button>
      <label>
        <input type="checkbox" checked={twice} onChange={e => setTwice(e.target.checked)} /> показать первую карточку дважды
      </label>
      <div className="cards">
        {shown.map((id, i) => (
          <ModelProvider key={`${id}-${i}`} model={user} id={id}>
            <UserCard onRemove={() => setIds(ids.filter(x => x !== id))} />
          </ModelProvider>
        ))}
      </div>
      <p>
        Две карточки с одним ключом делят состояние. Удалённая карточка через секунду теряет состояние, а её незавершённая
        загрузка отменяется.
      </p>
    </main>
  )
}
