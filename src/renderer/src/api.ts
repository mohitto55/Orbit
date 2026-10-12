import type { Api } from '../../main/api'
import type { AiCheckApi } from '../../main/aiCheckApi'
import type { UpdaterApi } from '../../main/updater'

type Promisify<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never
}

declare global {
  interface Window {
    girsktop: {
      invoke: (name: string, ...args: unknown[]) => Promise<any>
      on: (channel: string, cb: (payload: any) => void) => () => void
    }
  }
}

export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export const api = new Proxy(
  {},
  {
    get:
      (_t, name: string) =>
      (...args: unknown[]) =>
        window.girsktop.invoke(name, ...args).catch((e: unknown) => {
          throw new Error(cleanError(e))
        })
  }
) as Promisify<Api & AiCheckApi & UpdaterApi>

export const on = (channel: string, cb: (payload: any) => void) => window.girsktop.on(channel, cb)

export type Project = NonNullable<Awaited<ReturnType<Api['currentProject']>>>
export type Dashboard = Awaited<ReturnType<Api['dashboard']>>
