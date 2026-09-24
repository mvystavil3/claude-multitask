import type {
  AppConfig,
  ClaudeConfigMode,
  DockerConfig,
  LaunchMode,
  PaneConfig,
  Preflight,
  ProfileId,
} from '../shared/types.js';
import { PROFILES, profileAvailable } from '../shared/types.js';
import { comboInput, el, field, linesToArray, numberInput, select, themeField } from './dom.js';
import {
  DEFAULT_THEME_ID,
  allThemes,
  getTheme,
  isCustomTheme,
  setCustomThemes,
} from '../shared/themes.js';
import { openThemeEditor } from './theme-editor.js';
import { localImageRefs, openImagesDialog } from './images.js';

/** Shells this machine can run are selectable; the rest stay listed but disabled. */
const profileOptions = () =>
  PROFILES.map((p) => ({
    value: p.id,
    label: profileAvailable(p.id, window.mt.platform) ? p.label : `${p.label} (not on this OS)`,
    disabled: !profileAvailable(p.id, window.mt.platform),
  }));

const LAUNCH_MODES: { value: LaunchMode; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'command', label: 'A command of my own' },
  { value: 'shell', label: 'Nothing — just open the shell' },
];

const CLAUDE_CONFIG_MODES: { value: ClaudeConfigMode; label: string }[] = [
  { value: 'shared', label: 'shared — mount the host’s ~/.claude' },
  { value: 'copy', label: 'copy — per-pane Claude home, seeded from the host' },
  { value: 'none', label: 'none — no mount (needs ANTHROPIC_API_KEY)' },
];

interface Options {
  config: AppConfig;
  preflight: Preflight | null;
  focusPaneId?: string;
  onSave(config: AppConfig): Promise<void> | void;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of linesToArray(text)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const formatEnv = (env: Record<string, string> = {}) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

/** Keep a number field inside the range the config schema will accept. */
function clampField(input: HTMLInputElement, min: number, max: number): number {
  const value = Math.max(min, Math.min(max, Math.round(Number(input.value)) || min));
  input.value = String(value);
  return value;
}

/** What a pane's folder resolves to, for comparing panes and showing the real path. */
function resolvedWorkspace(pane: PaneConfig): string {
  return pane.workspace?.trim() || defaultWorkspace(pane.id);
}

/** Mirrors config.ts so the dialog shows the same default the app would use. */
function defaultWorkspace(id: string): string {
  return `workspaces/${id}`;
}

/** Deep-ish clone that is enough for the plain-data config shape. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function openSettings({ config, preflight, focusPaneId, onSave }: Options): void {
  const draft = clone(config);
  let selected = focusPaneId ?? draft.panes[0]?.id;

  const overlay = el('div', { className: 'overlay' });
  const modal = el('div', { className: 'modal' });
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  // Escape closes only the topmost dialog, so the theme editor or Docker images dialog
  // opened from here does not take Settings (and its unsaved edits) down with it.
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !overlay.isConnected) return;
    const overlays = document.querySelectorAll('.overlay');
    if (overlays[overlays.length - 1] === overlay) close();
  }

  const distroOptions = () => {
    const found = preflight?.wslDistros ?? [];
    return [{ value: '', label: 'default distro' }, ...found.map((d) => ({ value: d, label: d }))];
  };

  // ---- global section ----
  const cols = numberInput(draft.grid.cols, 1, 6);
  const rows = numberInput(draft.grid.rows, 1, 6);
  const fontSize = numberInput(draft.defaults.fontSize, 8, 32);
  const defProfile = select(profileOptions(), draft.defaults.profile);
  const defLaunch = select(LAUNCH_MODES, draft.defaults.launch ?? 'claude');
  const defTheme = themeField('Theme', draft.defaults.theme ?? DEFAULT_THEME_ID, allThemes(), null);

  /** Save a scheme into the draft, then re-render so the pickers show it immediately. */
  const saveScheme = (theme: Parameters<typeof openThemeEditor>[0]['base']) => {
    const list = (draft.customThemes ?? []).filter((t) => t.id !== theme.id);
    draft.customThemes = [...list, theme];
    draft.defaults.theme = theme.id;
    rebuildThemeField();
  };

