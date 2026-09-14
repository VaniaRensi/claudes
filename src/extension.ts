import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  ClaudeProfile,
  getProfiles,
  setActiveProfileId,
  getActiveProfileId,
  createProfile,
  deleteProfile,
  renameProfile,
  validateProfileName,
  initStorage,
  initWindowPrivacy,
  isAnonymising,
  hiddenEverywhere,
  setHiddenInThisWindow,
  forgetAssociationsFor,
  setProfileColor
} from './profiles';
import { detectClaudeInstallation, overridingCredentialsIn } from './discovery';
import { checkSafeToDelete, deleteConfigFolder } from './deletion';
import {
  ProfilesProvider,
  ReadOnlyDecorationProvider,
  ProfileItem,
  displayEmail,
  displayName,
  setViewMode,
  ViewMode,
  getViewMode,
  getEditingProfile
} from './profilesView';
import {
  PRESET_COLORS,
  colorName
} from './colors';
import {
  openTerminalForProfile,
  closeTerminalsForProfile,
  closeTerminalsForProfileAndWait,
  signInToProfile,
  focusOnClaudeTerminal,
  setTerminalLog,
  terminalsWithStaleNames,
  reopenTerminalsWithCurrentNames,
  initSessionMemory,
  onSessionTerminalClosed,
  recordSessionColumns,
  reopenRememberedSessions
} from './terminal';
import {
  shareSettings,
  unshareSettings,
  isSharing,
  syncProjectSettings,
  liveProjectFileFor
} from './sharing';
import { readIdentity, invalidateIdentity, runAuthLogout, silenceIdentity } from './identity';

let log: vscode.OutputChannel;
let profilesProvider: ProfilesProvider | undefined;
let profilesView: vscode.TreeView<unknown> | undefined;

/** The message under the view header for a given mode, when nothing has just happened. */
function restingMessage(mode: ViewMode): string | undefined {
  // Manage mode says where the buttons are, because they are not drawn until
  // the pointer is over a row and VS Code offers extensions no way to pin them
  // open. It also says that changes save themselves: the way out of this level
  // is a button in the header, and anyone used to dialogs with a Save in them
  // reads leaving as discarding.
  return mode === 'manage' ? 'Changes save as you make them. Hover a row for its buttons.' : undefined;
}

let confirmationTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Says a change was saved, under the view header, and takes it back after a
 * few seconds.
 *
 * A notification popup would be the obvious tool and the wrong one: renaming
 * three accounts would mean dismissing three toasts, and an interruption that
 * says "that worked" is the kind users learn to click away without reading —
 * including on the day it says something else.
 *
 * The view header is already on screen, already being looked at, and costs no
 * click to dismiss. It is the quietest place that is still impossible to miss.
 */
function confirmInView(text: string): void {
  if (!profilesView) return;

  clearTimeout(confirmationTimer);
  profilesView.message = text;

  confirmationTimer = setTimeout(() => {
    // Restores whatever the current mode would normally say, rather than
    // clearing: leaving manage mode without its hint would undo the fix above.
    if (profilesView) profilesView.message = restingMessage(getViewMode());
  }, 4000);
}

/**
 * Moves the accounts panel between its three levels.
 *
 * The header carries the level as plainly as the rows do: the screens look
 * alike at a glance, and one of them can delete credentials.
 */
async function applyViewMode(mode: ViewMode, profile?: ClaudeProfile): Promise<void> {
  await setViewMode(mode, profile);
  if (profilesView) {
    profilesView.title =
      mode === 'account'
        ? profile
          ? displayName(profile)
          : 'Account'
        : mode === 'manage'
          ? 'Edit accounts'
          : 'Accounts';

    clearTimeout(confirmationTimer);
    profilesView.message = restingMessage(mode);
  }
  profilesProvider?.refresh();
}


