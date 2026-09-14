import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { ClaudeProfile, getProfiles, isAnonymising } from './profiles';
import { ACCOUNT_TERMINAL_ENV, OVERRIDING_CREDENTIAL_VARS } from './discovery';

/**
 * Variables a Claude Code session hands to the programs it starts. VS Code
 * launched from inside one — Claude running `code .` — passes them on to every
 * terminal, and a `claude` started there takes itself for a sub-session: it
 * stops saving the conversation, so there is nothing to reopen. A fresh
 * account terminal is never inside another session, so they are cleared.
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID'
];

/** The environment of a terminal on this account; null removes a variable. */
function accountEnv(profile: ClaudeProfile): Record<string, string | null> {
  const env: Record<string, string | null> = {
    CLAUDE_CONFIG_DIR: profile.configDir,
    [ACCOUNT_TERMINAL_ENV]: '1',
    // Claude Code retitles its terminal after the conversation, and a resumed
    // one replaced "ClaudeS: Account 2" with nothing: the tab stopped saying
    // whose credits it spends, and ClaudeS could no longer find its own tab.
    // Documented: "Set to 1 to disable automatic terminal title updates".
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1'
  };
  for (const name of INHERITED_SESSION_VARS) env[name] = null;
  for (const name of OVERRIDING_CREDENTIAL_VARS) env[name] = null;
  return env;
}

/**
 * The account folder a terminal was opened on, read from its own environment.
 *
 * This, never the tab's name, is how a terminal is tied to an account. Names
 * are not unique: with names hidden they are "Account 1, 2, 3", positions in a
 * list that shift when an account is deleted — matched by name, the x on one
 * company's row closed another company's terminal.
 */
function configDirOf(terminal: vscode.Terminal): string | undefined {
  const dir = (terminal.creationOptions as vscode.TerminalOptions)?.env?.CLAUDE_CONFIG_DIR;
  return typeof dir === 'string' && dir ? path.resolve(dir).toLowerCase() : undefined;
}

/** The open terminals running on this account, and no others. */
export function terminalsOnProfile(profile: ClaudeProfile): vscode.Terminal[] {
  const folder = path.resolve(profile.configDir).toLowerCase();
  return vscode.window.terminals.filter((t) => !t.exitStatus && configDirOf(t) === folder);
}

/** The account a terminal belongs to, if it is one of ours. */
function profileOfTerminal(terminal: vscode.Terminal, profiles: ClaudeProfile[]): ClaudeProfile | undefined {
  const dir = configDirOf(terminal);
  return dir ? profiles.find((p) => path.resolve(p.configDir).toLowerCase() === dir) : undefined;
}

/**
 * Our own name, never Anthropic's.
 *
 * A tab reading "Claude:" would be indistinguishable from the official
 * extension's, on screen, where the user has to know which account a tab
 * spends. The code never goes by this name: see configDirOf().
 */
export const TERMINAL_NAME_PREFIX = 'ClaudeS';

/**
 * The extension's output channel, handed in at activation.
 *
 * The auto-start has now been "fixed" twice on a guess and failed twice, so
 * this path says out loud what it did. "ClaudeS" in the Output panel is the
 * difference between a third guess and a fact.
 */
let log: { appendLine(value: string): void } | undefined;

export function setTerminalLog(channel: { appendLine(value: string): void }): void {
  log = channel;
}

function trace(message: string): void {
  log?.appendLine(`[terminal] ${message}`);
}

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('claudes').get<T>(key, fallback);
}

/**
 * The tab name for an account's terminal.
 *
 * Anonymising replaces the account's name with its position in the list, the
 * same stand-in the panel uses, so a screen being shared or photographed shows
 * `ClaudeS: Account 2` rather than a client's name. The colour is untouched:
 * it identifies the row to its owner and tells a stranger nothing.
 *
 * A terminal keeps the name it was born with, so turning this on renames
 * nothing already open — new terminals get the new form. That is the honest
 * behaviour rather than a bug: renaming a running terminal is not something
 * VS Code allows an extension to do reliably.
 */
