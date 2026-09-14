import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suggestedProfilesRoot } from './discovery';

export interface ClaudeProfile {
  id: string;
  name: string;
  configDir: string;
  color?: string;
}

const CONFIG_SECTION = 'claudes';

function makeId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${slug || 'profile'}-${Date.now().toString(36)}`;
}

/**
 * Where the accounts live: this extension's own storage, and nowhere else.
 *
 * Development versions kept the list in `settings.json` (`claudes.profiles`),
 * and that copy was still read whenever the storage was empty. On the machine
 * it was written on it pointed two companies at folders abandoned days
 * earlier, with old logins and without the latest conversations: one click on
 * "Reload the Account List" moved them back silently. The old keys are not
 * read at all now.
 */
const PROFILES_KEY = 'profiles';
const ACTIVE_KEY = 'activeProfileId';

export function getProfiles(): ClaudeProfile[] {
  return globalState?.get<ClaudeProfile[]>(PROFILES_KEY) ?? [];
}

export async function saveProfiles(profiles: ClaudeProfile[]): Promise<void> {
  if (!globalState) throw new Error('Storage is not ready.');
  await globalState.update(PROFILES_KEY, profiles);
}

export function getActiveProfileId(): string {
  return globalState?.get<string>(ACTIVE_KEY) ?? '';
}

export async function setActiveProfileId(id: string): Promise<void> {
  if (!globalState) throw new Error('Storage is not ready.');
  await globalState.update(ACTIVE_KEY, id);
}

/**
 * Validates a profile name typed by the user.
 * Returns an error message to show, or undefined when the name is acceptable.
 *
 * The name is used to derive a folder name, so we only allow characters that are
 * safe on every filesystem rather than silently rewriting what the user typed.
 * `excludeId` lets renaming keep its own current name.
 */
export function validateProfileName(value: string, excludeId?: string): string | undefined {
  const name = value.trim();

  if (name.length === 0) {
    return 'Name cannot be empty.';
  }

  if (name.length > 40) {
    return 'Name is too long (max 40 characters).';
  }

  // Split by code point so multi-byte characters (emoji) are reported whole.
  const invalid = [...name].filter((ch) => !/[a-zA-Z0-9 _.-]/.test(ch));
  if (invalid.length > 0) {
    const shown = [...new Set(invalid)].join(' ');
    return `Not allowed: ${shown}  —  use only letters, numbers, spaces, hyphen (-), underscore (_) or dot (.). Example: "Client A" or "Acme Ltd".`;
  }

  if (name.startsWith('.') || name.endsWith('.')) {
    return 'Name cannot start or end with a dot.';
  }

  // Windows forbids these device names regardless of extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    return `"${name}" is a reserved name on Windows. Please choose another.`;
  }

  const duplicate = getProfiles().find(
    (p) => p.id !== excludeId && p.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    return `A profile named "${duplicate.name}" already exists.`;
  }

  return undefined;
}

function folderNameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'profile';
}

/** Appends -2, -3, ... if the folder is already used by another profile. */
function uniqueDirFor(name: string, existing: ClaudeProfile[]): string {
  const base = folderNameFor(name);
  const taken = new Set(existing.map((p) => p.configDir.toLowerCase()));

  const root = getProfilesRoot();
  let candidate = path.join(root, base);
  let counter = 2;
  // A folder already on disk is skipped too, not only one in the list: after an
  // uninstall the list is gone but the folders, with their logins, are not.
  while (taken.has(candidate.toLowerCase()) || fs.existsSync(candidate)) {
    candidate = path.join(root, `${base}-${counter}`);
    counter++;
  }
  return candidate;
}

export async function createProfile(name: string, configDir?: string): Promise<ClaudeProfile> {
  const profiles = getProfiles();
  const resolvedDir = configDir || uniqueDirFor(name, profiles);

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const profile: ClaudeProfile = {
    id: makeId(name),
    name,
    configDir: resolvedDir
  };

  profiles.push(profile);
  await saveProfiles(profiles);
  return profile;
}

export async function deleteProfile(id: string): Promise<void> {
  const profiles = getProfiles().filter((p) => p.id !== id);
  await saveProfiles(profiles);

  if (getActiveProfileId() === id) {
    await setActiveProfileId('');
  }
}

export async function renameProfile(id: string, newName: string): Promise<void> {
  const profiles = getProfiles();
  const profile = profiles.find((p) => p.id === id);
  if (profile) {
    profile.name = newName;
    await saveProfiles(profiles);
  }
}

// --- Settings-driven paths ---------------------------------------------------------------

/**
 * Root folder for new profiles.
 * Empty setting means "decide automatically", based on where Claude Code
 * actually keeps its configuration on this machine.
 */
export function getProfilesRoot(): string {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>('profilesRoot', '')
    .trim();

  if (configured) {
    return path.resolve(untildify(configured));
  }
  return suggestedProfilesRoot();
}

function untildify(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

// --- Storage ---------------------------------------------------------------

/** Module-level state, set once during activate() so we can use global storage. */
let globalState: vscode.ExtensionContext['globalState'] | undefined;

export function initStorage(state: vscode.ExtensionContext['globalState']): void {
  globalState = state;
}

/**
 * Clears any leftover record of a deleted account.
 *
 * Projects used to be remembered as belonging to one account; that is gone, but
 * older versions left entries behind in this extension's own storage, and an
 * account being deleted is the moment to drop them.
 */
export async function forgetAssociationsFor(profileId: string): Promise<void> {
  if (!globalState) return;

  for (const key of globalState.keys()) {
    if (key.startsWith('association:') && globalState.get<string>(key) === profileId) {
      await globalState.update(key, undefined);
    }
  }

  // Nothing is looked for inside the user's projects. Older versions could
  // write a .vscode/claude-account.json there; those files are left where they
  // are rather than deleted on the way past, because a file in someone's
  // project is theirs once it exists, and removing it is not this function's
  // business. It is inert either way — nothing reads it any more.
}

// --- Hiding who the accounts are ---------------------------------------------------------

/**
 * Whether this window hides the account names, addresses and folders.
 *
 * The eye in the panel acts on its own window only. It used to flip a setting
 * every VS Code window shares: one click reopened terminals in every window,
 * conversations and all, including windows the user was not looking at. The
 * `claudes.anonymiseAccounts` setting remains for hiding everywhere at once,
 * and while it is on no window can show the names — a shared screen must
 * never be one click from a client's name.
 */
const HIDE_NAMES_KEY = 'claudes.hideNamesInThisWindow';
let windowState: vscode.Memento | undefined;

export function initWindowPrivacy(state: vscode.Memento): void {
  windowState = state;
}

/** Names hidden in every window by the setting. */
export function hiddenEverywhere(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('anonymiseAccounts', false);
}

export function isAnonymising(): boolean {
  return hiddenEverywhere() || windowState?.get<boolean>(HIDE_NAMES_KEY, false) === true;
}

export async function setHiddenInThisWindow(hidden: boolean): Promise<void> {
  await windowState?.update(HIDE_NAMES_KEY, hidden);
}

/** Sets or clears an account's colour. */
export async function setProfileColor(id: string, color: string | undefined): Promise<void> {
  const profiles = getProfiles();
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;

  if (color) {
    profile.color = color;
  } else {
    delete profile.color;
  }
  await saveProfiles(profiles);
}
