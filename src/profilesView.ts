import * as vscode from 'vscode';
import { ClaudeProfile, getProfiles, isAnonymising } from './profiles';
import { terminalsOnProfile } from './terminal';
import { readIdentity, AccountIdentity } from './identity';
import { detectClaudeInstallation } from './discovery';
import { isSharing } from './sharing';
import { colorName, themeColorFor } from './colors';
import * as path from 'path';

/**
 * Whether the panel is hiding who these accounts really are.
 *
 * Sharing a screen is the ordinary case this exists for: a call with one
 * client, a talk, a screenshot for a README. The account names and the signed-in
 * emails are exactly the things that must not be in that picture, and renaming
 * three accounts before a meeting and back afterwards is not a thing anyone
 * will actually do.
 *
 * Colours stay: they carry no identity, and they are half of how the user tells
 * their own rows apart while the names are hidden.
 */
function anonymising(): boolean {
  return isAnonymising();
}

/**
 * `office@example.com` becomes `o****@e****.com`.
 *
 * Enough shape survives that the person who owns the accounts still knows which
 * row is which — first letter, and the real top-level domain — while a stranger
 * reading over a shoulder learns neither the person nor the company. Anything
 * that does not look like an address is replaced outright rather than guessed
 * at, so an unexpected format cannot leak through the masking.
 */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '****';

  const user = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot < 1) return `${user[0]}****@****`;

  return `${user[0]}****@${domain[0]}****${domain.slice(dot)}`;
}

/** The account's position in the list, as `Account 1`, `Account 2`, ... */
function anonymousLabel(profile: ClaudeProfile): string {
  const index = getProfiles().findIndex((p) => p.id === profile.id);
  return `Account ${index >= 0 ? index + 1 : '?'}`;
}

/** The name to show for an account: its own, or a numbered stand-in. */
export function displayName(profile: ClaudeProfile): string {
  return anonymising() ? anonymousLabel(profile) : profile.name;
}

/** The email to show, masked when the panel is anonymising. */
export function displayEmail(email: string): string {
  return anonymising() ? maskEmail(email) : email;
}

/** A folder path holds the account's name, so it is withheld entirely. */
function displayPath(dir: string): string {
  return anonymising() ? '(hidden)' : dir;
}


/**
 * The accounts panel has three levels, and the separation is deliberate.
 *
 * Choosing an account is the everyday action; editing and deleting are rare and
 * one of them destroys credentials. So the plain list carries no editing tools
 * at all, the tools appear only once the user asks for them, and everything
 * belonging to a single account — including its delete button — sits a further
 * level down, where it cannot be reached while switching.
 */
export type ViewMode = 'choose' | 'manage' | 'account';

let mode: ViewMode = 'choose';
/** In 'account' mode, the account being edited. */
let editing: ClaudeProfile | undefined;

export function getViewMode(): ViewMode {
  return mode;
}

export function getEditingProfile(): ClaudeProfile | undefined {
  return editing;
}

/** Sets the mode and mirrors it into a context key so package.json menus follow. */
export async function setViewMode(next: ViewMode, profile?: ClaudeProfile): Promise<void> {
  mode = next;
  editing = next === 'account' ? profile : undefined;
  await vscode.commands.executeCommand('setContext', 'claudes.viewMode', next);
}