export function terminalNameFor(profile: ClaudeProfile): string {
  if (!isAnonymising()) return `${TERMINAL_NAME_PREFIX}: ${profile.name}`;

  const index = getProfiles().findIndex((p) => p.id === profile.id);
  return `${TERMINAL_NAME_PREFIX}: Account ${index >= 0 ? index + 1 : '?'}`;
}

/**
 * The account's colour, as a colour VS Code will accept on a terminal tab.
 *
 * The tab is where the eye already is while typing, so colouring it says which
 * account is being spent at the moment it matters — better than a strip at the
 * far bottom of the screen that has to be looked for.
 *
 * VS Code only takes theme colours here, not the hex the user picked, so the
 * hex is matched to the nearest of the eight it does take. An approximation is
 * the honest limit: the tab also carries the account's name in words, and the
 * colour is there to make windows tellable apart at a glance, not to be read
 * as data on its own.
 */
function tabColorFor(profile: ClaudeProfile): vscode.ThemeColor | undefined {
  if (!profile.color) return undefined;

  const hex = profile.color.replace('#', '');
  if (hex.length !== 6) return undefined;

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return undefined;

  const candidates: [string, number, number, number][] = [
    ['terminal.ansiRed', 198, 40, 40],
    ['terminal.ansiGreen', 46, 125, 50],
    ['terminal.ansiYellow', 230, 81, 0],
    ['terminal.ansiBlue', 21, 101, 192],
    ['terminal.ansiMagenta', 106, 27, 154],
    ['terminal.ansiCyan', 0, 105, 92],
    ['terminal.ansiWhite', 200, 200, 200],
    ['terminal.ansiBlack', 55, 71, 79]
  ];

  let best = candidates[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const [, cr, cg, cb] = candidate;
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return new vscode.ThemeColor(best[0]);
}

/**
 * Brings the Claude terminal forward. Nothing else.
 *
 * This used to close the window down around the terminal — sidebars, panel, and
 * the editor tabs of other AI assistants. It no longer closes anything, at the
 * user's instruction, and the reason is worth keeping: the extension cannot
 * tell a chat panel someone had finished with from one they were in the middle
 * of. Guessing wrong takes away work the user wanted, to save them a click they
 * can do themselves. Opening a terminal is an addition; it should not cost
 * anything already on screen.
 */
export async function focusOnClaudeTerminal(): Promise<void> {
  const claudeTerminal = vscode.window.terminals.find((t) =>
    t.name.startsWith(`${TERMINAL_NAME_PREFIX}: `)
  );
  if (claudeTerminal) {
    claudeTerminal.show();
    return;
  }

  // No terminal of ours in this window: show whatever terminal is there rather
  // than doing nothing and looking broken.
  await vscode.commands
    .executeCommand('workbench.action.terminal.focus')
    .then(undefined, () => undefined);
}

/**
 * Closes the terminals running on this account, and no others.
 *
 * Unticking an account in the panel means "stop running this one", so only its
 * own terminals go — the accounts beside it keep theirs. A terminal running a
 * Claude session is disposed the way closing its tab would: whatever it was
 * doing stops, and the conversation stays on disk in that account's folder.
 */
export function closeTerminalsForProfile(profile: ClaudeProfile): void {
  for (const terminal of terminalsOnProfile(profile)) terminal.dispose();
}

/**
 * Closes every terminal running on this account and waits until they are gone.
 *
 * Before its folder is deleted: on Windows a file a running `claude` holds open
 * cannot be removed, and the delete stopped halfway — the account half there,
 * its folder half gone. Terminals are matched by the folder they were opened
 * with, not by name, since this is what decides which files are held.
 */
export async function closeTerminalsForProfileAndWait(profile: ClaudeProfile): Promise<void> {
  const targets = terminalsOnProfile(profile);
  if (targets.length === 0) return;

  const pending = new Set(targets);
  const allClosed = new Promise<void>((resolve) => {
    const done = () => {
      sub.dispose();
      clearTimeout(timer);
      resolve();
    };
    const sub = vscode.window.onDidCloseTerminal((t) => {
      pending.delete(t);
      if (pending.size === 0) done();
    });
    const timer = setTimeout(done, 5000);
  });
  // On Windows, closing the tab leaves `claude` shutting down for longer than
  // anyone would wait, with the folder's files still open. The account is
  // about to be deleted, so what runs on it is ended outright, shell and all.
  if (process.platform === 'win32') {
    for (const terminal of targets) {
      const pid = await terminal.processId;
      if (!pid) continue;
      await new Promise<void>((resolve) =>
        execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve())
      );
      trace(`ended the processes of "${terminal.name}" (pid ${pid}) before deleting its account`);
    }
  }
  for (const terminal of targets) terminal.dispose();
  await allClosed;
  // The tab goes before the programs in it have let go of their files.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * The open terminals whose tab no longer matches how the account is named now.
 *
 * A terminal keeps the name it was created with, so toggling the anonymising
 * setting leaves the tabs behind: the panel says `Account 2` while the tab
 * beside it still carries the client's name. That is the wrong way round for a
 * setting whose whole purpose is a screen someone else is looking at.
 *
 * The account comes from the folder the terminal carries, and the name it
 * should have is compared with the name it has. Guessing the account from the
 * name reopened a conversation on another company's account once the list had
 * changed under a hidden "Account 2".
 */
export function terminalsWithStaleNames(): { terminal: vscode.Terminal; profile: ClaudeProfile }[] {
  const stale: { terminal: vscode.Terminal; profile: ClaudeProfile }[] = [];
  const profiles = getProfiles();

  for (const terminal of vscode.window.terminals) {
    if (terminal.exitStatus) continue;
    const profile = profileOfTerminal(terminal, profiles);
    if (profile && terminal.name !== terminalNameFor(profile)) {
      stale.push({ terminal, profile });
    }
  }

  return stale;
}

/**
 * Closes terminals whose names are stale and opens them again on the same
 * accounts, so the tabs match the setting.
 *
 * Only ever called after the user has said yes. Reopening ends whatever
 * `claude` was doing in those terminals — the conversation stays on disk, but
 * the running session does not — which is why this is never automatic and why
 * the question that leads here says so.
 */
export async function reopenTerminalsWithCurrentNames(
  stale: { terminal: vscode.Terminal; profile: ClaudeProfile }[]
): Promise<void> {
  for (const { terminal, profile } of stale) {
    trace(`reopening "${terminal.name}" as "${terminalNameFor(profile)}"`);
    // The conversation comes back in the renamed tab: a new name is not a
    // reason to lose what was being said.
    const key = sessionIdOf(terminal);
    const record = key ? sessionsRemembered().find((s) => keyOf(s) === key) : undefined;
    if (key) sessionsBeingReopened.add(key);
    terminal.dispose();
    // Waited for, as on reopening after a restart: see reopenRememberedSessions.
    const opened = await openTerminalForProfile(profile, { sessionId: record?.sessionId ?? key, column: record?.column });
    await opened.ready;
  }
}

/**
 * A Claude conversation this project had open in a terminal, kept so it can be
 * opened again after VS Code closes — on purpose or by crashing.
 *
 * VS Code's own terminal persistence brings the tab back but not what ran in
 * it: the user reopened to three empty `powershell` tabs, the account's name
 * gone from each and nothing telling them which conversation had been where.
 * So ClaudeS opts its terminals out of that (`isTransient`) and does the job
 * itself, with the one thing VS Code cannot know: which conversation to resume.
 *
 * Written when the terminal opens, never at shutdown. A crash gives no warning,
 * and a record saved on the way out would be exactly the one missing.
 */
interface RememberedSession {
  profileId: string;
  /**
   * The conversation to resume. It starts as the id ClaudeS handed to
   * `claude --session-id`, and follows the terminal when the user moves to
   * another conversation inside it (`/resume`, `/clear`).
   */
  sessionId: string;
  /**
   * What the terminal itself carries, fixed for its life: the id it was opened
   * with. Records from before conversations were followed have none, and their
   * sessionId is their key.
   */
  key?: string;
  /** The `claude` process in the terminal, once found; its session file says which conversation it is on. */
  pid?: number;
  /** Editor column the tab was last seen in, so side-by-side comes back side by side. */
  column?: number;
}

function keyOf(session: RememberedSession): string {
  return session.key ?? session.sessionId;
}

const SESSIONS_KEY = 'claudes.openSessions';

/** The env var that carries the session id, so a terminal can be recognised again. */
const SESSION_ENV = 'CLAUDES_SESSION';

let workspaceState: vscode.Memento | undefined;

/**
 * Sessions whose terminal ClaudeS is closing only to open it again under a new
 * name. The close event arrives after the new terminal has saved its record,
 * and without this it would delete the record the new tab depends on.
 */
const sessionsBeingReopened = new Set<string>();

export function initSessionMemory(state: vscode.Memento): vscode.Disposable {
  workspaceState = state;
  const timer = setInterval(() => void followConversations(), 10_000);
  return new vscode.Disposable(() => clearInterval(timer));
}

/** What Claude Code writes about a running `claude`, in `<account>/sessions/<pid>.json`. */
function readSessionFile(configDir: string, pid: number): { sessionId?: string } | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Finds the `claude` process ClaudeS just started, by the conversation it was
 * told to open: Claude Code lists each running `claude` in the account's
 * `sessions` folder, with the conversation it is on.
 */
async function findClaudeProcess(profile: ClaudeProfile, sessionId: string): Promise<void> {
  const dir = path.join(profile.configDir, 'sessions');
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const record = sessionsRemembered().find((s) => keyOf(s) === sessionId);
    if (!record) return;
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      const pid = Number(file.slice(0, -5));
      if (readSessionFile(profile.configDir, pid)?.sessionId !== sessionId) continue;
      const sessions = sessionsRemembered();
      const current = sessions.find((s) => keyOf(s) === sessionId);
      if (!current) return;
      current.pid = pid;
      await writeSessions(sessions);
      trace(`conversation ${sessionId} is claude process ${pid}`);
      return;
    }
  }
  trace(`could not find the claude process for ${sessionId}; a /resume inside it will not be followed`);
}