/**
 * Registers a command so a failure inside it cannot escape.
 *
 * Every command here touches the filesystem or the settings store, and both
 * can fail for reasons that have nothing to do with this code: a folder on a
 * disconnected network drive, a settings file held open by another window, a
 * permission that changed. Left unhandled, VS Code shows the raw exception —
 * "ENOENT: no such file or directory, scandir ..." — which tells the user
 * nothing about what they were doing or what to try next.
 *
 * Wrapping at the point of registration rather than inside each handler means
 * a command added later is covered by default, instead of relying on whoever
 * writes it to remember.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function command(id: string, handler: (...args: any[]) => unknown): vscode.Disposable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vscode.commands.registerCommand(id, async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.appendLine(`Command ${id} failed: ${err instanceof Error ? err.stack ?? message : message}`);
      vscode.window.showErrorMessage(`ClaudeS: ${message}`);
      return undefined;
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('ClaudeS');
  context.subscriptions.push(log);
  log.appendLine('Activating ClaudeS...');
  setTerminalLog(log);

  try {
    initStorage(context.globalState);
    initWindowPrivacy(context.workspaceState);
    pendingState = context.globalState;
    // Leftovers of accounts deleted while a program still held their files.
    void finishPendingDeletions();
    // Per project: each folder reopens its own conversations, not another's.
    context.subscriptions.push(initSessionMemory(context.workspaceState));
    // So the eye in the title bar is the right one from the first draw, rather
    // than after the setting is next touched.
    void syncAnonymisingContext();

    context.subscriptions.push(
      command('claudes.switchAccount', switchAccountCommand),
      command('claudes.newProfile', newProfileCommand),
      command('claudes.renameProfile', renameProfileCommand),
      command('claudes.openConfigFolder', openConfigFolderCommand),
      command('claudes.forgetProfile', forgetProfileCommand),
      command('claudes.setProfileColor', setProfileColorCommand),
      command('claudes.switchToProfile', switchToProfileCommand),
      command('claudes.refreshProfiles', () => {
        invalidateIdentity();
        profilesProvider?.refresh();
      }),
      command('claudes.refreshIdentities', () => {
        invalidateIdentity();
        profilesProvider?.refresh();
      }),
      command('claudes.newProfileFromView', newProfileCommand),
      command('claudes.manageAccounts', () => applyViewMode('manage')),
      command('claudes.backToAccounts', () =>
        // One step back, not all the way out: from an account page the user
        // came from the list of accounts to modify, and that is where they
        // expect to land.
        applyViewMode(getViewMode() === 'account' ? 'manage' : 'choose')
      ),
      // These arrive with a tree item from an inline button and with a bare
      // profile from a row, so both go through profileFrom(): taking the item
      // for a profile leaves configDir undefined, and an identity read with no
      // config dir answers for the machine's default account instead of this
      // one — the extension confidently naming the wrong account.
      command('claudes.openAccountPage', (arg?: ProfileItem | ClaudeProfile) =>
        applyViewMode('account', profileFrom(arg))
      ),
      command('claudes.openAccountFolder', (arg?: ProfileItem | ClaudeProfile) => {
        const target = profileFrom(arg) ?? getEditingProfile();
        if (target) void vscode.env.openExternal(vscode.Uri.file(target.configDir));
      }),
      command('claudes.revealAccounts', async () => {
        // The status bar always lands on the plain list, never on the editing
        // tools, whatever mode the panel was left in.
        await applyViewMode('choose');
        await vscode.commands.executeCommand('claudes.profiles.focus');
        if (getProfiles().length === 0) {
          const choice = await vscode.window.showInformationMessage(
            'No ClaudeS accounts yet. Create one now?',
            'Create Profile'
          );
          if (choice === 'Create Profile') await newProfileCommand();
        }
      }),
      command('claudes.signIn', signInCommand),
      command('claudes.signOut', signOutCommand),
      command('claudes.toggleSharing', toggleSharingCommand),
      command('claudes.showFootprint', showFootprintCommand),
      command('claudes.startHere', startHereCommand),
      command('claudes.toggleAnonymise', toggleAnonymiseCommand),
      // Same command behind a second id, so the title bar can show an open eye
      // when the names are visible and a closed one when they are hidden. A
      // menu entry's icon is fixed in package.json, so the state has to be a
      // different entry rather than a different icon on the same one.
      command('claudes.toggleAnonymiseOff', toggleAnonymiseCommand),
      command('claudes.focusTerminal', focusOnClaudeTerminal),
      command('claudes.openSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:VeleaWebVR.claudes')
      ),
      command('claudes.copyDocsForClaude', () => copyDocsForClaude(context))
    );
    profilesProvider = new ProfilesProvider();
    // A created view, rather than a bare provider, so the panel header itself
    // can say which of the two modes is showing.
    profilesView = vscode.window.createTreeView('claudes.profiles', {
      treeDataProvider: profilesProvider
    });
    context.subscriptions.push(profilesView);

    // Greys out the rows that only show a value, so a row that does nothing
    // when clicked looks like one before it is clicked.
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(new ReadOnlyDecorationProvider())
    );

    // The x on a running account's row: closes every terminal on that account
    // and leaves the other accounts alone. One terminal at a time is already
    // the x on its own tab.
    context.subscriptions.push(
      command('claudes.closeAccountTerminals', (arg?: ProfileItem | ClaudeProfile) => {
        const target = profileFrom(arg);
        if (!target) return;
        closeTerminalsForProfile(target);
        profilesProvider?.refresh();
      })
    );

    // The panel always opens ready to choose, not ready to delete.
    void applyViewMode('choose');
    log.appendLine('Commands registered.');

    // Settings that change what the panel shows have to redraw it. Anonymising
    // is the one that matters: it is reached from the settings UI as well as
    // from the command, and a panel still showing the real names after the
    // setting was turned on is the exact failure it exists to prevent.
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudes')) {
          profilesProvider?.refresh();
        }

        // The setting hides names in every window, and every window hears it
        // change. Only the window where it was changed offers to reopen its
        // terminals. The others are never asked, now or later: a question
        // waiting in each window reopened terminals — and the conversations in
        // them — across every project the user had open.
        if (e.affectsConfiguration('claudes.anonymiseAccounts')) {
          void syncAnonymisingContext();
          if (vscode.window.state.focused) void offerToReopenStaleTerminals();
        }
      })
    );

    // The indicator speaks for ClaudeS terminals, so it has to appear and go
    // away with them. Closing the last one and carrying on in another
    // assistant's tabs must leave nothing behind claiming an account: a strip
    // at the bottom naming Claude, above a window with no Claude terminal in
    // it, is worse than no indicator at all.
    context.subscriptions.push(
      // The panel counts running terminals per account, so it has to be redrawn
      // when one opens or closes — otherwise a row goes on claiming a terminal
      // that was closed minutes ago.
      vscode.window.onDidOpenTerminal(() => {
        profilesProvider?.refresh();
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        onSessionTerminalClosed(terminal);
        profilesProvider?.refresh();
      }),
      // Where each conversation's tab sits, so it comes back to the same column.
      vscode.window.tabGroups.onDidChangeTabs(() => void recordSessionColumns()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => void recordSessionColumns()),
      // Moving between two terminals moves between two accounts, and only the
      // one in front matters for whether this project's account is the one
      // being typed into.
    );

    // A sign-in can also happen in a terminal the extension never opened, or in
    // another window. Coming back to this window is the moment the user looks
    // at the panel, so that is when it re-reads who is signed in rather than
    // showing an answer that went stale while they were away.
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          invalidateIdentity();
          profilesProvider?.refresh();
        }
      })
    );

    warnAboutOverridingCredentials();

    // The conversations that were open when VS Code last closed or crashed.
    reopenRememberedSessions()
      .then(() => profilesProvider?.refresh())
      .catch((err) => log.appendLine(`Could not reopen the previous sessions: ${err}`));
    log.appendLine('Activation complete.');
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    log.appendLine(`ACTIVATION FAILED: ${message}`);
    log.show(true);
    vscode.window.showErrorMessage(`ClaudeS failed to activate: ${message}`);
  }
}

export function deactivate(): void {
  // no-op
}

// --- Commands ----------------------------------------------------------------------------

async function switchAccountCommand(): Promise<void> {
  const profiles = getProfiles();

  if (profiles.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No ClaudeS accounts yet. Create one now?',
      'Create Profile'
    );
    if (choice === 'Create Profile') {
      await newProfileCommand();
    }
    return;
  }

  const activeId = getActiveProfileId();
  const items: (vscode.QuickPickItem & { profile?: ClaudeProfile; action?: 'new' })[] = profiles.map((p) => ({
    label: `${p.id === activeId ? '$(check) ' : ''}${p.name}`,
    description: p.configDir,
    profile: p
  }));

  items.push({ label: '$(add) Create new profile...', action: 'new' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the ClaudeS account to use for this session'
  });

  if (!picked) return;

  if (picked.action === 'new') {
    await newProfileCommand();
    return;
  }

  await switchToProfileCommand(picked.profile!);

  // A project used to be remembered as belonging to one account, and opening a
  // terminal on another one asked about it. That made sense while the panel was
  // a single choice. It is a checklist now: opening two accounts in one project
  // is the intended use, so there is no wrong account to warn about, and the
  // question asked here had nothing left to decide — the answer was stored and
  // never read again.
}

async function newProfileCommand(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'New ClaudeS account',
    prompt: 'Letters, numbers, spaces, - _ . only (this becomes a folder name). Example: "Client A", "Acme Ltd", "Personal".',
    placeHolder: 'Client A',
    ignoreFocusOut: true,
    validateInput: (value) => validateProfileName(value)
  });

  if (!name) return;

  // ClaudeS picks the folder, always. Where an account lives is not a decision
  // the user is asked to make: it cannot be changed afterwards either, and an
  // account pointed at a folder someone else manages is the one that goes
  // wrong later. Someone with an existing login signs in again, here.
  const profile = await createProfile(name.trim());
  await askAboutSharing(profile);

  vscode.window.showInformationMessage(
    `Profile "${profile.name}" created. A terminal will open so you can log in with "claude" for the first time (e.g. via the OTP flow).`
  );

  await switchToProfileCommand(profile);
}

/**
 * Asks whether a new account should share the working setup or start clean.
 *
 * Permissions, MCP servers and skills live inside the config folder, so a fresh
 * account starts with none of them. For someone whose accounts differ only in
 * who gets billed, that is a downgrade they did not ask for; for someone whose
 * client has its own MCP servers and rules, a clean folder is the whole point.
 * Only the user knows which case this is.
 */