  const themeButtons = el('div', { className: 'row theme-actions' }, [
    el('button', {
      textContent: 'Duplicate & edit…',
      title: 'Start a new scheme from the selected one',
      onclick: () =>
        openThemeEditor({
          base: getTheme(defTheme.select.value),
          existingIds: allThemes().map((t) => t.id),
          onSave: saveScheme,
        }),
    }),
    el('button', {
      textContent: 'Edit scheme…',
      title: 'Edit the selected saved scheme',
      disabled: !isCustomTheme(defTheme.select.value),
      onclick: () =>
        openThemeEditor({
          base: getTheme(defTheme.select.value),
          existingIds: allThemes().map((t) => t.id),
          editingId: defTheme.select.value,
          onSave: saveScheme,
        }),
    }),
    el('button', {
      className: 'danger',
      textContent: 'Delete scheme',
      title: 'Remove the selected saved scheme',
      disabled: !isCustomTheme(defTheme.select.value),
      onclick: () => {
        const id = defTheme.select.value;
        draft.customThemes = (draft.customThemes ?? []).filter((t) => t.id !== id);
        if (draft.defaults.theme === id) draft.defaults.theme = DEFAULT_THEME_ID;
        for (const pane of draft.panes) if (pane.theme === id) pane.theme = undefined;
        rebuildThemeField();
      },
    }),
  ]);

  /**
   * The picker lists whatever schemes exist right now, so saving or deleting one has to
   * rebuild it along with the buttons that act on the selection.
   */
  function rebuildThemeField(): void {
    setCustomThemes(draft.customThemes);
    const replacement = themeField(
      'Theme',
      draft.defaults.theme ?? DEFAULT_THEME_ID,
      allThemes(),
      null,
    );
    defTheme.node.replaceWith(replacement.node);
    defTheme.node = replacement.node;
    defTheme.select = replacement.select;
    defTheme.select.addEventListener('change', syncThemeButtons);
    syncThemeButtons();
    renderForm();
  }

  function syncThemeButtons(): void {
    const custom = isCustomTheme(defTheme.select.value);
    const [, edit, remove] = themeButtons.querySelectorAll('button');
    (edit as HTMLButtonElement).disabled = !custom;
    (remove as HTMLButtonElement).disabled = !custom;
  }
  defTheme.select.addEventListener('change', syncThemeButtons);
  const defDistro = select(distroOptions(), draft.defaults.distro ?? '');
  const defModel = el('input', { value: draft.defaults.model ?? '', placeholder: 'opus / sonnet' });
  const defArgs = el('textarea', {
    value: (draft.defaults.claudeArgs ?? []).join('\n'),
    rows: 3,
    placeholder: '--permission-mode\nacceptEdits',
  });
  const defAutoStart = el('input', { type: 'checkbox', checked: draft.defaults.autoStart });
  const defAutoSubmit = el('input', { type: 'checkbox', checked: draft.defaults.autoSubmit });
  const defResume = el('input', { type: 'checkbox', checked: draft.defaults.resume ?? true });
  const defSound = el('input', { type: 'checkbox', checked: draft.defaults.sound ?? false });

  const globalPanel = el('div', { className: 'panel' }, [
    el('h3', { textContent: 'Global' }),
    el('div', { className: 'row' }, [
      field('Grid columns', cols),
      field('Grid rows', rows),
      field('Font size', fontSize),
    ]),
    el('div', { className: 'row' }, [
      field('Default shell', defProfile),
      field('Default start with', defLaunch),
    ]),
    el('div', { className: 'row' }, [
      field('Default WSL distro', defDistro),
      field('Default model', defModel),
    ]),
    defTheme.node,
    themeButtons,
    el('p', { className: 'muted' }, [
      'The theme also sets the window’s own colours. Panes can override it individually.',
    ]),
    field('Default claude arguments', defArgs, 'One argument per line.'),
    el('div', { className: 'row' }, [
      field('Auto-start terminals on launch', defAutoStart),
      field('Auto-submit task prompt', defAutoSubmit),
    ]),
    el('div', { className: 'row' }, [
      field(
        'Resume the conversation on restart',
        defResume,
        'Off starts a fresh session every time.',
      ),
      field('Sound when a pane needs you', defSound, 'Off by default; the border pulses anyway.'),
    ]),
    el('p', { className: 'muted' }, [
      `Config file: ${preflight?.configPath ?? 'multitask.config.json'}`,
    ]),
    el('div', { className: 'row' }, [
      el('button', {
        textContent: 'Docker images…',
        title: 'Build, pull or load the image a docker pane runs',
        // Newly built images must show up in the pane's image picker straight away.
        onclick: () =>
          openImagesDialog((status) => {
            if (preflight) preflight.docker = status;
            renderForm();
          }),
      }),
    ]),
    el('p', { className: preflight?.claudeOnPath ? 'muted' : 'warn' }, [
      preflight?.claudeOnPath
        ? `claude: ${preflight.claudeOnPath}`
        : 'claude was not found on PATH — host shell panes will fail until it is installed or claudeBin is set.',
    ]),
  ]);