/**
 * Keeps each record on the conversation its terminal is actually showing.
 *
 * ClaudeS starts a terminal on one conversation, but the user can move to
 * another inside it — `/resume` an older one, `/clear` for a fresh one. Reopened
 * after a restart, the tab then came back on the conversation it had started
 * with, not the one it was left on. Claude Code's session file for the process
 * says which conversation it is on now.
 */
async function followConversations(): Promise<void> {
  const sessions = sessionsRemembered();
  if (!sessions.some((s) => s.pid)) return;
  const profiles = getProfiles();
  let changed = false;
  for (const session of sessions) {
    if (!session.pid) continue;
    const profile = profiles.find((p) => p.id === session.profileId);
    if (!profile) continue;
    const now = readSessionFile(profile.configDir, session.pid)?.sessionId;
    if (now && now !== session.sessionId) {
      trace(`terminal ${keyOf(session)} moved from conversation ${session.sessionId} to ${now}`);
      session.sessionId = now;
      changed = true;
    }
  }
  if (changed) await writeSessions(sessions);
}

function sessionsRemembered(): RememberedSession[] {
  return workspaceState?.get<RememberedSession[]>(SESSIONS_KEY) ?? [];
}

async function writeSessions(sessions: RememberedSession[]): Promise<void> {
  await workspaceState?.update(SESSIONS_KEY, sessions);
}