async function askAboutSharing(profile: ClaudeProfile): Promise<void> {
  const installation = detectClaudeInstallation();
  if (!installation.exists) return;
  // Nothing to share into: the profile *is* the main installation.
  if (path.resolve(profile.configDir).toLowerCase() === path.resolve(installation.configDir).toLowerCase()) {
    return;
  }

  const mode = vscode.workspace
    .getConfiguration('claudes')
    .get<'always' | 'never' | 'ask'>('shareSetupWithNewAccounts', 'always');

  if (mode === 'never') return;

  let share = true;

  if (mode === 'ask') {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: '$(link) Share my setup',
          detail:
            'Same permissions, MCP servers, skills and plugins as your main account. Its login and its conversations stay its own.',
          share: true
        },
        {
          label: '$(shield) Keep it separate',
          detail:
            'A clean environment: its own permissions, MCP servers and skills. Choose this when the client has its own tools and rules.',
          share: false
        }
      ],
      {
        title: `Working setup for "${profile.name}"`,
        placeHolder: 'Permissions, MCP servers and skills live per account — which do you want?',
        ignoreFocusOut: true
      }
    );

    // Dismissed: sharing is the safer answer, since a clean folder silently
    // drops permissions the user has already granted.
    share = picked ? picked.share : true;
  }

  if (share) {
    const result = shareSettings(installation.configDir, profile.configDir);
    log.appendLine(
      `Sharing for ${profile.name}: linked ${result.linked.join(', ') || 'nothing'}` +
        (result.copied.length ? `; copied ${result.copied.join(', ')}` : '') +
        (result.failed.length ? `; failed ${result.failed.map((f) => f.entry).join(', ')}` : '')
    );
    if (result.failed.length) {
      vscode.window.showWarningMessage(
        `Some settings could not be shared with "${profile.name}": ${result.failed
          .map((f) => `${f.entry} (${f.reason})`)
          .join('; ')}`
      );
    }
  }
}

