// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createScope, effect, event, model, store } from 'stm'
import {
  ModelProvider,
  ScopeProvider,
  useCreateLocalModel,
  useCreateModel,
  useEvent,
  useModel,
  useRun,
  useStore,
} from './index'

declare module 'stm' {
  interface Deps {
    api: { load(id: string, signal: AbortSignal): Promise<string> }
  }
}

const api = { load: async (id: string) => `user:${id}` }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

const counter = model((id: string, ctx) => {
  const inc = event()
  const count = store(0)
  const load = effect((_: void, { deps, signal }) => deps.api.load(id, signal))
  const user = store('')
  ctx.on(inc, () => ctx.set(count, ctx.get(count) + 1))
  ctx.on(load.done, ({ result }) => ctx.set(user, result))
  return { inc, count, load, user }
})

const toggle = model(({ initial }: { initial: boolean }, ctx) => {
  const flip = event()
  const on = store(initial)
  ctx.on(flip, () => ctx.set(on, !ctx.get(on)))
  return { flip, on }
})

// потребитель: экземпляр приходит из провайдера владельца
function Counter() {
  const { inc, count, load, user } = useModel(counter)
  const value = useStore(count)
  const pending = useStore(load.pending)
  const name = useStore(user)
  const onInc = useEvent(inc)
  const run = useRun(load)
  return (
    <div>
      <button onClick={() => onInc()}>+</button>
      <button onClick={() => void run().catch(() => {})}>load</button>
      <span data-testid="value">{value}</span>
      <span data-testid="user">{pending ? '…' : name}</span>
    </div>
  )
}

// владелец: создаёт экземпляр counter/id и локальный экземпляр toggle с params
function Card({ id }: { id: string }) {
  const m = useCreateModel(counter, 'counter', id)
  const ui = useCreateLocalModel(toggle, { initial: false })
  const on = useStore(ui.on)
  const flip = useEvent(ui.flip)
  return (
    <section data-testid={id}>
      <ModelProvider value={m}>
        <Counter />
      </ModelProvider>
      <button onClick={() => flip()}>toggle</button>
      <span data-testid="on">{String(on)}</span>
    </section>
  )
}

afterEach(cleanup)

describe('react', () => {
  it('владелец создаёт экземпляр, потребитель берёт его из провайдера, состояние живёт в scope', async () => {
    const scope = createScope({ api }, { unmountDelay: 5 })
    const App = ({ ids }: { ids: string[] }) => (
      <StrictMode>
        <ScopeProvider value={scope}>
          {ids.map(id => (
            <Card key={id} id={id} />
          ))}
        </ScopeProvider>
      </StrictMode>
    )
    const { rerender } = render(<App ids={['a', 'b']} />)
    const within = (id: string, testId: string) =>
      screen.getByTestId(id).querySelector(`[data-testid="${testId}"]`)!
    const button = (id: string, text: string) =>
      [...screen.getByTestId(id).querySelectorAll('button')].find(b => b.textContent === text)!

    fireEvent.click(button('a', '+'))
    fireEvent.click(button('a', '+'))
    fireEvent.click(button('b', '+'))
    fireEvent.click(button('a', 'toggle'))
    expect(within('a', 'value').textContent).toBe('2')
    expect(within('b', 'value').textContent).toBe('1')
    expect(within('a', 'on').textContent).toBe('true')
    expect(within('b', 'on').textContent).toBe('false')
    expect(scope.get(scope.model(counter, 'counter', 'a').count)).toBe(2)

    fireEvent.click(button('a', 'load'))
    expect(within('a', 'user').textContent).toBe('…')
    await act(() => tick())
    expect(within('a', 'user').textContent).toBe('user:a')

    // размонтировали "a": через unmountDelay экземпляры удалены, при повторном монтировании — чистые
    rerender(<App ids={['b']} />)
    await act(() => tick(10))
    rerender(<App ids={['a', 'b']} />)
    expect(within('a', 'value').textContent).toBe('0')
    expect(within('a', 'on').textContent).toBe('false')
    expect(within('b', 'value').textContent).toBe('1')
  })

  it('размонтирование владельца отменяет запущенный эффект экземпляра', async () => {
    let aborted = false
    const slow = model((id: string) => ({
      load: effect(
        (_: void, { signal }) =>
          new Promise<string>((_, reject) =>
            signal.addEventListener('abort', () => ((aborted = true), reject(signal.reason))),
          ),
      ),
      id,
    }))
    const Runner = () => {
      const { load } = useCreateModel(slow, 'slow', 'x')
      const run = useRun(load)
      return <button onClick={() => void run().catch(() => {})}>go</button>
    }
    const scope = createScope({ api }, { unmountDelay: 5 })
    const { unmount } = render(
      <ScopeProvider value={scope}>
        <Runner />
      </ScopeProvider>,
    )
    fireEvent.click(screen.getByText('go'))
    expect(scope.get(scope.model(slow, 'slow', 'x').load.pending)).toBe(true)
    unmount()
    await tick(10)
    expect(aborted).toBe(true)
  })
})
