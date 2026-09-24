import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc.js';
import type {
  AppConfig,
  DockerStatus,
  PaneState,
  Preflight,
  ResourceSample,
} from '../shared/types.js';
import type { Snapshot } from '../shared/ipc.js';

const api = {
  snapshot: (): Promise<Snapshot> => ipcRenderer.invoke(IPC.snapshot),
  preflight: (): Promise<Preflight> => ipcRenderer.invoke(IPC.preflight),
  saveConfig: (config: AppConfig): Promise<Snapshot> => ipcRenderer.invoke(IPC.saveConfig, config),
  reloadConfig: (): Promise<void> => ipcRenderer.invoke(IPC.reloadConfig),

  start: (id: string): Promise<void> => ipcRenderer.invoke(IPC.start, id),
  stop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.stop, id),
  restart: (id: string): Promise<void> => ipcRenderer.invoke(IPC.restart, id),
  freshSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.freshSession, id),
  startAll: (): Promise<void> => ipcRenderer.invoke(IPC.startAll),
  stopAll: (): Promise<void> => ipcRenderer.invoke(IPC.stopAll),
  restartAll: (): Promise<void> => ipcRenderer.invoke(IPC.restartAll),

  sendPrompt: (id: string, text?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sendPrompt, id, text),
  write: (id: string, data: string): Promise<void> => ipcRenderer.invoke(IPC.write, id, data),
  resize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(IPC.resize, id, cols, rows),
  replay: (id: string): Promise<string> => ipcRenderer.invoke(IPC.replay, id),

  openWorkspace: (id: string): Promise<void> => ipcRenderer.invoke(IPC.openWorkspace, id),
  openConfigFile: (): Promise<void> => ipcRenderer.invoke(IPC.openConfigFile),
  clipboardRead: (): Promise<string> => ipcRenderer.invoke(IPC.clipboardRead),
  clipboardWrite: (text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.clipboardWrite, text),

  dockerStatus: (): Promise<DockerStatus> => ipcRenderer.invoke(IPC.dockerStatus),
  dockerPull: (ref: string): Promise<boolean> => ipcRenderer.invoke(IPC.dockerPull, ref),
  dockerBuild: (tag: string, base: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.dockerBuild, tag, base),
  dockerLoad: (tarPath: string): Promise<boolean> => ipcRenderer.invoke(IPC.dockerLoad, tarPath),
  pickTarFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickTarFile),
  pickFolder: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.pickFolder, current),

  onData: (cb: (p: { id: string; chunk: string }) => void) => {
    const fn = (_e: unknown, p: { id: string; chunk: string }) => cb(p);
    ipcRenderer.on(IPC.onData, fn);
    return () => ipcRenderer.off(IPC.onData, fn);
  },
  onState: (cb: (s: PaneState) => void) => {
    const fn = (_e: unknown, s: PaneState) => cb(s);
    ipcRenderer.on(IPC.onState, fn);
    return () => ipcRenderer.off(IPC.onState, fn);
  },
  onConfig: (cb: (s: Snapshot) => void) => {
    const fn = (_e: unknown, s: Snapshot) => cb(s);
    ipcRenderer.on(IPC.onConfig, fn);
    return () => ipcRenderer.off(IPC.onConfig, fn);
  },
  onDockerLog: (cb: (p: { line: string }) => void) => {
    const fn = (_e: unknown, p: { line: string }) => cb(p);
    ipcRenderer.on(IPC.onDockerLog, fn);
    return () => ipcRenderer.off(IPC.onDockerLog, fn);
  },
  onResources: (cb: (s: ResourceSample) => void) => {
    const fn = (_e: unknown, s: ResourceSample) => cb(s);
    ipcRenderer.on(IPC.onResources, fn);
    return () => ipcRenderer.off(IPC.onResources, fn);
  },
  onToast: (cb: (t: { message: string; kind: 'info' | 'error' }) => void) => {
    const fn = (_e: unknown, t: { message: string; kind: 'info' | 'error' }) => cb(t);
    ipcRenderer.on(IPC.onToast, fn);
    return () => ipcRenderer.off(IPC.onToast, fn);
  },
};

contextBridge.exposeInMainWorld('mt', api);

export type MtApi = typeof api;