/**
 * These commands are reached three ways: as an inline button on a list row
 * (which hands over the tree item), as a row on the account page (which hands
 * over the profile itself), and from the command palette (which hands over
 * nothing). This accepts all three rather than each caller having to match.
 */
function profileFrom(arg?: ProfileItem | ClaudeProfile): ClaudeProfile | undefined {
  if (!arg) return undefined;
  return 'profile' in arg ? (arg as ProfileItem).profile : (arg as ClaudeProfile);
}

async function renameProfileCommand(item?: ProfileItem | ClaudeProfile): Promise<void> {
  const profile = profileFrom(item) ?? (await pickProfile('Select the account to relabel'));
  if (!profile) return;

  // The label is the user's own word for the account. Showing the real email
  // here makes it obvious when the two have drifted apart.
  const identity = await readIdentity(profile.configDir);
  // Masked when anonymising is on, like everywhere else the address appears.
  // A dialog is exactly where it would otherwise leak: the panel behind it is
  // hiding the name, and this box would print it in full.
  const shown = identity.email ? displayEmail(identity.email) : undefined;
  const signedInAs = shown ? `Signed in as ${shown}. ` : '';

  const newName = await vscode.window.showInputBox({
    title: `Label for ${shown ?? profile.name}`,
    prompt: `${signedInAs}Letters, numbers, spaces, - _ . only.`,
    value: profile.name,
    ignoreFocusOut: true,
    validateInput: (value) => validateProfileName(value, profile.id)
  });
  if (!newName) return;

  await renameProfile(profile.id, newName.trim());
  profilesProvider?.refresh();
  confirmInView(`Renamed to "${newName.trim()}".`);
}

async function openConfigFolderCommand(): Promise<void> {
  const activeId = getActiveProfileId();
  const profile = getProfiles().find((p) => p.id === activeId);
  if (!profile) {
    vscode.window.showInformationMessage('No active profile selected.');
    return;
  }
  const uri = vscode.Uri.file(profile.configDir);
  await vscode.commands.executeCommand('revealFileInOS', uri);
}

/**
 * Says so when a settings file would make accounts bill a credential other
 * than their own login.
 *
 * Claude Code puts an `apiKeyHelper`, or an API key or token in `env`, ahead
 * of the login in the account's folder. With a shared setup that one file
 * speaks for every account: each tab would name a different company while all
 * of them spend the same key. The terminals' own environment is cleaned when
 * they open; a settings file is the user's, so this only reports it.
 */
function warnAboutOverridingCredentials(): void {
  const affected: string[] = [];
  let found: string[] = [];
  for (const profile of getProfiles()) {
    const here = overridingCredentialsIn(profile.configDir);
    if (here.length === 0) continue;
    affected.push(displayName(profile));
    found = [...new Set([...found, ...here])];
  }
  if (affected.length === 0) return;

  log.appendLine(`Settings that outrank the accounts' logins (${found.join(', ')}) are read by: ${affected.join(', ')}`);
  void vscode.window.showWarningMessage(
    `ClaudeS: the Claude Code settings read by ${affected.join(', ')} contain ${found.join(', ')}. ` +
      'Claude Code uses that instead of the account\'s own login, so these accounts would all bill it. ' +
      'Remove it from settings.json to keep the accounts separate.'
  );
}

/**
 * Deletes an account for good: the profile entry and the credentials on disk.
 *
 * Credentials for a company you no longer work with should not linger on your
 * machine, so this is deliberately final — no recycle bin, no "removed from the
 * list but still on disk". It is also deliberately fussy about what it will
 * delete: projects are never touched, whatever a profile happens to point at.
 */
/**
 * Puts this version's README and SUPPORT on the clipboard, for pasting into any
 * Claude together with a question.
 *
 * Most questions are answered in them, and whoever asks has Claude open anyway.
 * Read from the installed extension, so the answer is about the version they
 * have, and it works offline.
 */
async function copyDocsForClaude(context: vscode.ExtensionContext): Promise<void> {
  const version = (context.extension.packageJSON as { version?: string }).version ?? '';
  const parts = ['README.md', 'SUPPORT.md'].map((file) => {
    try {
      return fs.readFileSync(path.join(context.extensionPath, file), 'utf8');
    } catch {
      return '';
    }
  });
  const text = [
    `Below is the documentation of ClaudeS ${version}, an extension for VS Code that manages several Claude Code accounts. Use it to answer my question, which follows it.`,
    ...parts.filter(Boolean),
    'My question:'
  ].join('\n\n---\n\n');
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage(
    'The ClaudeS documentation is on the clipboard. Paste it into Claude and add your question at the end.'
  );
}

/** Back to the list of accounts when the one on screen no longer exists. */
async function leavePageOf(profile: ClaudeProfile): Promise<void> {
  if (getViewMode() === 'account' && getEditingProfile()?.id === profile.id) {
    await applyViewMode('choose');
  }
}

