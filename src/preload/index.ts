import { contextBridge, ipcRenderer } from 'electron'

const bridge = {
  invoke: (name: string, ...args: unknown[]) => ipcRenderer.invoke(`api:${name}`, ...args),
  on: (channel: string, cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('orbit', bridge)

export type Bridge = typeof bridge
