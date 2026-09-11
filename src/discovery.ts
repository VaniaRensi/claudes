import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where Claude Code keeps its configuration on this machine.
 *
 * Per the official docs, Claude Code stores settings, session history and
 * credentials in `~/.claude` on every platform (on Windows `~` is
 * `%USERPROFILE%`), unless the user points CLAUDE_CONFIG_DIR somewhere else.
 * We follow the same precedence rather than assuming a fixed path.
 */
export interface ClaudeInstallation {
  /** The directory Claude Code is actually using. */
  configDir: string;
  /** How we determined it — shown to the user so the choice isn't a black box. */
  source: 'CLAUDE_CONFIG_DIR' | 'home';
  /** True when the directory exists and looks like a real Claude config. */
  exists: boolean;
  /** True when that directory holds credentials (i.e. someone is logged in). */
  hasCredentials: boolean;
}

const CREDENTIALS_FILE = '.credentials.json';

/** Set on every terminal ClaudeS opens, so anything started from one knows. */
export const ACCOUNT_TERMINAL_ENV = 'CLAUDES_ACCOUNT_TERMINAL';

/** Files that indicate a directory really is a Claude Code config dir. */
const MARKER_ENTRIES = ['.credentials.json', '.claude.json', 'settings.json', 'projects', 'sessions'];

export function looksLikeClaudeConfigDir(dir: string): boolean {
  if (!dirExists(dir)) return false;
  return MARKER_ENTRIES.some((entry) => fs.existsSync(path.join(dir, entry)));
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** True when this config dir holds credentials, i.e. an account is logged in. */
export function hasCredentials(dir: string): boolean {
  return fs.existsSync(path.join(dir, CREDENTIALS_FILE));
}

/**
 * Resolves the Claude config directory this machine is using, following the
 * same precedence Claude Code itself documents:
 *   1. CLAUDE_CONFIG_DIR, when set
 *   2. ~/.claude  (%USERPROFILE%\.claude on Windows)
 */
export function detectClaudeInstallation(): ClaudeInstallation {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();

  // Except when VS Code itself was started from one of our terminals: then the
  // variable is one of our accounts, inherited, not where Claude Code lives.
  // Taken for the installation, it made an account the source every other
  // account is synced from, and put new accounts inside it.
  const inherited =
    !!process.env[ACCOUNT_TERMINAL_ENV] ||
    (!!fromEnv && path.basename(path.dirname(path.resolve(untildify(fromEnv)))) === '.claudes');

  if (fromEnv && !inherited) {
    const resolved = path.resolve(untildify(fromEnv));
    return {
      configDir: resolved,
      source: 'CLAUDE_CONFIG_DIR',
      exists: dirExists(resolved),
      hasCredentials: hasCredentials(resolved)
    };
  }

  const home = path.join(os.homedir(), '.claude');
  return {
    configDir: home,
    source: 'home',
    exists: dirExists(home),
    hasCredentials: hasCredentials(home)
  };
}

/**
 * The directory we suggest as the parent for new account folders.
 *
 * Beside Claude Code's own configuration, never inside it: `~/.claudes` next to
 * `~/.claude`. Beside, because that is where the user already keeps this kind of
 * data and it is the obvious place to look; never inside, because uninstalling
 * ClaudeS must not leave anything in another program's folder, and because a
 * folder of ours sitting in Claude Code's own directory would be indistinguishable
 * from something Claude Code put there.
 *
 * The name is ours too. It was `-profiles` appended to Claude's folder name,
 * which made `~/.claude-profiles` — a name that reads as Claude Code's own, for
 * a directory Anthropic has nothing to do with. Existing accounts keep the path
 * stored with them, so nothing already created moves or breaks.
 */
export function suggestedProfilesRoot(): string {
  const installation = detectClaudeInstallation();
  const parent = path.dirname(installation.configDir);
  return path.join(parent, '.claudes');
}

function untildify(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}