async function forgetProfileCommand(item?: ProfileItem | ClaudeProfile): Promise<void> {
  // The trash icon on an account's own page arrives with no item: the account
  // is the one on screen, and asking which one would be asking the obvious.
  const onScreen = getViewMode() === 'account' ? getEditingProfile() : undefined;
  const profile = profileFrom(item) ?? onScreen ?? (await pickProfile('Select the account to delete'));
  if (!profile) return;

  const installation = detectClaudeInstallation();
  const check = checkSafeToDelete(profile.configDir, installation.configDir);

  // Nothing to delete on disk, or refusing to: still let the entry go.
  if (!check.safe) {
    const choice = await vscode.window.showWarningMessage(
      `The credentials folder will not be deleted: ${check.reason}\n\nRemove "${profile.name}" from the list anyway?`,
      { modal: true },
      'Remove from list'
    );
    if (choice !== 'Remove from list') return;

    await deleteProfile(profile.id);
    await forgetAssociationsFor(profile.id);
    await leavePageOf(profile);
    profilesProvider?.refresh();
    return;
  }

  const typed = await vscode.window.showInputBox({
    title: `Delete "${profile.name}" permanently`,
    prompt: `This closes the account's terminals and deletes its credentials from this computer for good. Your projects are not touched. Type ${profile.name} to confirm.`,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === profile.name ? undefined : `Type "${profile.name}" exactly, or press Escape to cancel.`
  });

  if (typed?.trim() !== profile.name) return;

  const resumeIdentity = await silenceIdentity(profile.configDir);
  await closeTerminalsForProfileAndWait(profile);

  // The login goes first and on its own: it is the part that must not outlive
  // the decision, and a single small file is rarely the one still held open.
  const credentials = path.join(profile.configDir, '.credentials.json');
  try {
    if (fs.existsSync(credentials)) fs.rmSync(credentials, { force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    log.appendLine(`Could not remove the login of ${profile.name}: ${err}`);
    vscode.window.showErrorMessage(
      `Could not delete the login of ${profile.name}: a program is still using it. Close any Claude Code running on this account — in another window or outside VS Code — and delete again.`
    );
    resumeIdentity();
    return;
  }

  // A `claude` whose terminal has just closed takes some seconds to exit, and
  // on Windows can leave a helper behind that holds a file for longer still.
  const leftover = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deleting ${profile.name}…` },
    () => deleteFolderPatiently(profile.configDir, installation.configDir, 20)
  );

  await deleteProfile(profile.id);
  await forgetAssociationsFor(profile.id);
  resumeIdentity();
  await leavePageOf(profile);
  profilesProvider?.refresh();

  if (leftover) {
    // The account and its login are gone; what is left is a few files a
    // program has not let go of yet. Finished later rather than reported as a
    // failure the user can do nothing about.
    await rememberPendingDeletion(profile.configDir);
    log.appendLine(`Deleted ${profile.name}; ${profile.configDir} is still in use and will be removed later: ${leftover}`);
    vscode.window.showInformationMessage(
      `"${profile.name}" and its login were deleted. A few leftover files are still in use by Claude Code; ClaudeS will remove them shortly.`
    );
    return;
  }

  vscode.window.showInformationMessage(`"${profile.name}" and its credentials were deleted.`);
}

/**
 * Deletes a folder, retrying while files in it are held open. Returns nothing
 * when it is gone, or a description of what stopped it.
 */
async function deleteFolderPatiently(dir: string, mainConfigDir: string, attempts: number): Promise<string | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      deleteConfigFolder(dir, mainConfigDir);
      return undefined;
    } catch (err) {
      if (!fs.existsSync(dir)) return undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (!/EPERM|EBUSY|ENOTEMPTY/.test(message) || attempt >= attempts) return message;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

// Folders of deleted accounts that were still in use, finished later.
const PENDING_KEY = 'foldersPendingDeletion';
let pendingState: vscode.Memento | undefined;

async function rememberPendingDeletion(dir: string): Promise<void> {
  const pending = new Set(pendingState?.get<string[]>(PENDING_KEY, []) ?? []);
  pending.add(dir);
  await pendingState?.update(PENDING_KEY, [...pending]);
  setTimeout(() => void finishPendingDeletions(), 60_000);
}

/**
 * Removes what is left of deleted accounts' folders. Each goes through the same
 * safety check as a first delete, and a folder no longer recognisable as an
 * account's is left alone — silently, since the account itself is long gone.
 */
async function finishPendingDeletions(): Promise<void> {
  const pending = pendingState?.get<string[]>(PENDING_KEY, []) ?? [];
  if (pending.length === 0) return;
  const main = detectClaudeInstallation().configDir;
  const still: string[] = [];
  const inUse = new Set(getProfiles().map((p) => path.resolve(p.configDir).toLowerCase()));
  for (const dir of pending) {
    if (!fs.existsSync(dir)) continue;
    // Never a folder an account uses now, whatever the list says about its past.
    if (inUse.has(path.resolve(dir).toLowerCase())) continue;
    if (!checkSafeToDelete(dir, main).safe) continue;
    const left = await deleteFolderPatiently(dir, main, 3);
    if (left) still.push(dir);
    else log.appendLine(`Removed the rest of ${dir}.`);
  }
  await pendingState?.update(PENDING_KEY, still);
}

async function pickProfile(placeHolder: string): Promise<ClaudeProfile | undefined> {
  const profiles = getProfiles();
  if (profiles.length === 0) {
    vscode.window.showInformationMessage('No accounts configured yet.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({ label: p.name, description: p.configDir, profile: p })),
    { placeHolder }
  );
  return picked?.profile;
}

/** Switching by clicking a profile in the sidebar. */
/**
 * Starts the sign-in for an account that has none.
 *
 * A profile with no credentials is the one problem the user cannot solve by
 * picking a different account, so the row that reports it leads straight to the
 * fix instead of only re-reporting the same thing.
 */
async function signInCommand(arg?: ProfileItem | ClaudeProfile): Promise<void> {
  const profile = profileFrom(arg) ?? getEditingProfile() ?? (await pickProfile('Select the account to sign in'));
  if (!profile) return;

  const identity = await readIdentity(profile.configDir);
  if (identity.loggedIn) {
    // Already signed in: re-check rather than starting a login nobody asked
    // for, which would risk replacing a working account with another one.
    invalidateIdentity(profile.configDir);
    await readIdentity(profile.configDir, true);
    profilesProvider?.refresh();
    vscode.window.showInformationMessage(
      `${profile.name} is signed in as ${identity.email ?? 'an account'}.`
    );
    return;
  }

  signInToProfile(profile);
  await waitForSignIn(profile);
}

/**
 * Signs an account out, leaving the account itself alone.
 *
 * Signing out and deleting an account are different things that used to have
 * one button between them: the only way out of a login was the bin, which also
 * took the folder, the chat history and the permissions with it. This drops the
 * credentials and keeps everything else, so the account can be signed back in.
 *
 * `claude auth logout` is run against the account's own config folder, so the
 * machine's default login is never the one that goes.
 */
async function signOutCommand(arg?: ProfileItem | ClaudeProfile): Promise<void> {
  const profile = profileFrom(arg) ?? getEditingProfile() ?? (await pickProfile('Select the account to sign out'));
  if (!profile) return;

  const identity = await readIdentity(profile.configDir);
  if (!identity.loggedIn) {
    vscode.window.showInformationMessage(`"${displayName(profile)}" is not signed in.`);
    return;
  }

  const who = identity.email ? displayEmail(identity.email) : 'this account';
  const confirm = await vscode.window.showWarningMessage(
    `Sign "${displayName(profile)}" out?`,
    {
      modal: true,
      // Says the one thing that is not obvious: this is not the bin. The
      // account, its colour and its history all stay.
      detail: `${who} will be signed out. The account and its history stay.`
    },
    'Sign out'
  );
  if (confirm !== 'Sign out') return;

  try {
    await runAuthLogout(profile.configDir);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not sign out: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  invalidateIdentity(profile.configDir);
  await readIdentity(profile.configDir, true);
  profilesProvider?.refresh();
  confirmInView('Signed out.');
}

/**
 * Watches for a sign-in to land, then updates the panel by itself.
 *
 * The login happens in a terminal and in a browser, so there is no event to
 * wait on. Telling the user to come back and refresh would leave the account
 * reading "not signed in" right after they signed in — the one thing the panel
 * must never get wrong — so it checks on their behalf and stops as soon as the
 * credentials appear.
 */
async function waitForSignIn(profile: ClaudeProfile): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Waiting for "${profile.name}" to sign in...`,
      cancellable: true
    },
    async (_progress, token) => {
      // Two minutes is long enough to finish a browser login without leaving a
      // check running forever if the user abandons it.
      const deadline = Date.now() + 120_000;

      while (Date.now() < deadline && !token.isCancellationRequested) {
        await new Promise((r) => setTimeout(r, 2000));

        invalidateIdentity(profile.configDir);
        const identity = await readIdentity(profile.configDir, true);

        if (identity.loggedIn) {
          profilesProvider?.refresh();
          vscode.window.showInformationMessage(
            `"${profile.name}" is now signed in as ${identity.email ?? 'an account'}.`
          );
          return;
        }
      }

      // Timed out or cancelled: show whatever the truth is now rather than
      // leaving a stale answer on screen.
      invalidateIdentity(profile.configDir);
      profilesProvider?.refresh();
    }
  );
}