async function rememberSession(session: RememberedSession): Promise<void> {
  // A conversation reopened under a new key replaces the record it came from.
  const others = sessionsRemembered().filter(
    (s) => keyOf(s) !== keyOf(session) && s.sessionId !== session.sessionId
  );
  await writeSessions([...others, session]);
}

async function forgetSession(key: string): Promise<void> {
  await writeSessions(sessionsRemembered().filter((s) => keyOf(s) !== key));
}

/**
 * The session a terminal was opened for, read from its own environment.
 *
 * Read from the terminal rather than from a map in memory, so it still answers
 * after the extension host restarts under terminals that stayed open.
 */
function sessionIdOf(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions as vscode.TerminalOptions;
  const value = options?.env?.[SESSION_ENV];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Called when any terminal closes. Forgets its conversation only when the user
 * or ClaudeS meant it to go.
 *
 * A window closing, reloading or crashing closes every terminal too, and that
 * is precisely when the record has to survive. So a close counts as "done with
 * this" only for the reasons that are a decision: the tab's x, the shell being
 * exited, or ClaudeS closing it. Anything else keeps it.
 */
export function onSessionTerminalClosed(terminal: vscode.Terminal): void {
  const sessionId = sessionIdOf(terminal);
  if (!sessionId) return;

  const reason = terminal.exitStatus?.reason;
  trace(`terminal "${terminal.name}" closed, reason ${reason === undefined ? 'none' : vscode.TerminalExitReason[reason]}`);

  if (sessionsBeingReopened.delete(sessionId)) return;

  if (
    reason === vscode.TerminalExitReason.User ||
    reason === vscode.TerminalExitReason.Process ||
    reason === vscode.TerminalExitReason.Extension
  ) {
    void forgetSession(sessionId);
  }
}

/**
 * Notes which editor column each of our terminals sits in, as tabs move.
 *
 * A tab only says its label, not which terminal it is, so terminals are matched
 * by name. Two terminals on the same account share a name and are matched in
 * order; the worst that can happen is those two swapping columns on reopen.
 */
export async function recordSessionColumns(): Promise<void> {
  const columnsByLabel = new Map<string, number[]>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputTerminal)) continue;
      const list = columnsByLabel.get(tab.label) ?? [];
      list.push(group.viewColumn);
      columnsByLabel.set(tab.label, list);
    }
  }

  const sessions = sessionsRemembered();
  let changed = false;
  for (const terminal of vscode.window.terminals) {
    const key = sessionIdOf(terminal);
    if (!key) continue;
    const column = columnsByLabel.get(terminal.name)?.shift();
    const session = sessions.find((s) => keyOf(s) === key);
    if (session && column === undefined) {
      trace(`column of "${terminal.name}": no tab found with that label (tabs: ${[...columnsByLabel.keys()].join(', ') || 'none'})`);
    }
    if (session && column !== undefined && session.column !== column) {
      trace(`column of "${terminal.name}": ${session.column ?? 'unset'} -> ${column}`);
      session.column = column;
      changed = true;
    }
  }
  if (changed) await writeSessions(sessions);
}

