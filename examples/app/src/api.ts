export interface User {
  id: string
  name: string
}

/** фейковый API: полторы секунды задержки, четверть запросов падает, умеет отменяться */
export const api = {
  async user(id: string, signal: AbortSignal): Promise<User> {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 1500)
      signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
    })
    if (Math.random() < 0.25) throw new Error(`сервер не ответил по пользователю #${id}`)
    return { id, name: `Пользователь #${id}` }
  },
}

export type Api = typeof api
