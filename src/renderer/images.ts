import { RECOMMENDED_BASES, type DockerStatus } from '../shared/types.js';
import { comboInput, el, field, modal } from './dom.js';

/**
 * Docker image manager: check the engine, build the bundled Dockerfile on a chosen base,
 * pull a ready-made image, or load one from a .tar archive. Output streams into the log
 * pane so a long build is not a blank wait.
 */
export function openImagesDialog(onChanged?: (status: DockerStatus) => void): void {
  const statusLine = el('p', { className: 'muted', textContent: 'Checking Docker…' });
  const imagesBox = el('div', { className: 'image-list' });
  const log = el('pre', { className: 'log' });

  function appendLog(line: string) {
    log.append(line + '\n');
    log.scrollTop = log.scrollHeight;
  }

  const stopLog = window.mt.onDockerLog(({ line }) => appendLog(line));
  const { overlay, body, footer, alert, close } = modal('Docker images', stopLog);
  let busy = false;

  const buttons: HTMLButtonElement[] = [];
  const setBusy = (value: boolean) => {
    busy = value;
    for (const b of buttons) b.disabled = value;
  };

  const track = <T extends HTMLButtonElement>(b: T): T => {
    buttons.push(b);
    return b;
  };

  async function refresh(): Promise<void> {
    const status = await window.mt.dockerStatus();
    statusLine.className = status.error ? 'warn' : 'muted';
    statusLine.textContent = status.error
      ? status.error
      : `Docker CLI ${status.cliVersion} · engine ${status.serverVersion} · ${status.images.length} local image(s)`;

    imagesBox.replaceChildren();
    if (!status.images.length) {
      imagesBox.append(
        el('p', {
          className: 'muted',
          textContent: status.error ? '' : 'No local images yet. Build or pull one below.',
        }),
      );
    }
    for (const image of status.images) {
      imagesBox.append(
        el('div', { className: 'image-row' }, [
          el('code', { textContent: image.ref }),
          el('span', { className: 'muted', textContent: `${image.size} · ${image.created}` }),
          el('span', { className: 'spacer' }),
          track(
            el('button', {
              className: 'icon',
              textContent: 'Use',
              title: 'Copy this reference into the build/pull fields',
              onclick: () => {
                pull.input.value = image.ref;
                tag.value = image.ref;
              },
            }),
          ),
        ]),
      );
    }
    onChanged?.(status);
  }

  // ---- build ----
  const base = comboInput(
    RECOMMENDED_BASES[0].image,
    RECOMMENDED_BASES.map((b) => b.image),
    'base image',
  );
  const tag = el('input', { value: 'claude-multitask:latest' });
  const buildBtn = track(
    el('button', {
      className: 'primary',
      textContent: 'Build',
      onclick: async () => {
        if (busy) return;
        const baseRef = base.input.value.trim();
        const tagRef = tag.value.trim();
        if (!baseRef || !tagRef) return alert('A base image and a tag are both required.');
        alert('');
        setBusy(true);
        appendLog(`\n--- building ${tagRef} from ${baseRef} ---`);
        const ok = await window.mt.dockerBuild(tagRef, baseRef);
        setBusy(false);
        if (!ok) alert('The build failed. The log below has the details.');
        await refresh();
      },
    }),
  );

  // ---- pull ----
  const pull = comboInput('', [...RECOMMENDED_BASES.map((b) => b.image)], 'image reference');
  const pullBtn = track(
    el('button', {
      textContent: 'Pull',
      onclick: async () => {
        if (busy) return;
        const ref = pull.input.value.trim();
        if (!ref) return alert('Enter an image reference to pull.');
        alert('');
        setBusy(true);
        appendLog(`\n--- pulling ${ref} ---`);
        const ok = await window.mt.dockerPull(ref);
        setBusy(false);
        if (!ok) alert('The pull failed. The log below has the details.');
        await refresh();
      },
    }),
  );

  // ---- load from archive ----
  const loadBtn = track(
    el('button', {
      textContent: 'Choose .tar…',
      onclick: async () => {
        if (busy) return;
        const file = await window.mt.pickTarFile();
        if (!file) return;
        alert('');
        setBusy(true);
        appendLog(`\n--- loading ${file} ---`);
        const ok = await window.mt.dockerLoad(file);
        setBusy(false);
        if (!ok) alert('The load failed. The log below has the details.');
        await refresh();
      },
    }),
  );

  const refreshBtn = track(
    el('button', { textContent: 'Refresh', onclick: () => void refresh() }),
  );

  body.classList.add('single');
  body.append(
    el('div', { className: 'modal-left wide' }, [
      statusLine,

      el('h3', { textContent: 'Build an image for Claude Code' }),
      el('p', { className: 'muted' }, [
        'The bundled Dockerfile adds Claude Code, git and ripgrep to a base image, and ' +
          'installs Node 22 when the base has none. Any Debian or Ubuntu based image works.',
      ]),
      el('div', { className: 'row' }, [
        field('Base image', base.node),
        field('Tag to create', tag),
        el('label', { className: 'field' }, [el('span', { textContent: ' ' }), buildBtn]),
      ]),
      el(
        'div',
        { className: 'bases' },
        RECOMMENDED_BASES.map((b) =>
          el('div', { className: 'base-row' }, [
            el('button', {
              className: 'icon',
              textContent: b.image,
              title: 'Use as the base image',
              onclick: () => {
                base.input.value = b.image;
              },
            }),
            el('small', { className: 'muted', textContent: b.note }),
          ]),
        ),
      ),

      el('h3', { textContent: 'Pull or load an existing image' }),
      el('div', { className: 'row' }, [
        field('Image reference', pull.node, 'Anything docker pull accepts.'),
        el('label', { className: 'field' }, [el('span', { textContent: ' ' }), pullBtn]),
        el('label', { className: 'field' }, [
          el('span', { textContent: 'From an archive' }),
          loadBtn,
        ]),
      ]),

      el('h3', { textContent: 'Local images' }),
      imagesBox,

      el('h3', { textContent: 'Output' }),
      log,
    ]),
  );

  footer.append(
    el('span', {
      className: 'muted',
      textContent: 'A pane can only use an image that is listed above.',
    }),
    el('span', { className: 'spacer' }),
    refreshBtn,
    el('button', { className: 'primary', textContent: 'Close', onclick: close }),
  );

  document.body.append(overlay);
  void refresh();
}

export function localImageRefs(status: DockerStatus | null): string[] {
  return status?.images.map((i) => i.ref) ?? [];
}