  // ---- pane section ----
  const paneList = el('div', { className: 'pane-list' });
  const paneForm = el('div', { className: 'panel' });

  function readGlobals(): void {
    draft.grid.cols = clampField(cols, 1, 6);
    draft.grid.rows = clampField(rows, 1, 6);
    draft.defaults.fontSize = clampField(fontSize, 8, 32);
    draft.defaults.profile = defProfile.value as ProfileId;
    draft.defaults.launch = defLaunch.value as LaunchMode;
    draft.defaults.theme = defTheme.select.value || DEFAULT_THEME_ID;
    draft.defaults.distro = defDistro.value || undefined;
    draft.defaults.model = defModel.value.trim() || undefined;
    draft.defaults.claudeArgs = linesToArray(defArgs.value);
    draft.defaults.autoStart = defAutoStart.checked;
    draft.defaults.autoSubmit = defAutoSubmit.checked;
    draft.defaults.resume = defResume.checked;
    draft.defaults.sound = defSound.checked;
  }

  function renderList(): void {
    paneList.replaceChildren();
    draft.panes.forEach((p, index) => {
      const row = el('div', { className: 'pane-row' + (p.id === selected ? ' selected' : '') });
      row.append(
        el('button', {
          className: 'pane-pick',
          textContent: `${index + 1}. ${p.title || p.id}`,
          onclick: () => {
            selected = p.id;
            renderList();
            renderForm();
          },
        }),
        el('button', {
          className: 'icon',
          textContent: '↑',
          title: 'Move up',
          disabled: index === 0,
          onclick: () => {
            [draft.panes[index - 1], draft.panes[index]] = [
              draft.panes[index],
              draft.panes[index - 1],
            ];
            renderList();
          },
        }),
        el('button', {
          className: 'icon',
          textContent: '↓',
          title: 'Move down',
          disabled: index === draft.panes.length - 1,
          onclick: () => {
            [draft.panes[index + 1], draft.panes[index]] = [
              draft.panes[index],
              draft.panes[index + 1],
            ];
            renderList();
          },
        }),
        el('button', {
          className: 'icon danger',
          textContent: '✕',
          title: 'Remove terminal (its folder is kept on disk)',
          onclick: () => {
            draft.panes.splice(index, 1);
            if (selected === p.id) selected = draft.panes[0]?.id;
            renderList();
            renderForm();
          },
        }),
      );
      paneList.append(row);
    });

    paneList.append(
      el('button', {
        className: 'add',
        textContent: '+ Add terminal',
        onclick: () => {
          let n = draft.panes.length + 1;
          while (draft.panes.some((p) => p.id === `pane-${n}`)) n += 1;
          const id = `pane-${n}`;
          draft.panes.push({ id, title: `Task ${n}`, task: '' } as PaneConfig);
          selected = id;
          renderList();
          renderForm();
        },
      }),
    );
  }