/**
 * Opens again the conversations this project had open when VS Code last closed.
 *
 * Skips any whose terminal is still here — after an extension host restart the
 * terminals outlive us — and any whose account has since been removed.
 */
export async function reopenRememberedSessions(): Promise<void> {
  const sessions = sessionsRemembered();
  if (sessions.length === 0) return;

  const alive = new Set(
    vscode.window.terminals.map(sessionIdOf).filter((id): id is string => !!id)
  );
  const profiles = getProfiles();
  const keep: RememberedSession[] = [];
  const toOpen: { session: RememberedSession; profile: ClaudeProfile }[] = [];

  for (const session of sessions) {
    if (alive.has(keyOf(session))) {
      keep.push(session);
      continue;
    }
    const profile = profiles.find((p) => p.id === session.profileId);
    if (!profile) {
      trace(`dropping session ${session.sessionId}: its account no longer exists`);
      continue;
    }
    // Started on a missing folder, `claude` would create it, bringing back an
    // empty account where one was deleted.
    if (!fs.existsSync(profile.configDir)) {
      trace(`dropping session ${session.sessionId}: the folder of "${profile.name}" is missing`);
      continue;
    }
    keep.push(session);
    toOpen.push({ session, profile });
  }
  if (keep.length !== sessions.length) await writeSessions(keep);

  // Left to right, so a column that does not exist yet is created next to the
  // one before it rather than out of order.
  toOpen.sort((a, b) => (a.session.column ?? 1) - (b.session.column ?? 1));
  // One at a time, each waited for. Opened back to back, a terminal whose
  // screen VS Code had not yet attached was covered by the next tab and never
  // drawn: renderer.log said "A container element needs to be set with
  // `attachToElement` and be part of the DOM before calling `_open`", and the
  // tab stayed without a name, a shell or `claude` for good.
  for (const { session, profile } of toOpen) {
    trace(`reopening session ${session.sessionId} on "${profile.name}" in column ${session.column ?? 'active'}`);
    const opened = await openTerminalForProfile(profile, { sessionId: session.sessionId, column: session.column });
    await opened.ready;
  }
}