/**
 * Turns setup sharing on or off for an account that already exists.
 *
 * The choice made when an account was created is not permanent: a client can
 * acquire its own MCP servers later, and an account made before this feature
 * existed has no shared setup at all.
 */
async function toggleSharingCommand(arg?: ProfileItem | ClaudeProfile): Promise<void> {
  const profile = profileFrom(arg) ?? getEditingProfile() ?? (await pickProfile('Select the account'));
  if (!profile) return;

  const installation = detectClaudeInstallation();
  if (path.resolve(profile.configDir).toLowerCase() === path.resolve(installation.configDir).toLowerCase()) {
    vscode.window.showInformationMessage(
      `"${profile.name}" is your main Claude Code folder — its setup is the one others share.`
    );
    return;
  }

  if (isSharing(profile.configDir)) {
    const confirm = await vscode.window.showWarningMessage(
      `Stop sharing your setup with "${profile.name}"?`,
      {
        modal: true,
        detail:
          'This account will start with no permissions, MCP servers or skills of its own, ' +
          'so commands will ask for confirmation again.\n\n' +
          'Nothing is deleted from your main account.'
      },
      'Stop sharing'
    );
    if (confirm !== 'Stop sharing') return;

    const removed = unshareSettings(profile.configDir);
    log.appendLine(`Unshared from ${profile.name}: ${removed.join(', ') || 'nothing'}`);
    vscode.window.showInformationMessage(`"${profile.name}" now has its own separate setup.`);
  } else {
    const result = shareSettings(installation.configDir, profile.configDir);
    const total = result.linked.length + result.copied.length;
    log.appendLine(
      `Sharing for ${profile.name}: linked ${result.linked.join(', ') || 'nothing'}` +
        (result.copied.length ? `; copied ${result.copied.join(', ')}` : '') +
        (result.failed.length ? `; failed ${result.failed.map((f) => f.entry).join(', ')}` : '')
    );

    if (total === 0 && result.failed.length === 0) {
      vscode.window.showInformationMessage('There was nothing to share from your main account.');
    } else {
      vscode.window.showInformationMessage(
        `"${profile.name}" now shares your permissions, MCP servers and skills.` +
          (result.failed.length
            ? ` Some entries were left alone: ${result.failed.map((f) => f.entry).join(', ')}.`
            : '')
      );
    }
  }

  profilesProvider?.refresh();
}

