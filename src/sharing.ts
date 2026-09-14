import * as fs from 'fs';
import * as path from 'path';

/**
 * Sharing a working environment between accounts.
 *
 * Two things make accounts different: who pays, and what was said. The login
 * and every conversation — transcripts, history, memory, running sessions —
 * stay in each account's folder and never cross; the accounts belong to
 * different companies. The working setup — permissions granted over months,
 * MCP servers, skills, plugins — is the user's configuration, and a switch that
 * silently dropped it would turn "bill this client" into "start from nothing".
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

  try {
    // No main file means nothing to copy, not nothing to clean.
    const from = fs.existsSync(source)
      ? (JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>)
      : {};

    // Read last, not earlier: this is the copy the write is built on, so it has
    // to be the newest one on disk.
    const to: Record<string, unknown> = fs.existsSync(target)
      ? (JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>)
      : {};

    let changed = false;
    for (const key of SHAREABLE_JSON_KEYS) {
      // Projects are gone through even when the main installation lists none:
      // cleaning out conversations that are not this account's is not
      // conditional on there being anything to copy.
      if (from[key] === undefined && (key !== 'projects' || to[key] === undefined)) continue;
      const next =
        key === 'projects'
          ? alignSpellings(
              combineProjects(
                (from[key] as ProjectMap) ?? {},
                (to[key] as ProjectMap) ?? {},
                conversationsIn(profileDir)
              )
            )
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
 * Now each project keeps what the account recorded, and gains only the
 * main installation's settings the account does not have. Two exceptions, both
 * so the main installation can still hand something on: MCP servers are pooled
 * rather than one list replacing the other, and a folder trusted in either
 * place counts as trusted — it is the same person answering the same question.
 *
 * Only settings travel. A project entry also describes the last conversation
 * held in that folder — its first prompt, its id, its cost and tokens — and
 * copying whole entries put one company's prompt into another company's
 * account. What the account holds about a conversation that is not its own is
 * removed here as well, which also cleans what earlier versions copied.
 */
function combineProjects(main: ProjectMap, account: ProjectMap, ownConversations: Set<string>): ProjectMap {
  const combined: ProjectMap = {};
  for (const [key, entry] of Object.entries(account)) {
    combined[key] = withoutForeignConversation(entry, ownConversations);
  }
  for (const [key, fromMain] of Object.entries(main)) {
    const shared = settingsOf(fromMain);
    const own = combined[key];
    if (!own) {
      combined[key] = shared;
      continue;
    }
    const entry: Record<string, unknown> = { ...shared, ...own };
    if (shared.mcpServers || own.mcpServers) {
      entry.mcpServers = { ...((shared.mcpServers as object) ?? {}), ...((own.mcpServers as object) ?? {}) };
    }
    if (shared.hasTrustDialogAccepted === true) entry.hasTrustDialogAccepted = true;
    combined[key] = entry;
  }
  return combined;
}

/**
 * The keys of a project entry that are settings: what the user allowed, which
 * MCP servers the folder uses, whether the folder is trusted. Everything else
 * in an entry — `lastSessionId`, `lastSessionFirstPrompt`, `lastCost`, token
 * counts — describes a conversation, and a conversation belongs to the account
 * that had it. A key Claude Code adds in future stays behind until it is
 * listed here: unknown is treated as content.
 */
const PROJECT_SETTING_KEYS = [
  'allowedTools',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'mcpContextUris',
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown'
];

function settingsOf(entry: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const key of PROJECT_SETTING_KEYS) {
    if (entry[key] !== undefined) settings[key] = entry[key];
  }
  return settings;
}

/**
 * An entry without what it says about a conversation this account never had.
 *
 * The conversation is the account's own when its transcript is in the
 * account's folder. The `last…` keys are statistics Claude Code records when a
 * session ends; losing one for a conversation of ours whose transcript has
 * since been cleaned up costs nothing.
 */
function withoutForeignConversation(entry: Record<string, unknown>, own: Set<string>): Record<string, unknown> {
  const id = entry.lastSessionId;
  if (typeof id === 'string' && own.has(id)) return entry;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!/^last[A-Z]/.test(key)) clean[key] = value;
  }
  return clean;
}

/** The conversations this account has a transcript of. */
export function conversationsIn(configDir: string): Set<string> {
  const ids = new Set<string>();
  const projects = path.join(configDir, 'projects');
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(projects);
  } catch {
    return ids;
  }
  for (const folder of folders) {
    try {
      for (const file of fs.readdirSync(path.join(projects, folder))) {
        if (file.endsWith('.jsonl')) ids.add(file.slice(0, -'.jsonl'.length));
      }
    } catch {
      // Not a folder, or unreadable: nothing of ours to find in it.
    }
  }
  return ids;
}

/**
 * Gives every spelling of one folder the same trust and MCP servers, and keeps
 * every spelling.
 *
 * Windows treats "c:/Work", "C:/Work" and "C:\Work" as one folder; Claude Code
 * keeps an entry per spelling and looks up the exact one it was started with.
 * These used to be merged into one entry, and the spelling kept was not always
 * the one Claude Code looked for next — it found no entry and asked to trust
 * the folder again. Now none is removed: a trust answer or a server given to
 * one spelling is given to all. Only settings are aligned; what an entry says
 * about its own last conversation stays with that entry.
 */
function alignSpellings(projects: ProjectMap): ProjectMap {
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(projects)) {
    const normalised = key.split('\\').join('/').toLowerCase();
    groups.set(normalised, [...(groups.get(normalised) ?? []), key]);
  }

  const aligned: ProjectMap = { ...projects };
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const trusted = keys.some((k) => projects[k].hasTrustDialogAccepted === true);
    const servers = Object.assign({}, ...keys.map((k) => (projects[k].mcpServers as object) ?? {}));
    for (const key of keys) {
      const entry = { ...projects[key] };
      if (trusted) entry.hasTrustDialogAccepted = true;
      if (Object.keys(servers).length > 0) entry.mcpServers = servers;
      aligned[key] = entry;
    }
  }
  return aligned;
}