/**
 * Where a new terminal goes: where the user is, for the first one; a column of
 * its own on the right, for each one after.
 *
 * Asking VS Code for the active column left the choice to its column locking —
 * a column holding only terminals locks itself, sometimes — so the same click
 * gave a new column one time and a tab the next. Side by side is how several
 * accounts are worked with, so it is chosen here, every time.
 */
function columnForNewTerminal(): vscode.ViewColumn {
  const groups = vscode.window.tabGroups.all;
  // Recognised by what the terminal carries, not by its tab's label: a label
  // is a title, and titles change.
  const ours = vscode.window.terminals.some(
    (t) => !t.exitStatus && !!(t.creationOptions as vscode.TerminalOptions)?.env?.[ACCOUNT_TERMINAL_ENV]
  );
  const labels = groups.map((g) => `${g.viewColumn}:[${g.tabs.map((t) => t.label).join('|')}]`).join(' ');
  if (!ours) {
    trace(`new terminal goes to the active column (no ClaudeS tab yet; groups ${labels || 'none'})`);
    return vscode.ViewColumn.Active;
  }
  const next = Math.max(...groups.map((g) => g.viewColumn)) + 1;
  trace(`new terminal asked for column ${next} (groups ${labels})`);
  return next;
}

/**
 * Whether Claude Code has a transcript for this session in this account.
 *
 * Claude writes the transcript only once something has been said, so a
 * terminal closed before its first message has nothing to resume, and
 * `--resume` on it fails with "no conversation found". Transcripts live under
 * `<account>/projects/<one folder per project>/<session>.jsonl`; the project
 * folder's name is Claude's to decide, so every one is looked in.
 */