/**
 * Brings projects and MCP servers across to the account being switched to.
 *
 * These live in .claude.json, which Claude Code keeps beside the config folder
 * rather than inside it, and which also holds the login. It cannot be linked
 * like the other shared files, so the work-related keys are copied on every
 * switch: otherwise an account arrives with no MCP servers and no project
 * settings, and tools that were working a moment ago simply stop.
 *
 * Only accounts that opted into sharing are touched.
 */
function syncSharedProjects(profile: ClaudeProfile): void {
  const installation = detectClaudeInstallation();
  if (path.resolve(profile.configDir).toLowerCase() === path.resolve(installation.configDir).toLowerCase()) {
    return;
  }
  if (!isSharing(profile.configDir)) return;

  const source = liveProjectFileFor(installation.configDir);
  const result = syncProjectSettings(path.dirname(source), profile.configDir);

  if (result.error) {
    log.appendLine(`Could not sync projects to ${profile.name}: ${result.error}`);
    return;
  }
  log.appendLine(
    `Synced to ${profile.name}: ${result.projects} projects, ${result.mcpServers} MCP servers (from ${source})`
  );
}

/**
 * The one button: clear the window, pick an account, land in a terminal.
 *
 * Coming back to a window left full of another assistant's tabs, the way into
 * ClaudeS should be one keystroke and one choice, not a hunt through panes. It
 * always asks which account, even when one is already active — the question is
 * the point of the command, and answering it is what makes the terminal that
 * opens trustworthy.
 */
async function startHereCommand(): Promise<void> {
  const target = await pickProfile('Which account should this terminal use?');
  if (!target) return;
  await switchToProfileCommand(target);
}

/**
 * Hides or shows the account names in this window only.
 *
 * A command as well as a setting, because the moment it is wanted — a call
 * starting, a screenshot about to be taken — is not a moment for digging
 * through a settings page. It never touches another window: see
 * isAnonymising().
 */
async function toggleAnonymiseCommand(): Promise<void> {
  const hidden = isAnonymising();
  if (hidden && hiddenEverywhere()) {
    vscode.window.showInformationMessage(
      'Names are hidden in every window by the setting claudes.anonymiseAccounts. Turn it off in Settings to show them.'
    );
    return;
  }

  await setHiddenInThisWindow(!hidden);
  await syncAnonymisingContext();
  profilesProvider?.refresh();

  const offered = await offerToReopenStaleTerminals();
  if (!offered) {
    vscode.window.showInformationMessage(
      hidden
        ? 'Account names and addresses are visible again in this window.'
        : 'In this window, accounts are now shown as Account 1, 2, 3 with addresses masked.'
    );
  }
}

/**
 * Mirrors whether this window hides the names into a context key.
 *
 * The title bar shows an open eye while the names are visible and a closed one
 * while they are hidden, and a menu entry's icon is fixed in package.json — so
 * which of the two entries is shown has to be decided by a context key, which
 * is per window, like the choice itself.
 */
async function syncAnonymisingContext(): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'claudes.anonymising', isAnonymising());
}

/** True while the dialog is actually on screen, so a second one cannot stack. */
let staleTerminalPromptOpen = false;

/**
 * Offers to reopen the terminals whose tabs no longer match the setting.
 *
 * A terminal cannot be renamed once it exists, so after the anonymising setting
 * changes the tabs still carry the old spelling: the panel says `Account 2`
 * while the tab beside it names the client. Reopening is the only way to make
 * them agree.
 *
 * It is always a question, never done for them. The terminals may be in the
 * middle of something the user wants to finish first, and reopening ends the
 * running `claude` session — so the cost is stated in the prompt, and "Leave
 * them open" is a real answer that changes nothing.
 *
 * Returns whether there was anything to ask about.
 */
