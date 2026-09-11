import * as fs from 'fs';
import * as path from 'path';
import { looksLikeClaudeConfigDir } from './discovery';

export interface DeletionCheck {
  safe: boolean;
  /** Why deletion was refused, for showing to the user. */
  reason?: string;
}

/**
 * Decides whether a folder may be deleted from disk.
 *
 * Deleting credentials must never be able to take a project with it, so this
 * refuses anything that is not recognisably a Claude configuration folder,
 * plus the obvious catastrophes: a drive root, a home directory, a path
 * holding a source repository.
 *
 * A profile pointed at the user's main ~/.claude is also refused: that is the
 * real Claude Code installation, not a folder this extension created.
 */
export function checkSafeToDelete(dir: string, mainConfigDir: string): DeletionCheck {
  const given = path.resolve(dir);

  if (!fs.existsSync(given)) {
    return { safe: false, reason: 'The folder no longer exists.' };
  }

  // Symlinks are resolved before anything is judged, because `path.resolve`
  // does not follow them: a profile pointed at a link to the home folder would
  // otherwise pass every check below while the deletion followed the link. A
  // profile folder is a real directory, so refusing links outright costs
  // nothing and removes the whole class of problem.
  if (fs.lstatSync(given).isSymbolicLink()) {
    return {
      safe: false,
      reason: 'That path is a shortcut to somewhere else, so what would be deleted is not what it names.'
    };
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(given);
  } catch {
    return { safe: false, reason: 'The folder could not be read.' };
  }

  if (!fs.statSync(resolved).isDirectory()) {
    return { safe: false, reason: 'That path is not a folder.' };
  }

  // A drive root or filesystem root has no parent segment beyond itself.
  const parsed = path.parse(resolved);
  if (parsed.root === resolved) {
    return { safe: false, reason: 'That is a drive root.' };
  }

  const home = path.resolve(require('os').homedir());
  if (resolved.toLowerCase() === home.toLowerCase()) {
    return { safe: false, reason: 'That is your home folder.' };
  }

  if (resolved.toLowerCase() === path.resolve(mainConfigDir).toLowerCase()) {
    return {
      safe: false,
      reason:
        'That is the main Claude Code configuration on this machine, not a folder created for a profile. Remove the profile from the list instead.'
    };
  }

  // A source repository, editor workspace or package means this is someone's
  // project directory, whatever else it may also contain.
  for (const marker of ['.git', '.vscode', 'package.json', 'src']) {
    if (fs.existsSync(path.join(resolved, marker))) {
      return {
        safe: false,
        reason: `The folder contains "${marker}", so it looks like a project rather than a credentials folder.`
      };
    }
  }

  if (!looksLikeClaudeConfigDir(resolved)) {
    return {
      safe: false,
      reason: 'The folder does not contain a Claude configuration, so it may not be what you think it is.'
    };
  }

  return { safe: true };
}

/**
 * Permanently removes a profile's credentials folder.
 *
 * The safety check is repeated here rather than trusted to the caller. This is
 * a recursive force delete of a path that came out of a settings file: if some
 * future call site forgets the check, the failure is silent, total, and on
 * someone else's machine. Checking twice costs a stat; not checking costs a
 * home directory.
 */
export function deleteConfigFolder(dir: string, mainConfigDir: string): void {
  const check = checkSafeToDelete(dir, mainConfigDir);
  if (!check.safe) {
    throw new Error(check.reason ?? 'Refused to delete that folder.');
  }
  const root = fs.realpathSync(path.resolve(dir));

  // First barrier: the links to the user's installation go before anything
  // else, one by one, and if any of them is still there nothing is deleted.
  // The walk below would not enter one either; this makes sure it never has
  // the chance.
  for (const entry of fs.readdirSync(root)) {
    const p = path.join(root, entry);
    if (!fs.lstatSync(p).isSymbolicLink()) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      try {
        fs.rmdirSync(p);
      } catch {
        // Checked just below.
      }
    }
  }
  const stillLinked = fs.readdirSync(root).filter((e) => fs.lstatSync(path.join(root, e)).isSymbolicLink());
  if (stillLinked.length > 0) {
    throw new Error(`Refused to delete: could not remove the links ${stillLinked.join(', ')} first.`);
  }

  removeTree(root);
}

/**
 * Deletes a folder without ever going through a link inside it.
 *
 * An account folder holds links — junctions on Windows — to the user's own
 * `~/.claude/plugins`, `skills` and `settings.json`. `fs.rmSync` with
 * `recursive` goes through those junctions in VS Code's runtime (Electron) —
 * not in plain Node, which is why testing outside VS Code said it was safe —
 * and empties what they point to. It deleted the user's installed plugins that
 * way, stopping only at the first file it could not remove.
 *
 * So the walk is ours. Every entry is judged by `lstat`, which does not follow
 * links, and by where it really resolves; anything that is a link, or that
 * resolves outside the folder being deleted, is removed as an entry — the link
 * itself — and never entered. The first error is thrown once everything that
 * could be removed has been.
 */
function removeTree(root: string): void {
  const rootReal = fs.realpathSync(root);
  const inside = (p: string) => {
    try {
      const real = fs.realpathSync(p);
      return real === rootReal || real.toLowerCase().startsWith(rootReal.toLowerCase() + path.sep);
    } catch {
      return false;
    }
  };
  let firstError: unknown;
  const remember = (err: unknown) => {
    if (firstError === undefined) firstError = err;
  };

  const removeLink = (p: string) => {
    // A file symlink goes with unlink; a directory link or junction with a
    // non-recursive rmdir, which removes the link and cannot touch its target.
    try {
      fs.unlinkSync(p);
    } catch {
      try {
        fs.rmdirSync(p);
      } catch (err) {
        remember(err);
      }
    }
  };

  const walk = (p: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(p);
    } catch (err) {
      remember(err);
      return;
    }
    if (stat.isSymbolicLink() || (stat.isDirectory() && p !== root && !inside(p))) {
      removeLink(p);
      return;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(p);
      } catch (err) {
        remember(err);
      }
      for (const entry of entries) walk(path.join(p, entry));
      try {
        fs.rmdirSync(p);
      } catch (err) {
        remember(err);
      }
      return;
    }
    try {
      fs.unlinkSync(p);
    } catch (err) {
      remember(err);
    }
  };

  walk(root);
  if (firstError !== undefined) throw firstError;
}
