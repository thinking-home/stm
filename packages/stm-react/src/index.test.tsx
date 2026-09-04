// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createScope, effect, event, model, store } from 'stm'
import { ModelProvider, ScopeProvider, useEvent, useModel, useRun, useStore } from './index'

declare module 'stm' {
  interface Deps {
    api: { load(id: string, signal: AbortSignal): Promise<string> }
  }
}

const api = { load: async (id: string) => `user:${id}` }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

const counter = model((id: string) => {
  const inc = event()
  const count = store(0).on(inc, s => s + 1)
  const load = effect((_: void, { deps, signal }) => deps.api.load(id, signal))
  const user = store('').on(load.done, (_, { result }) => result)
  return { inc, count, load, user }
})

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

afterEach(cleanup)

describe('react', () => {
  it('ключ задаётся в провайдере, экземпляры независимы, состояние живёт в scope', async () => {
    const scope = createScope({ api }, 5)
    const App = ({ ids }: { ids: string[] }) => (
      <StrictMode>
        <ScopeProvider value={scope}>
          {ids.map(id => (
            <section key={id} data-testid={id}>
              <ModelProvider model={counter} id={id}>
                <Counter />
              </ModelProvider>
            </section>
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
    expect(within('a', 'value').textContent).toBe('2')
    expect(within('b', 'value').textContent).toBe('1')
    expect(scope.get(scope.model(counter, 'a').count)).toBe(2)

    fireEvent.click(button('a', 'load'))
    expect(within('a', 'user').textContent).toBe('…')
    await act(() => tick())
    expect(within('a', 'user').textContent).toBe('user:a')

    // размонтировали "a": через unmountDelay экземпляр удалён, при повторном монтировании — чистый
    rerender(<App ids={['b']} />)
    await act(() => tick(10))
    rerender(<App ids={['a', 'b']} />)
    expect(within('a', 'value').textContent).toBe('0')
    expect(within('b', 'value').textContent).toBe('1')
  })

  it('размонтирование отменяет запущенный эффект экземпляра', async () => {
    let aborted = false
    const slow = model((id: string) => ({
      load: effect(
        (_: void, { signal }) =>
          new Promise<string>((_, reject) => signal.addEventListener('abort', () => ((aborted = true), reject(signal.reason)))),
      ),
      id,
    }))
    const Runner = () => {
      const { load } = useModel(slow)
      const run = useRun(load)
      return <button onClick={() => void run().catch(() => {})}>go</button>
    }
    const scope = createScope({ api }, 5)
    const { unmount } = render(
      <ScopeProvider value={scope}>
        <ModelProvider model={slow} id="x">
          <Runner />
        </ModelProvider>
      </ScopeProvider>,
    )
    fireEvent.click(screen.getByText('go'))
    expect(scope.get(scope.model(slow, 'x').load.pending)).toBe(true)
    unmount()
    await tick(10)
    expect(aborted).toBe(true)
  })
})
