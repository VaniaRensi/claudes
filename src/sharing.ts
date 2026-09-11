import * as fs from 'fs';
import * as path from 'path';

/**
 * Sharing a working environment between accounts.
 *
 * Only credentials make two accounts different in the way that matters: who
 * pays. Everything else in a config folder — permissions granted over months,
 * MCP servers, skills, plugins, project history — is the user's working setup,
 * and a switch that silently drops it turns "bill this client" into "start from
 * nothing", which is not what anyone asked for.
 *
 * So these entries are linked to the main installation rather than left empty.
 * The credentials file is deliberately not among them: sharing that would undo
 * the entire point.
 */
export const SHAREABLE = [
  'settings.json',
  'plugins',
  'skills',
  'mcp-needs-auth-cache.json',
  'CLAUDE.md'
] as const;

/** Never shared: these are what make an account a separate account. */
export const NEVER_SHARED = ['.credentials.json', '.claude.json', 'sessions', 'projects', 'history.jsonl'];

export interface ShareResult {
  linked: string[];
  copied: string[];
  failed: { entry: string; reason: string }[];
}

function isLink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Links each shareable entry from the main config dir into a profile's folder.
 *
 * Junctions are used for directories because Windows allows them without
 * administrator rights, unlike directory symlinks under default settings. When
 * a link cannot be made at all, the entry is copied instead: an out-of-date copy
 * of someone's permissions is worth more than no permissions.
 */