  function renderForm(): void {
    paneForm.replaceChildren();
    const pane = draft.panes.find((p) => p.id === selected);
    if (!pane) {
      paneForm.append(el('p', { className: 'muted', textContent: 'No terminal selected.' }));
      return;
    }

    const effectiveProfile = pane.profile ?? draft.defaults.profile;
    // Panes are free to point anywhere, so nothing stops two of them at the same folder.
    const sharedWith = draft.panes
      .filter((p) => p.id !== pane.id && resolvedWorkspace(p) === resolvedWorkspace(pane))
      .map((p) => p.title || p.id);
    // Mirrors resolvePanes(): a bare `command` in the JSON implies launch: 'command'.
    const effectiveLaunch: LaunchMode =
      pane.launch ??
      ((pane.command ?? draft.defaults.command)?.trim()
        ? 'command'
        : draft.defaults.launch ?? 'claude');
    const id = el('input', { value: pane.id });
    const title = el('input', { value: pane.title ?? '' });
    const profile = select(
      [
        { value: '', label: `inherit (${draft.defaults.profile})` },
        ...profileOptions(),
      ],
      pane.profile ?? '',
    );
    const distro = select(
      [{ value: '', label: 'inherit / default' }, ...distroOptions().slice(1)],
      pane.distro ?? '',
    );
    const workspace = el('input', {
      value: pane.workspace ?? '',
      placeholder: defaultWorkspace(pane.id),
    });
    const browse = el('button', {
      textContent: 'Browse…',
      title: 'Pick the folder this terminal works in',
      onclick: async () => {
        const picked = await window.mt.pickFolder(resolvedWorkspace(pane));
        if (!picked) return;
        workspace.value = picked;
        commit();
        renderForm();
      },
    });
    const paneTheme = themeField(
      'Theme',
      pane.theme ?? '',
      allThemes(),
      draft.defaults.theme ?? DEFAULT_THEME_ID,
    );
    const launch = select(LAUNCH_MODES, effectiveLaunch);
    const command = el('input', {
      value: pane.command ?? '',
      placeholder: draft.defaults.command || 'ls -la',
    });
    const task = el('textarea', { value: pane.task ?? '', rows: 8 });
    const model = el('input', { value: pane.model ?? '', placeholder: 'inherit' });
    const claudeArgs = el('textarea', { value: (pane.claudeArgs ?? []).join('\n'), rows: 3 });
    const claudeBin = el('input', { value: pane.claudeBin ?? '', placeholder: 'claude' });
    const env = el('textarea', { value: formatEnv(pane.env), rows: 3, placeholder: 'KEY=value' });
    const autoStart = el('input', {
      type: 'checkbox',
      checked: pane.autoStart ?? draft.defaults.autoStart,
    });
    const autoSubmit = el('input', {
      type: 'checkbox',
      checked: pane.autoSubmit ?? draft.defaults.autoSubmit,
    });
    const resume = el('input', {
      type: 'checkbox',
      checked: pane.resume ?? draft.defaults.resume ?? true,
    });

    const dk: DockerConfig = pane.docker ?? {};
    const dockerImage = comboInput(
      dk.image ?? '',
      localImageRefs(preflight?.docker ?? null),
      'claude-multitask:latest',
    );
    const dockerMode = select(
      [
        { value: 'run', label: 'run — start a fresh container per pane' },
        { value: 'exec', label: 'exec — attach to a running container' },
      ],
      dk.mode ?? 'run',
    );
    const dockerContainer = comboInput(
      dk.containerName ?? '',
      preflight?.docker.runningContainers ?? [],
      `mt-${pane.id}`,
    );
    const dockerWorkdir = el('input', { value: dk.workdir ?? '', placeholder: '/work' });
    const dockerShell = el('input', {
      value: (dk.shell ?? []).join(' '),
      placeholder: 'bash -l',
    });
    const dockerClaudeMode = select(CLAUDE_CONFIG_MODES, dk.claudeConfigMode ?? 'shared');
    const dockerClaudeHome = el('input', {
      value: dk.claudeHome ?? '',
      placeholder: '/root/.claude',
    });
    const dockerUser = el('input', {
      value: dk.user ?? '',
      placeholder: window.mt.platform === 'linux' ? 'you (host uid:gid)' : 'image default',
    });
    const dockerExtra = el('textarea', {
      value: (dk.extraArgs ?? []).join('\n'),
      rows: 3,
      placeholder: '--network=none\n--memory=4g',
    });

    // Write straight back into the draft so switching panes never loses an edit.
    const commit = () => {
      const nextId = id.value.trim();
      if (nextId && nextId !== pane.id && !draft.panes.some((p) => p.id === nextId)) {
        // The default folder is derived from the id, so renaming a pane that never chose
        // one would quietly point it at an empty directory. Pin the old one first.
        if (!pane.workspace && !workspace.value.trim()) {
          pane.workspace = defaultWorkspace(pane.id);
          workspace.value = pane.workspace;
        }
        pane.id = nextId;
        selected = nextId;
      }
      pane.title = title.value;
      pane.profile = (profile.value || undefined) as ProfileId | undefined;
      pane.distro = distro.value || undefined;
      pane.workspace = workspace.value.trim() || undefined!;
      pane.theme = paneTheme.select.value || undefined;
      pane.launch = launch.value as LaunchMode;
      pane.command = command.value.trim() || undefined;
      pane.task = task.value;
      pane.model = model.value.trim() || undefined;
      pane.claudeArgs = linesToArray(claudeArgs.value);
      pane.claudeBin = claudeBin.value.trim() || undefined;
      pane.env = parseEnv(env.value);
      pane.autoStart = autoStart.checked;
      pane.autoSubmit = autoSubmit.checked;
      pane.resume = resume.checked;

      // Only keep the fields that were actually set, so the JSON stays readable and
      // unset fields keep inheriting from defaults.
      const docker: DockerConfig = {};
      if (dockerImage.input.value.trim()) docker.image = dockerImage.input.value.trim();
      if (dockerMode.value !== 'run') docker.mode = 'exec';
      if (dockerContainer.input.value.trim())
        docker.containerName = dockerContainer.input.value.trim();
      if (dockerWorkdir.value.trim()) docker.workdir = dockerWorkdir.value.trim();
      const shellArgv = dockerShell.value.trim().split(/\s+/).filter(Boolean);
      if (shellArgv.length) docker.shell = shellArgv;
      if (dockerClaudeMode.value !== 'shared')
        docker.claudeConfigMode = dockerClaudeMode.value as ClaudeConfigMode;
      if (dockerClaudeHome.value.trim()) docker.claudeHome = dockerClaudeHome.value.trim();
      if (dockerUser.value.trim()) docker.user = dockerUser.value.trim();
      const extra = linesToArray(dockerExtra.value);
      if (extra.length) docker.extraArgs = extra;
      pane.docker = Object.keys(docker).length ? docker : undefined;
    };
    for (const node of [
      id,
      title,
      profile,
      distro,
      workspace,
      paneTheme.select,
      command,
      task,
      model,
      claudeArgs,
      claudeBin,
      env,
      autoStart,
      autoSubmit,
      resume,
      dockerImage.input,
      dockerMode,
      dockerContainer.input,
      dockerWorkdir,
      dockerShell,
      dockerClaudeMode,
      dockerClaudeHome,
      dockerUser,
      dockerExtra,
    ]) {
      node.addEventListener('change', () => {
        commit();
        renderList();
      });
    }
    // These decide which sections are shown, or what the form has to warn about, so a
    // change to any of them has to redraw rather than only update the draft.
    for (const node of [profile, launch, workspace, dockerMode, dockerClaudeMode]) {
      node.addEventListener('change', () => {
        commit();
        renderForm();
      });
    }

    function dockerSection(): HTMLElement[] {
      const engine = preflight?.docker;
      const exec = dockerMode.value === 'exec';
      return [
        el('h3', { textContent: 'Container' }),
        el('p', { className: engine?.error ? 'warn' : 'muted' }, [
          engine?.error ?? `Docker engine ${engine?.serverVersion ?? '?'} reachable.`,
        ]),
        el('div', { className: 'row' }, [
          exec
            ? field('Container name', dockerContainer.node, 'A container that is already running.')
            : field('Image', dockerImage.node, 'Must exist locally — see Docker images.'),
          field('Mode', dockerMode),
        ]),
        el('div', { className: 'row' }, [
          field('Mount point / workdir', dockerWorkdir, 'The pane folder is mounted here.'),
          field('Shell', dockerShell),
        ]),
        el('div', { className: 'row' }, [
          field('Claude credentials', dockerClaudeMode),
          field('Claude home in container', dockerClaudeHome, 'Depends on the image’s user.'),
        ]),
        el('div', { className: 'row' }, [
          field(
            'Run as user',
            dockerUser,
            window.mt.platform === 'linux'
              ? 'Blank runs as you, so files stay yours. "root" to install packages.'
              : 'docker run --user, e.g. 1000:1000. Blank uses the image’s user.',
          ),
          field('Extra docker arguments', dockerExtra, 'One per line.'),
        ]),
        ...(dockerClaudeMode.value === 'shared'
          ? [
              el('p', { className: 'warn' }, [
                'Shared mode gives the container read and write access to your host Claude ' +
                  'credentials and config. Use "copy" to isolate panes, or "none" with an API key.',
              ]),
            ]
          : []),
      ];
    }

    paneForm.append(
      el('h3', { textContent: 'Terminal' }),
      el('div', { className: 'row' }, [
        field('Id', id, 'Letters, digits, dot, dash, underscore.'),
        field('Title', title),
      ]),
      el('div', { className: 'row' }, [
        field('Shell', profile),
        ...(effectiveProfile === 'wsl' ? [field('WSL distro', distro)] : []),
      ]),
      ...(effectiveProfile === 'docker' ? dockerSection() : []),
      el('div', { className: 'row workspace-row' }, [
        field(
          'Working folder',
          workspace,
          'Any folder on disk. Empty means the default, ' + defaultWorkspace(pane.id) + '.',
        ),
        el('label', { className: 'field' }, [el('span', { textContent: ' ' }), browse]),
      ]),
      el('p', { className: sharedWith.length ? 'warn' : 'muted' }, [
        sharedWith.length
          ? `Also used by ${sharedWith.join(', ')}. Two Claude sessions editing one folder ` +
            'will overwrite each other.'
          : resolvedWorkspace(pane),
      ]),
      paneTheme.node,
      el('div', { className: 'row' }, [
        field('Start with', launch),
        ...(effectiveLaunch === 'command'
          ? [field('Command', command, 'Typed into the shell exactly as written.')]
          : []),
      ]),
      ...(effectiveLaunch === 'shell'
        ? []
        : [
            field(
              effectiveLaunch === 'claude' ? 'Task prompt' : 'Text to send after it starts',
              task,
              effectiveLaunch === 'claude'
                ? 'Sent to Claude Code once its prompt is ready.'
                : 'Optional. Sent once the command’s output settles — leave empty for one-shot commands.',
            ),
          ]),
      ...(effectiveLaunch === 'claude'
        ? [
            el('div', { className: 'row' }, [
              field('Model', model),
              field('claude executable', claudeBin),
            ]),
            field(
              'claude arguments',
              claudeArgs,
              'One per line, e.g. --permission-mode / acceptEdits.',
            ),
          ]
        : []),
      field('Environment', env, 'KEY=value per line.'),
      el('div', { className: 'row' }, [
        field('Auto-start', autoStart),
        ...(effectiveLaunch === 'shell' ? [] : [field('Auto-submit prompt', autoSubmit)]),
        ...(effectiveLaunch === 'claude' ? [field('Resume on restart', resume)] : []),
      ]),
    );
  }