function transcriptExists(profile: ClaudeProfile, sessionId: string): boolean {
  const projects = path.join(profile.configDir, 'projects');
  try {
    return fs
      .readdirSync(projects)
      .some((folder) => fs.existsSync(path.join(projects, folder, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

/**
 * Opens a terminal on this account. `ready` settles once `claude` has been
 * typed into it, for a caller that must not open the next one before.
 */
export async function openTerminalForProfile(
  profile: ClaudeProfile,
  resume?: { sessionId?: string; column?: number }
): Promise<{ terminal: vscode.Terminal; ready: Promise<void> }> {
  const terminalName = terminalNameFor(profile);

  // Terminals for other accounts are left alone by default. Two accounts side
  // by side in one project is a real way to work — some of this job on the
  // client's account, some on your own — and each terminal keeps the account it
  // was created with for life, named and coloured on its own tab. Closing one
  // to switch would make that impossible, and the risk it guarded against is
  // already covered: a terminal cannot silently change account.
  if (setting('closeOtherProfileTerminals', false)) {
    const own = path.resolve(profile.configDir).toLowerCase();
    for (const terminal of vscode.window.terminals) {
      const dir = configDirOf(terminal);
      if (dir && dir !== own) terminal.dispose();
    }
  }

  // A conversation being brought back is started whatever autoStartClaude says:
  // the user had it running, and an empty prompt in its place is the failure
  // this exists to fix.
  const startsClaude = !!resume?.sessionId || setting('autoStartClaude', true);
  const sessionId = startsClaude ? resume?.sessionId ?? randomUUID() : undefined;

  // Remembered before the terminal exists, so there is no moment in which the
  // terminal is running and a crash would leave no record of it.
  if (sessionId) {
    await rememberSession({ profileId: profile.id, sessionId, key: sessionId, column: resume?.column });
  }

  const env = accountEnv(profile);
  if (sessionId) env[SESSION_ENV] = sessionId;

  const terminal = vscode.window.createTerminal({
    name: terminalName,
    // The account's colour on the tab, where the eye is while typing.
    color: tabColorFor(profile),
    iconPath: new vscode.ThemeIcon('account'),
    // Created straight into the editor area, rather than made in the panel and
    // moved afterwards: the move was a second command that could lose the race.
    location: { viewColumn: resume?.column ?? columnForNewTerminal() },
    // VS Code's revival brings back an empty shell with the name stripped off,
    // which ClaudeS then cannot recognise. ClaudeS reopens its own terminals,
    // with the conversation, so VS Code is asked not to.
    isTransient: true,
    env
  });

  terminal.show();

  if (!sessionId) return { terminal, ready: Promise.resolve() };

  const command = setting('claudeCommand', 'claude').trim() || 'claude';
  // --session-id when there is nothing to resume yet: a terminal closed
  // before its first message left no transcript, and resuming it would fail.
  const flag = resume?.sessionId && transcriptExists(profile, sessionId) ? '--resume' : '--session-id';
  const ready = sendWhenShellIsReady(terminal, `${command} ${flag} ${sessionId}`);
  void findClaudeProcess(profile, sessionId);
  return { terminal, ready };
}

/**
 * Sends a line once the shell is actually at a prompt.
 *
 * The old version waited 600ms and hoped. On a window that is reloading — which
 * is exactly what a switch does — PowerShell takes longer than that to come up,
 * the line goes into a shell that is not listening yet, and the user is left
 * looking at an empty prompt wondering why nothing started.
 *
 * VS Code tells us when the shell is ready, so we wait for that instead of for
 * a number. The timer stays as a fallback: shell integration can fail to attach
 * (an unusual shell, a profile that overrides the init script), and a command
 * typed slightly too early is a better failure than one never typed at all.
 */
function sendWhenShellIsReady(terminal: vscode.Terminal, command: string): Promise<void> {
  let sent = false;
  let resolveSent: () => void = () => undefined;
  const whenSent = new Promise<void>((resolve) => (resolveSent = resolve));
  const send = (why: string) => {
    if (sent) return;
    sent = true;
    resolveSent();
    subscription.dispose();
    trace(`sending "${command}" into "${terminal.name}" (${why})`);
    try {
      terminal.sendText(command, true);
      trace('sendText returned without throwing');
    } catch (error) {
      trace(`sendText threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  trace(`terminal "${terminal.name}" created; shellIntegration ${terminal.shellIntegration ? 'already present' : 'not yet attached'}`);

  const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
    if (event.terminal === terminal) send('shell integration attached');
  });

  if (terminal.shellIntegration) {
    send('shell integration was already there');
    return whenSent;
  }

  // If integration never attaches, go anyway rather than leaving the prompt
  // empty forever. Longer than the old 600ms because this is now the unlucky
  // path, not the normal one.
  setTimeout(() => send('fallback timer'), 4000);
  return whenSent;
}

/**
 * Opens a terminal on this profile and starts the sign-in.
 *
 * An account with no login is the one state the user cannot fix by choosing
 * differently, so the row that reports it also offers the way out of it. The
 * login runs inside the profile's own config dir, so the credentials land in
 * that account's folder and nowhere else.
 */
export function signInToProfile(profile: ClaudeProfile): void {
  const terminal = vscode.window.createTerminal({
    name: terminalNameFor(profile),
    color: tabColorFor(profile),
    iconPath: new vscode.ThemeIcon('account'),
    // A sign-in has nothing worth reviving, and a revived one comes back as an
    // anonymous shell.
    isTransient: true,
    env: accountEnv(profile)
  });
  terminal.show();
  const command = setting('claudeCommand', 'claude').trim() || 'claude';
  terminal.sendText(`${command} auth login`, true);
}