/** True when a profile points at Claude Code's own config folder on this machine. */
function isMainInstallation(configDir: string): boolean {
  try {
    return (
      path.resolve(configDir).toLowerCase() ===
      path.resolve(detectClaudeInstallation().configDir).toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * How many ClaudeS terminals are running on this account right now.
 *
 * Counted by the account folder each terminal carries, not by tab name: a
 * hidden name is a position in the list, and shifts when the list changes.
 */
function terminalCountFor(profile: ClaudeProfile): number {
  return terminalsOnProfile(profile).length;
}

/** Level 1 and 2: one account in the list. */
export class ProfileItem extends vscode.TreeItem {
  constructor(
    public readonly profile: ClaudeProfile,
    identity: AccountIdentity
  ) {
    // The label is what the user called this account; the email is who it
    // actually is. Both are shown, so a mislabelled account gives itself away
    // instead of being taken at its word.
    super(displayName(profile), vscode.TreeItemCollapsibleState.None);

    // A stable id per account, so the row keeps its place and selection when
    // the panel redraws.
    this.id = `profile-${profile.id}`;

    const bits: string[] = [];
    if (identity.email) {
      bits.push(displayEmail(identity.email));
    } else if (!identity.loggedIn) {
      bits.push('not signed in');
    }
    // What is running, not which row was clicked last. Several accounts can
    // have a terminal open at once, and "in use" on one of them would be a
    // claim about the others that is not true. A bare number: next to a + that
    // opens terminals, it reads as how many without being told.
    const openTerminals = terminalCountFor(profile);
    if (openTerminals > 0) {
      bits.push(String(openTerminals));
    }
    this.description = bits.join(' · ');

    this.tooltip = new vscode.MarkdownString(
      [
        `**${displayName(profile)}**`,
        '',
        identity.loggedIn
          ? `Signed in as \`${identity.email ? displayEmail(identity.email) : 'unknown'}\``
          : identity.error ?? 'Not signed in yet',
        identity.subscriptionType ? `Plan: ${identity.subscriptionType}` : '',
        // The colour is on the row as a coloured dot and the folder is on the
        // account's own page: repeating either here only makes this longer.
        isMainInstallation(profile.configDir) ? "Claude Code's own folder" : '',
        '',
        mode === 'manage'
          ? 'Click to open'
          : // Says what the click does — opens a terminal — rather than "use
            // this account in this window", which promised something wider
            // than a terminal and quietly implied the chat panel too.
            openTerminals > 0
            ? `${openTerminals} open. Click to open one more.`
            : 'Click to open a terminal'
      ]
        .filter(Boolean)
        .join('\n\n')
    );

    // A +, not a checkbox. A ticked box invited a second click, and that click
    // closed the terminal — while working with several chats on one account,
    // a second click is exactly what someone wanting another terminal makes.
    // A + only ever adds; closing is the x on the right, apart from it.
    //
    // The icon cannot be clicked on its own: in a tree the icon and the label
    // are one click, so the whole row opens a terminal.
    if (mode === 'choose') {
      this.iconPath = new vscode.ThemeIcon('add', themeColorFor(profile.color));
    } else {
      // Filled when signed in, hollow when not, and tinted with the account's
      // own colour — the same one its terminal tabs carry, so the row and the
      // tab agree. A ThemeIcon takes a ThemeColor and never a hex value, which
      // is why each preset is contributed as a colour in package.json.
      this.iconPath = new vscode.ThemeIcon(
        identity.loggedIn ? 'circle-filled' : 'circle-outline',
        themeColorFor(profile.color)
      );
    }

    // Drives the inline buttons declared in package.json. Only the managing
    // level gets a value the menus match, so no edit or delete button can be
    // reached while the user is merely picking an account. A running account
    // gets its own value, so the close button appears only where there is
    // something to close.
    this.contextValue =
      mode === 'manage'
        ? 'claudesProfileManage'
        : openTerminals > 0
          ? 'claudesProfileRunning'
          : 'claudesProfile';

    // On the modify level a click opens the account's own page; switching
    // silently from here would be a side effect nobody asked for.
    this.command =
      mode === 'manage'
        ? { command: 'claudes.openAccountPage', title: 'Open this account', arguments: [profile] }
        : { command: 'claudes.switchToProfile', title: 'Switch to this account', arguments: [profile] };
  }
}

/** A plain caption row, used to say which level the panel is on. */
class NoticeItem extends vscode.TreeItem {
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'claudesNotice';
  }
}

/** A horizontal rule between accounts, so neighbouring rows do not blur together. */
class DividerItem extends vscode.TreeItem {
  constructor(key: string, text = '────────────────────') {
    super(text, vscode.TreeItemCollapsibleState.None);
    // Rows in a tree are all the same height and an extension cannot change
    // that, so the space between accounts has to be drawn rather than set.
    this.id = `divider-${key}`;
    this.contextValue = 'claudesDivider';
    this.tooltip = '';
  }
}

/** Level 3: one editable property of the account being edited. */
class AccountFieldItem extends vscode.TreeItem {
  constructor(
    label: string,
    value: string,
    icon: string,
    // A row with no command does nothing when clicked. It is there to be read,
    // and it says so: dimmed, with a closed padlock, so the difference from the
    // rows above it is visible before anyone clicks to find out.
    command: string | undefined,
    profile: ClaudeProfile,
    tooltip?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    // The colour row shows the colour itself, rather than naming it and leaving
    // the reader to picture it.
    this.iconPath = new vscode.ThemeIcon(
      icon,
      label === 'Colour' ? themeColorFor(profile.color) : undefined
    );
    this.contextValue = command ? 'claudesField' : 'claudesFolderField';

    if (command) {
      this.tooltip = tooltip ?? `Click to change the ${label.toLowerCase()}`;
      this.command = { command, title: label, arguments: [profile] };
      return;
    }

    // resourceUri + a colour on that scheme is the only way a TreeView lets an
    // extension dim one row: labels take no styling of their own.
    this.resourceUri = vscode.Uri.parse(`claudes-readonly:/${encodeURIComponent(label)}`);
    this.tooltip = tooltip;
  }
}

type Row = ProfileItem | NoticeItem | AccountFieldItem | DividerItem;

export class ProfilesProvider implements vscode.TreeDataProvider<Row> {
  private changed = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: Row): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<Row[]> {
    if (mode === 'account') {
      return this.accountPage();
    }

    const profiles = getProfiles();
    const identities = await Promise.all(profiles.map((p) => readIdentity(p.configDir)));

    // Only accounts belong in this list. The way out to the extension's own
    // settings lives in the view's "..." menu instead: as a row it read as one
    // more account, which is the one thing it is not.
    const rows: Row[] = [];
    profiles.forEach((p, i) => {
      if (i > 0) rows.push(new DividerItem(p.id));
      rows.push(new ProfileItem(p, identities[i]));
    });

    return rows;
  }

  /** Everything that can be done to one account, on one screen. */
  private async accountPage(): Promise<Row[]> {
    // Read the account back from settings: a rename done from this very page
    // would otherwise leave the panel showing the old label.
    const current = getProfiles().find((p) => p.id === editing?.id) ?? editing;
    if (!current) {
      return [new NoticeItem('That account no longer exists.')];
    }

    const identity = await readIdentity(current.configDir);
    // Stable ids: the tree reconciles rows by id, and a fresh id each render
    // would make the panel flicker on every refresh.
    let gap = 0;
    const spacer = () => new DividerItem(`gap-${current.id}-${gap++}`, '');

    // Every row here changes something, and each says which click does what:
    // there is no visual cue in a tree that a row is editable, so the row says
    // it in words.
    return [
      new AccountFieldItem(
        'Label',
        displayName(current),
        'edit',
        'claudes.renameProfile',
        current,
        'Click to rename'
      ),
      spacer(),
      new AccountFieldItem(
        'Colour',
        colorName(current.color),
        'circle-filled',
        'claudes.setProfileColor',
        current,
        // The name, not the hex: "#2E7D32" answers "which account is this?"
        // with something to decode.
        'Click to change the colour'
      ),
      spacer(),
      new AccountFieldItem(
        'Signed in as',
        identity.loggedIn
          ? (identity.email ? displayEmail(identity.email) : 'signed in')
          : 'not signed in',
        identity.loggedIn ? 'account' : 'warning',
        // A click signs out, or signs in when nobody is. It used to re-run the
        // check and tell the user what the row already said — a click that
        // spends time to change nothing. The Refresh button covers re-checking.
        identity.loggedIn ? 'claudes.signOut' : 'claudes.signIn',
        current,
        identity.loggedIn ? 'Click to sign out' : 'Click to sign in'
      ),
      spacer(),
      new AccountFieldItem(
        'Environment',
        isMainInstallation(current.configDir)
          ? 'main'
          : isSharing(current.configDir)
            ? 'shared'
            : 'isolated',
        'link',
        isMainInstallation(current.configDir) ? undefined : 'claudes.toggleSharing',
        current,
        isMainInstallation(current.configDir)
          ? 'Your main environment. Other accounts share it from here.'
          : isSharing(current.configDir)
            ? 'Permissions, MCP and skills come from your main account. Click to isolate.'
            : 'Its own permissions, MCP and skills. Click to share your main environment.'
      ),
      spacer(),
      // Last, and greyed out: everything above answers "what can I change
      // here?", and the folder is the one line that never does.
      new AccountFieldItem(
        'Folder',
        displayPath(current.configDir),
        'lock',
        undefined,
        current,
        `${current.configDir}

Read-only. Right-click to open it.`
      )
    ];
  }
}

/**
 * Dims the rows that cannot be clicked.
 *
 * A TreeView gives an extension no way to colour a label directly; the one
 * opening is `resourceUri`, whose decoration a provider may set. Read-only rows
 * carry a `claudes-readonly:` uri for exactly this, so they read as inert
 * before anyone clicks them to find out.
 */
export class ReadOnlyDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'claudes-readonly') return undefined;

    return {
      color: new vscode.ThemeColor('disabledForeground'),
      tooltip: 'Read-only'
    };
  }
}
