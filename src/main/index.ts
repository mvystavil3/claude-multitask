import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { IPC } from '../shared/ipc.js';
import type { AppConfig } from '../shared/types.js';
import { appRoot, configPath, loadConfig, toConfigWorkspace } from './config.js';
import { Manager } from './manager.js';
import { getTheme } from '../shared/themes.js';
import { setDockerfileDir } from './docker.js';

let manager: Manager;
let win: BrowserWindow | null = null;
let watcher: FSWatcher | null = null;
let quitting = false;
/** Set while we write the config ourselves, so the watcher ignores the echo. */
let selfWriteUntil = 0;

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow(backgroundColor: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 800,
    minHeight: 500,
    backgroundColor,
    title: 'Claude Multitask',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  w.loadFile(path.join(__dirname, '../renderer/index.html'));
  return w;
}

/**
 * External edits to multitask.config.json hot-reload into the app. The containing
 * folder is watched rather than the file: editors that save atomically replace the
 * inode, which would silently kill a watch bound to the file itself.
 */
function watchConfig(): void {
  const name = path.basename(configPath());
  let timer: NodeJS.Timeout | null = null;
  try {
    watcher = watch(appRoot(), { persistent: false }, (_event, filename) => {
      if (filename !== name) return;
      if (Date.now() < selfWriteUntil) return;
      if (timer) clearTimeout(timer);
      // Editors write in several bursts; debounce so we parse the finished file.
      timer = setTimeout(() => void manager.reloadFromDisk(), 400);
    });
  } catch {
    /* watching is a convenience; the Reload button always works */
  }
}

function registerIpc(): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>) =>
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...(args as never[]));
      } catch (err) {
        manager.toast((err as Error).message, 'error');
        throw err;
      }
    });

  handle(IPC.snapshot, () => manager.snapshot());
  handle(IPC.preflight, () => manager.preflight());
  handle(IPC.saveConfig, async (config: AppConfig) => {
    selfWriteUntil = Date.now() + 1500;
    await manager.applyConfig(config);
    return manager.snapshot();
  });
  handle(IPC.reloadConfig, () => manager.reloadFromDisk());
  handle(IPC.start, (id: string) => manager.start(id));
  handle(IPC.stop, (id: string) => manager.stop(id));
  handle(IPC.restart, (id: string) => manager.restart(id));
  handle(IPC.freshSession, (id: string) => manager.freshSession(id));
  handle(IPC.startAll, () => manager.startAll());
  handle(IPC.stopAll, () => manager.stopAll());
  handle(IPC.restartAll, () => manager.restartAll());
  handle(IPC.sendPrompt, (id: string, text?: string) => manager.sendPrompt(id, text));
  handle(IPC.write, (id: string, data: string) => manager.write(id, data));
  handle(IPC.resize, (id: string, cols: number, rows: number) => manager.resize(id, cols, rows));
  handle(IPC.replay, (id: string) => manager.replayFor(id));
  handle(IPC.openWorkspace, (id: string) => manager.openWorkspace(id));
  handle(IPC.openConfigFile, () => manager.openConfigFile());
  handle(IPC.clipboardRead, () => clipboard.readText());
  handle(IPC.clipboardWrite, (text: string) => {
    clipboard.writeText(text);
  });
  handle(IPC.dockerStatus, () => manager.dockerStatus());
  handle(IPC.dockerPull, (ref: string) => manager.dockerPull(ref));
  handle(IPC.dockerBuild, (tag: string, base: string) => manager.dockerBuild(tag, base));
  handle(IPC.dockerLoad, (tarPath: string) => manager.dockerLoad(tarPath));
  handle(IPC.pickFolder, async (current?: string) => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose the folder this terminal works in',
      defaultPath: current || appRoot(),
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : toConfigWorkspace(res.filePaths[0]);
  });
  handle(IPC.pickTarFile, async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Load a Docker image archive',
      filters: [{ name: 'Docker image archive', extensions: ['tar', 'tar.gz', 'tgz'] }],
      properties: ['openFile'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  setDockerfileDir(
    app.isPackaged
      ? path.join(process.resourcesPath, 'docker')
      : path.resolve(__dirname, '../../build/docker'),
  );
  const { config, error } = await loadConfig();
  manager = new Manager(config);
  await manager.ensureWorkspaces();
  registerIpc();

  win = createWindow(getTheme(config.defaults.theme).palette.background);
  manager.attachWindow(win);

  win.webContents.once('did-finish-load', async () => {
    if (error) manager.toast(`Config file is invalid, using defaults: ${error}`, 'error');
    watchConfig();
    await manager.sweepStaleContainers();
    await manager.autoStart();
  });

  win.on('close', (event) => {
    if (quitting || !manager.hasLiveSessions()) return;
    event.preventDefault();
    const live = manager.liveCount();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Stop them and quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Terminals are still running',
      message: `${live} terminal${live === 1 ? ' is' : 's are'} still running.`,
      detail: 'Quitting stops every Claude Code session. Artifacts already written are kept.',
    });
    if (choice === 0) {
      quitting = true;
      void manager.disposeAll().then(() => win?.close());
    }
  });

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  quitting = true;
  watcher?.close();
  void manager?.disposeAll();
});