export function shareSettings(mainConfigDir: string, profileDir: string): ShareResult {
  const result: ShareResult = { linked: [], copied: [], failed: [] };

  for (const entry of SHAREABLE) {
    const source = path.join(mainConfigDir, entry);
    const target = path.join(profileDir, entry);

    if (!fs.existsSync(source)) continue;
    // Already linked: nothing to do.
    if (isLink(target)) continue;

    // Something real is already there. It is the user's, so it is left alone
    // rather than replaced by a link to somewhere else.
    if (fs.existsSync(target)) {
      result.failed.push({ entry, reason: 'already exists in the account folder' });
      continue;
    }

    const isDir = fs.statSync(source).isDirectory();

    try {
      fs.symlinkSync(source, target, isDir ? 'junction' : 'file');
      result.linked.push(entry);
      continue;
    } catch {
      // Fall through to copying.
    }

    try {
      fs.cpSync(source, target, { recursive: isDir });
      result.copied.push(entry);
    } catch (err) {
      result.failed.push({ entry, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/** Removes the links again, leaving the account with its own empty environment. */
export function unshareSettings(profileDir: string): string[] {
  const removed: string[] = [];

  for (const entry of SHAREABLE) {
    const target = path.join(profileDir, entry);
    // Only links are removed. Anything real in there is the account's own and
    // deleting it would destroy work this function never created.
    if (isLink(target)) {
      try {
        fs.unlinkSync(target);
        removed.push(entry);
      } catch {
        // Leave it; reporting a partial result is better than throwing here.
      }
    }
  }

  return removed;
}

/** True when this profile is currently sharing the main installation's setup. */
export function isSharing(profileDir: string): boolean {
  return SHAREABLE.some((entry) => isLink(path.join(profileDir, entry)));
}

/**
 * Keys inside .claude.json that describe the user's work, not their account.
 *
 * This file is the one Claude Code actually reads for per-project settings, and
 * it mixes two unrelated things: which MCP servers a project uses, and which
 * account is signed in. Linking the whole file would hand one account's login to
 * another, so these keys are copied across and everything else — oauthAccount,
 * userID and the rest — is left as each account's own.
 */
const SHAREABLE_JSON_KEYS = ['projects', 'mcpServers'] as const;

/** Where Claude Code keeps per-project settings for a given config dir. */
function projectFile(configDir: string): string {
  return path.join(configDir, '.claude.json');
}

export interface ProjectSyncResult {
  projects: number;
  mcpServers: number;
  error?: string;
}

/**
 * Copies projects and MCP server definitions from the main installation into a
 * profile, without touching which account that profile is signed in as.
 *
 * A copy rather than a link, precisely because the file is shared with the
 * login: the two cannot travel together. It runs on every switch, so a project
 * or server added under one account reaches the others.
 *
 * Everything else in the file belongs to that account and must survive: the
 * login, and the answers Claude Code has already been given. Those answers are
 * why this needs care — Claude Code asks its onboarding questions once and
 * records the reply in this same file, so a sync that dropped or staled a key
 * made the user answer the browser question again on an account where they had
 * already said no. It looked like the extension forgetting a setting; it was
 * this write landing on top of Claude Code's.
 *
 * The file is therefore re-read immediately before writing, inside the same
 * function, rather than reusing anything read earlier: between a switch
 * starting and this line, Claude Code may have written an answer of its own,
 * and the copy in hand would put the file back the way it was before.
 */
export function syncProjectSettings(mainConfigDir: string, profileDir: string): ProjectSyncResult {
  const source = projectFile(mainConfigDir);
  const target = projectFile(profileDir);

  if (!fs.existsSync(source)) return { projects: 0, mcpServers: 0 };

  try {
    const from = JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;

    // Read last, not earlier: this is the copy the write is built on, so it has
    // to be the newest one on disk.
    const to: Record<string, unknown> = fs.existsSync(target)
      ? (JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>)
      : {};

    let changed = false;
    for (const key of SHAREABLE_JSON_KEYS) {
      if (from[key] === undefined) continue;
      const next =
        key === 'projects'
          ? mergeProjectPaths(combineProjects(from[key] as ProjectMap, (to[key] as ProjectMap) ?? {}))
          : { ...((to[key] as object) ?? {}), ...(from[key] as object) };
      if (JSON.stringify(to[key]) !== JSON.stringify(next)) {
        to[key] = next;
        changed = true;
      }
    }

    // Nothing of ours differs, so there is nothing to write. Skipping the write
    // removes the whole race for the common case: most switches change no
    // projects and no servers, and every write here is a chance to land on top
    // of an answer Claude Code has just saved.
    if (!changed) {
      return {
        projects: Object.keys((from.projects as object) ?? {}).length,
        mcpServers: Object.keys((from.mcpServers as object) ?? {}).length
      };
    }

    // Written via a temporary file: a half-written .claude.json would leave the
    // account unable to start at all.
    const tmp = `${target}.claudes-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(to, null, 2), 'utf8');
    fs.renameSync(tmp, target);

    return {
      projects: Object.keys((from.projects as object) ?? {}).length,
      mcpServers: Object.keys((from.mcpServers as object) ?? {}).length
    };
  } catch (err) {
    return { projects: 0, mcpServers: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Where the live .claude.json is.
 *
 * Claude Code keeps it beside the config directory, not inside it: with the
 * default ~/.claude that means ~/.claude.json. A stale copy is often left inside
 * the folder as well, and it is not reliably the older of the two — so the
 * choice is made on which file actually holds the user's projects, not on
 * timestamps. Picking wrong means copying an empty project list over a full one
 * and concluding the user has no MCP servers.
 */
export function liveProjectFileFor(configDir: string): string {
  const inside = projectFile(configDir);
  const beside = path.join(path.dirname(configDir), '.claude.json');

  const count = (file: string): number => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects?: object };
      return Object.keys(parsed.projects ?? {}).length;
    } catch {
      return -1;
    }
  };

  const insideCount = count(inside);
  const besideCount = count(beside);

  if (besideCount < 0) return inside;
  if (insideCount < 0) return beside;

  // Equal counts fall to the one beside the folder: that is the documented
  // location, and the copy inside is the leftover.
  return besideCount >= insideCount ? beside : inside;
}

type ProjectMap = Record<string, Record<string, unknown>>;

/**
 * The main installation's projects laid under the account's own, never over.
 *
 * The sync used to replace the account's list with the main one. A folder only
 * ever opened under an account — a new client's project — is not in the main
 * list, so every sync erased it: Claude Code asked to trust the folder again
 * each time a terminal opened, and forgot the permissions granted there.
 *
 * Now each project keeps what the account recorded, and gains only what the
 * main installation knows and the account does not. Two exceptions, both so the
 * main installation can still hand something on: MCP servers are pooled rather
 * than one list replacing the other, and a folder trusted in either place counts
 * as trusted — it is the same person answering the same question.
 */
function combineProjects(main: ProjectMap, account: ProjectMap): ProjectMap {
  const combined: ProjectMap = { ...account };
  for (const [key, fromMain] of Object.entries(main)) {
    const own = account[key];
    if (!own) {
      combined[key] = fromMain;
      continue;
    }
    const entry: Record<string, unknown> = { ...fromMain, ...own };
    if (fromMain.mcpServers || own.mcpServers) {
      entry.mcpServers = { ...((fromMain.mcpServers as object) ?? {}), ...((own.mcpServers as object) ?? {}) };
    }
    if (fromMain.hasTrustDialogAccepted === true) entry.hasTrustDialogAccepted = true;
    combined[key] = entry;
  }
  return combined;
}

/**
 * Merges project entries that differ only by the case of the drive letter.
 *
 * Windows treats "c:/Work" and "C:/Work" as the same folder; Claude Code stores
 * them as two projects, each with its own MCP state. Opening the folder then
 * lands on whichever spelling VS Code used, which may be the half with no MCP
 * servers connected — the tools look configured and simply do not appear.
 *
 * This is not something ClaudeS causes, but it does copy these entries between
 * accounts, and copying a split project would spread the problem. The variants
 * are folded together, later keys winning, so each folder appears once.
 */
function mergeProjectPaths(projects: ProjectMap): ProjectMap {
  const byNormalised = new Map<string, { key: string; value: Record<string, unknown> }>();

  for (const [key, value] of Object.entries(projects)) {
    const normalised = key.split('\\').join('/').toLowerCase();
    const existing = byNormalised.get(normalised);

    if (!existing) {
      byNormalised.set(normalised, { key, value });
      continue;
    }

    // Same folder, two spellings: combine them rather than letting one win and
    // silently drop the other's servers. The entry the user has actually
    // trusted supplies the surviving key — Claude Code will not load MCP
    // servers for a project whose trust dialog was never accepted, so keeping
    // the untrusted spelling would merge the servers and still not start them.
    const merged = { ...existing.value, ...value };
    const keep = value.hasTrustDialogAccepted === true ? key : existing.key;
    byNormalised.set(normalised, { key: keep, value: merged });
  }

  const merged: ProjectMap = {};
  for (const { key, value } of byNormalised.values()) merged[key] = value;
  return merged;
}

/**
 * Copies a login out of one config folder into a new account of ours.
 *
 * Only the credentials travel. The working environment — settings, skills,
 * plugins, MCP servers — is shared by link afterwards, so it stays one setup
 * rather than becoming a copy that drifts; and the conversation history stays
 * where it is, because an account created to bill a client has no business
 * holding someone else's transcripts.
 *
 * Copied, never moved, and the source is opened read-only. Claude Code's own
 * folder must be exactly as it was when ClaudeS is uninstalled: it is another
 * program's data, and the user is still signed in to it. Nothing here writes to
 * the source at all.
 */
export function cloneLogin(fromConfigDir: string, toConfigDir: string): { copied: string[] } {
  const copied: string[] = [];

  // Never over another login. Whatever is already there belongs to some
  // account, and a login overwritten is one the user has to sign in to again.
  if (fs.existsSync(path.join(toConfigDir, '.credentials.json'))) {
    throw new Error(`${toConfigDir} already holds a login, so it was not overwritten.`);
  }

  fs.mkdirSync(toConfigDir, { recursive: true });

  // `.credentials.json` is the login. `.claude.json` carries the account
  // identity beside per-project settings, so it comes too — the projects list
  // in it is harmless, and without it Claude Code treats the folder as a fresh
  // install and asks its onboarding questions again.
  for (const entry of ['.credentials.json', '.claude.json']) {
    const source = path.join(fromConfigDir, entry);
    if (!fs.existsSync(source)) continue;

    const target = path.join(toConfigDir, entry);
    // Through a temporary name, so an interrupted copy cannot leave a
    // half-written credentials file that reads as a corrupt login.
    const tmp = `${target}.claudes-tmp`;
    fs.copyFileSync(source, tmp);
    fs.renameSync(tmp, target);
    copied.push(entry);
  }

  return { copied };
}
