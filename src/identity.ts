import { execFile } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { envForAccount } from './discovery';

/**
 * Who is actually signed in inside a profile's config folder.
 *
 * A profile name is a label the user typed; it is not evidence of anything. If
 * the label says one client and the folder holds another account's login, the
 * extension would be pointing confidently at the wrong answer — the exact
 * mistake it exists to prevent. So the identity is read from Claude Code
 * itself, via `claude auth status`, rather than inferred from the name.
 */
export interface AccountIdentity {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
  /** Set when the check could not be run at all. */
  error?: string;
}

/** Identities are cached per config dir: the check spawns a process. */
const cache = new Map<string, { value: AccountIdentity; at: number }>();
const CACHE_MS = 30_000;

/** Checks still running, and folders that must not be checked at all. */
const inFlight = new Map<string, Promise<AccountIdentity>>();
const silenced = new Set<string>();

/**
 * Stops checking an account while its folder is deleted, and waits for a check
 * already under way to finish.
 *
 * Each check starts `claude` inside the account's folder, and `claude` writes
 * there. The panel checks every account whenever a terminal closes or the
 * window regains focus — both of which a delete causes — so without this the
 * folder kept being refilled, and on Windows kept open, while it was deleted.
 * Returns the function that lets checks resume.
 */
export async function silenceIdentity(configDir: string): Promise<() => void> {
  silenced.add(configDir);
  cache.delete(configDir);
  await inFlight.get(configDir)?.catch(() => undefined);
  return () => silenced.delete(configDir);
}

export function invalidateIdentity(configDir?: string): void {
  if (configDir) {
    cache.delete(configDir);
  } else {
    cache.clear();
  }
}

function claudeCommand(): string {
  return (
    vscode.workspace.getConfiguration('claudes').get<string>('claudeCommand', 'claude').trim() || 'claude'
  );
}

export async function readIdentity(configDir: string, force = false): Promise<AccountIdentity> {
  // Without a config dir, Claude Code would answer for the machine's default
  // account — and the panel would show that stranger's email under whichever
  // profile was on screen. Saying nothing is the only safe answer here.
  if (!configDir) {
    return { loggedIn: false, error: 'No config folder is set for this account.' };
  }

  if (silenced.has(configDir)) {
    return { loggedIn: false, error: 'This account is being deleted.' };
  }
  // The check runs `claude` with this folder as its configuration, and `claude`
  // creates a folder that is missing: asking about a deleted account's login
  // brought its folder back, empty.
  if (!fs.existsSync(configDir)) {
    return { loggedIn: false, error: 'The account folder is missing.' };
  }

  const hit = cache.get(configDir);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) {
    return hit.value;
  }

  const running = runAuthStatus(configDir);
  inFlight.set(configDir, running);
  const value = await running.finally(() => {
    if (inFlight.get(configDir) === running) inFlight.delete(configDir);
  });
  cache.set(configDir, { value, at: Date.now() });
  return value;
}

/**
 * Runs `claude auth logout` inside one account's config folder.
 *
 * CLAUDE_CONFIG_DIR is what keeps this from signing out the machine's default
 * account: without it Claude Code would drop whichever login it finds by
 * default, which is very likely not the one the user clicked on.
 */
export function runAuthLogout(configDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!configDir) {
      reject(new Error('No config folder is set for this account.'));
      return;
    }

    execFile(
      claudeCommand(),
      ['auth', 'logout'],
      {
        env: envForAccount(configDir),
        timeout: 30_000,
        windowsHide: true,
        shell: process.platform === 'win32'
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve();
      }
    );
  });
}

function runAuthStatus(configDir: string): Promise<AccountIdentity> {
  return new Promise((resolve) => {
    execFile(
      claudeCommand(),
      ['auth', 'status'],
      {
        // The same environment as the terminals we open, so the panel names
        // the login those terminals will actually use.
        env: envForAccount(configDir),
        timeout: 10_000,
        windowsHide: true,
        shell: process.platform === 'win32'
      },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({
            loggedIn: false,
            error: err.message.includes('ENOENT')
              ? 'Claude Code was not found. Check the claudeCommand setting.'
              : err.message
          });
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as {
            loggedIn?: boolean;
            email?: string;
            orgName?: string;
            subscriptionType?: string;
          };
          resolve({
            loggedIn: parsed.loggedIn === true,
            email: parsed.email,
            orgName: parsed.orgName,
            subscriptionType: parsed.subscriptionType
          });
        } catch {
          resolve({ loggedIn: false, error: 'Could not read the account status.' });
        }
      }
    );
  });
}

/** A short label for the identity, for the status bar and the accounts list. */
export function describeIdentity(identity: AccountIdentity): string {
  if (identity.error) return 'unknown';
  if (!identity.loggedIn) return 'not signed in';
  return identity.email ?? 'signed in';
}
