import { contextBridge, ipcRenderer, webUtils } from 'electron'

const bridge = {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
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
