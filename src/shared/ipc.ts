/** Channel names shared by main, preload and renderer. */
export const IPC = {
  // renderer -> main (invoke)
  snapshot: 'mt:snapshot',
  preflight: 'mt:preflight',
  saveConfig: 'mt:save-config',
  reloadConfig: 'mt:reload-config',
  start: 'mt:start',
  stop: 'mt:stop',
  restart: 'mt:restart',
  freshSession: 'mt:fresh-session',
  startAll: 'mt:start-all',
  stopAll: 'mt:stop-all',
  restartAll: 'mt:restart-all',
  sendPrompt: 'mt:send-prompt',
  write: 'mt:write',
  resize: 'mt:resize',
  replay: 'mt:replay',
  openWorkspace: 'mt:open-workspace',
  openConfigFile: 'mt:open-config-file',
  clipboardRead: 'mt:clipboard-read',
  clipboardWrite: 'mt:clipboard-write',
  dockerStatus: 'mt:docker-status',
  dockerPull: 'mt:docker-pull',
  dockerBuild: 'mt:docker-build',
  dockerLoad: 'mt:docker-load',
  pickTarFile: 'mt:pick-tar-file',
  pickFolder: 'mt:pick-folder',

  // main -> renderer (send)
  onData: 'mt:data',
  onState: 'mt:state',
  onConfig: 'mt:config',
  onToast: 'mt:toast',
  onDockerLog: 'mt:docker-log',
  onResources: 'mt:resources',
} as const;

export interface Snapshot {
  config: import('./types.js').AppConfig;
  /** Panes with defaults already applied — the renderer must not duplicate that logic. */
  panes: import('./types.js').ResolvedPane[];
  states: import('./types.js').PaneState[];
}
