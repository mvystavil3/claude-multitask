import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * A macOS or Linux app started from Finder, the Dock or a desktop launcher inherits a bare
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one the user's shell builds. Homebrew,
 * npm's global bin, `~/.local/bin` and Docker Desktop's CLI all live outside it, so
 * `claude` and `docker` would look missing even though every terminal finds them.
 *
 * Ask the user's own login shell for its PATH once at startup and put its entries first.
 * `printenv` rather than `echo $PATH` so fish, which stores PATH as a list, answers in the
 * same colon-separated form as bash and zsh.
 */
export function adoptLoginShellPath(timeoutMs = 5000): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const marker = '__MULTITASK_PATH__';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `echo ${marker}; printenv PATH; echo ${marker}`],
      // Keep oh-my-zsh and friends from stopping to ask about updates.
      { timeout: timeoutMs, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (_err, stdout) => {
        // An rc file that prints or fails still usually gets as far as the markers.
        const match = new RegExp(`${marker}\\s*\\n([^\\n]*)\\n\\s*${marker}`).exec(
          String(stdout ?? ''),
        );
        if (match?.[1]) {
          const merged = [...match[1].split(':'), ...(process.env.PATH ?? '').split(':')];
          process.env.PATH = [...new Set(merged.filter(Boolean))].join(path.delimiter);
        }
        resolve();
      },
    );
  });
}