async function offerToReopenStaleTerminals(): Promise<boolean> {
  // One question at a time, however many terminals are stale and however the
  // setting was reached. Without this a second toggle while the first dialog is
  // still open stacks another on top of it.
  if (staleTerminalPromptOpen) return true;

  const stale = terminalsWithStaleNames();
  if (stale.length === 0) return false;

  const terminals = stale.length === 1 ? '1 terminal' : `${stale.length} terminals`;
  const hiding = isAnonymising();

  staleTerminalPromptOpen = true;
  const choice = await vscode.window.showWarningMessage(
    hiding
      ? `You asked to hide the account names, but ${terminals} still show them on the tab. Reopen them to hide them there too?`
      : `You asked to show the account names again, but ${terminals} still show Account 1, 2, 3 on the tab. Reopen them to show the real names there too?`,
    {
      detail:
        'Reopening closes them and starts claude again on the same accounts. ' +
        'Anything running in them stops; the conversations stay on disk.',
      // Modal, because a plain notification dismisses itself after a few
      // seconds. This one is asked at the moment a screen is about to be
      // shared, and an unanswered question that vanished is worse than no
      // question: the user believes the names are hidden everywhere.
      modal: true
    },
    // A modal already draws Cancel, which is the "leave them alone" answer, so
    // a second button saying the same thing would only be one more thing to
    // read.
    'Reopen them'
  );
  staleTerminalPromptOpen = false;

  if (choice?.startsWith('Reopen')) {
    await reopenTerminalsWithCurrentNames(stale);
    profilesProvider?.refresh();
  }

  return true;
}

async function switchToProfileCommand(arg?: ProfileItem | ClaudeProfile): Promise<void> {
  const target = profileFrom(arg) ?? (await pickProfile('Select the account to use'));
  if (!target) return;


  await setActiveProfileId(target.id);
  syncSharedProjects(target);
  profilesProvider?.refresh();
  await openTerminalForProfile(target);
}


/**
 * Shows what this extension has put on the machine and what happens if it is
 * removed. Uninstalling should never cost anyone their work, so the answer
 * needs to be visible before they uninstall, not discovered afterwards.
 */
async function showFootprintCommand(): Promise<void> {
  const profiles = getProfiles();
  const installation = detectClaudeInstallation();

  const lines = [
    '# What ClaudeS has stored, and what happens if you uninstall it',
    '',
    '## Your projects',
    '',
    'Untouched. Nothing is written into them, in any configuration.',
    '',
    '## Your Claude Code installation',
    '',
    `\`${installation.configDir}\``,
    '',
    'Never written by ClaudeS, and its login is never copied. Claude Code itself',
    'writes to the settings, skills and plugins in it when you change them from',
    'any account that shares them. It keeps its own login, and uninstalling',
    'ClaudeS leaves it signed in.',
    '',
    '## Your accounts',
    ''
  ];

  if (profiles.length === 0) {
    lines.push('No accounts configured.');
  } else {
    lines.push('These folders hold your logins. Uninstalling ClaudeS does **not** delete them:');
    lines.push('');
    // Honours the anonymising setting: this document is exactly the kind of
    // thing opened mid-call to explain what the extension does, and it would
    // otherwise print the client names and folder paths the panel is hiding.
    const anonymous = isAnonymising();

    profiles.forEach((p, i) => {
      lines.push(
        anonymous ? `- **Account ${i + 1}** — (path hidden)` : `- **${p.name}** — \`${p.configDir}\``
      );
    });

    if (anonymous) {
      lines.push('');
      lines.push(
        (hiddenEverywhere()
          ? '_Names and paths are hidden because `claudes.anonymiseAccounts` is on. Turn it off to see them._'
          : '_Names and paths are hidden in this window. Click the eye in the ClaudeS panel to show them._')
      );
    }
    lines.push('');
    lines.push('Write these paths down if you want to reach them without the extension.');
    lines.push('');
    lines.push('To use one of these accounts without ClaudeS, set `CLAUDE_CONFIG_DIR` to its');
    lines.push('folder before running `claude`. To go back to a single account, simply run');
    lines.push('`claude` as usual: it uses your main configuration, exactly as it did before.');
  }

  lines.push('');
  lines.push('## Settings');
  lines.push('');
  lines.push('Removing the extension leaves its settings in your VS Code `settings.json`');
  lines.push('under `claudes.*`. They are inert, and safe to delete by hand.');
  lines.push('');
  lines.push('## Claude Code itself');
  lines.push('');
  lines.push('Never modified. ClaudeS sets `CLAUDE_CONFIG_DIR` for the terminals it opens, and');
  lines.push('removes from them any API key or token that would outrank the account\'s login.');
  lines.push('It never copies a login: each account is signed in on its own.');

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown'
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

// --- Account colours ----------------------------------------------------------------------

/**
 * Gives an account a colour, so the window it is used in is recognisable at a
 * glance — the client's own colour, not something to be read and decoded.
 */
async function setProfileColorCommand(item?: ProfileItem | ClaudeProfile): Promise<void> {
  const profile = profileFrom(item) ?? (await pickProfile('Select the account to colour'));
  if (!profile) return;

  // Names, not hex. A tab can only take one of a handful of theme colours
  // anyway, so a typed value was never honoured as typed — it was matched to
  // the nearest of these. Offering a colour picker promised a precision the
  // result could not keep, and answered "which colour is this account?" with
  // a number the user has to decode.
  const items: (vscode.QuickPickItem & { value?: string; clear?: boolean })[] = PRESET_COLORS.map(
    (c) => ({ label: c.label, value: c.value })
  );

  if (profile.color) {
    items.push({ label: 'No colour', description: 'Leave the terminal tab as your theme has it', clear: true });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Colour for "${profile.name}"`,
    placeHolder: profile.color
      ? `Currently ${colorName(profile.color)}`
      : 'Pick the colour you associate with this client'
  });

  if (!picked) return;

  const color = picked.clear ? undefined : picked.value;

  await setProfileColor(profile.id, color);
  profilesProvider?.refresh();
  confirmInView('Colour saved. New terminals will use it.');
}