  const footer = el('footer', { className: 'modal-foot' }, [
    el('span', { className: 'muted', textContent: 'Changes are written to multitask.config.json.' }),
    el('span', { className: 'spacer' }),
    el('button', { textContent: 'Cancel', onclick: close }),
    el('button', {
      className: 'primary',
      textContent: 'Apply',
      onclick: async () => {
        readGlobals();
        const ids = draft.panes.map((p) => p.id);
        const bad = ids.find((v) => !/^[A-Za-z0-9._-]+$/.test(v));
        if (bad !== undefined) {
          alertBar(`Invalid id "${bad}".`);
          return;
        }
        if (new Set(ids).size !== ids.length) {
          alertBar('Terminal ids must be unique.');
          return;
        }
        const noCommand = draft.panes.find(
          (p) => p.launch === 'command' && !(p.command ?? draft.defaults.command)?.trim(),
        );
        if (noCommand) {
          alertBar(`Terminal "${noCommand.title || noCommand.id}" is set to run a command but none is set.`);
          return;
        }
        await onSave(draft);
        close();
      },
    }),
  ]);

  const alert = el('div', { className: 'modal-alert hidden' });
  const alertBar = (msg: string) => {
    alert.textContent = msg;
    alert.classList.remove('hidden');
  };

  modal.append(
    el('header', { className: 'modal-head' }, [
      el('h2', { textContent: 'Settings' }),
      el('span', { className: 'spacer' }),
      el('button', { className: 'icon', textContent: '✕', onclick: close }),
    ]),
    alert,
    el('div', { className: 'modal-body' }, [
      el('div', { className: 'modal-left' }, [globalPanel, el('h3', { textContent: 'Terminals' }), paneList]),
      el('div', { className: 'modal-right' }, [paneForm]),
    ]),
    footer,
  );

  renderList();
  renderForm();

  overlay.append(modal);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}
