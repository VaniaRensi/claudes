# Changelog

## [0.2.2] — 2026-09-15

- **The bottom of each terminal shows the account and its plan usage**: the
  5-hour window and when it resets, the week, and how full the conversation's
  context is — where you are already looking while you work. The figures come
  from Claude Code itself, so ClaudeS reads no token and makes no network
  request for them, and the status line is given to each session on its own,
  so your Claude Code settings are not changed. A status line you set up
  yourself is left in place. `claudes.statusLine` turns it off.
- **The usage figures change colour** as a limit gets close: green, then
  orange from 70%, then red from 90%. Both points are settings
  (`claudes.usageOrangeFrom`, `claudes.usageRedFrom`) and apply at once, also
  to terminals already open.
- **An empty column no longer stays behind** when you close the last terminal
  in it. VS Code locks a column that holds a terminal and leaves the empty pane
  with its padlock; ClaudeS now closes a column it has left empty, and only one
  that is completely empty.
- **The terminal tab shows the account's name on its own**, without the
  "ClaudeS:" prefix in front of it. The tab already carries the account's
  colour and its icon, so the prefix only took room from the name.

## [0.2.1] — 2026-09-14

A privacy and safety release. Please update.

- **No trace of a conversation crosses between accounts any more.** Bringing a
  project's settings into an account also copied what Claude Code records about
  the last conversation in that folder — its first message, its cost and token
  counts — from your main Claude Code installation into every account. Only
  settings are copied now (whether you trust the folder, the tools you allowed,
  its MCP servers). The next time you open a terminal on an account from the
  panel, whatever was copied into it before is removed. The account's own
  conversations are untouched.
- **Claude Code no longer asks again to trust a folder you already trusted.**
  Windows can spell one folder several ways (`c:/Work`, `C:/Work`, `C:\Work`);
  ClaudeS merged them and sometimes kept a spelling Claude Code did not look
  for. Every spelling is kept now, and trusted if any one of them is.
- **A terminal is always tied to its own account.** With names hidden, tabs
  read "Account 1, 2, 3" — positions that shift when an account is deleted.
  Closing or reopening terminals went by that name, so the x on one account
  could close another account's terminal. Terminals are now recognised by the
  account folder they run on.
- **An API key or token in your environment can no longer make every account
  bill it.** Claude Code prefers such a credential to the account's login.
  ClaudeS removes them from its terminals, and warns if one is written in the
  Claude Code settings your accounts read.
- **The eye hides names in its own window only.** It used to flip a setting
  every VS Code window shares, and each window then offered to reopen its
  terminals: one click could restart conversations in every project you had
  open. The `claudes.anonymiseAccounts` setting still hides them everywhere.
- **ClaudeS no longer copies your Claude Code login on first start.** A copy
  is a second holder of the same sign-in, and whether renewing one can sign
  the other out could not be ruled out. You add each account and sign in to it
  yourself, once.
- **Removed "Reload the Account List"** and the last reading of the account
  list that development versions kept in `settings.json`. It could quietly
  point accounts back at folders abandoned long ago.
- Removed the leftover "Restore the Window Layout" command, which only focused
  the terminal.
- The README and the Marketplace description now say precisely what is kept
  apart, what is shared, and what is written where.

## [0.2.0] — 2026-09-11

The first public release. This describes what the extension does, rather than
the road it took to get here.

### The accounts panel

- Several accounts can be **open at once**. Each account has a **+**: every
  click opens one more terminal on it and starts `claude`, and the row counts
  how many are open. The **x** on a hovered row closes that account's terminals
  and leaves the others alone. Two accounts side by side in one project — some
  of a job on the client's account, some on your own — is a normal way to work.
- **Hiding the account names** is one click, the eye at the top of the panel.
  Terminals already open keep the name they were opened with, so ClaudeS offers
  to reopen them under the new one — asked once, in the window you are looking
  at.
- Each account gets its own folder, its own login and its own history. You sign
  in once per account, and switching never asks again.
- Each account's colour goes on the **terminal tab**, beside its name, so the
  terminal you are typing into says whose credits it spends.
- The real signed-in email is read from the account's own folder and shown
  beside the label you chose, so a mislabelled account cannot pass for the
  right one.
- Permanent deletion removes the credentials from disk as well as the entry,
  guarded so it can never delete a project, a home folder, a drive root, or the
  main Claude configuration.

### Conversations survive VS Code closing

- Close VS Code, or have it crash, and every ClaudeS terminal comes back when
  the project is opened again: same account, same column, same conversation.
  Each terminal starts `claude` with a session id ClaudeS chose and remembered
  for the project as it opened, and is resumed with `claude --resume`.
- Moving to another conversation inside a terminal — `/resume`, `/clear` — is
  followed, so the tab comes back on the conversation it was left on.
- A tab closed by hand is forgotten and stays closed.
- VS Code's own terminal revival is switched off for ClaudeS terminals: it
  brought them back as empty shells with the account name stripped.

### Terminals only

ClaudeS sets the account for the `claude` command in the terminals it opens. It
does not touch the **Claude Code chat panel** or any of Claude Code's settings:
the only lever over the panel is machine-wide, so every window's chat would move
together, and a window whose panel had been moved by *another* window would
spend a client's credits with nothing on screen saying so.

### Never touches your Claude Code installation

- Nothing ClaudeS runs writes to `~/.claude`, `~/.claude.json` or Claude Code's
  VS Code settings — not on install, not while in use, not on uninstall. It
  writes only inside its own account folders and VS Code's storage for this
  extension.
- Deleting an account removes its folder and the links in it; what the links
  point to, your shared settings, skills and plugins, is left alone.

### Fixed

- **`claude` now actually starts.** It waits for VS Code to report the shell as
  ready instead of guessing at a delay, with a timed fallback for shells where
  shell integration never attaches.
- **Terminals no longer come back as anonymous shells.** Applying an account's
  colour wrote workspace settings on every switch, and a workspace settings
  write reloads the window. The reload landed on terminals that had just been
  created; VS Code restored them as plain shells, with the name, the colour and
  `CLAUDE_CONFIG_DIR` all gone — a terminal on no account at all, which is the
  one thing this extension exists to prevent.
- **Claude Code's own answers survive a switch.** Syncing projects and MCP
  servers into an account wrote its `.claude.json` from a copy read before the
  write, so an answer saved in between — Claude Code's onboarding questions,
  answered once — was put back the way it had been, and the question returned.
  The file is now re-read immediately before writing, and when nothing of ours
  differs nothing is written at all.
- **Folders opened only under an account stay trusted.** The same sync replaced
  the account's project list with the main installation's, so a folder the main
  installation had never seen was forgotten on every terminal: Claude Code
  asked to trust it again and lost the permissions granted there. Projects are
  now added to the account's list, never written over it.

### Removed

- **The status bar indicator.** There is one status bar per window and no way to
  give each terminal tab its own, so with two accounts open at once it had to
  pick one and be wrong about the other. The tab carries the name and the
  colour, next to the prompt being typed into.
- **The window no longer rearranges itself.** Nothing is closed: not the side
  bars, not the panel, not other assistants' tabs. The extension cannot tell a
  chat someone had finished with from one they were in the middle of, and
  guessing wrong takes away work to save a click. Opening a terminal is an
  addition.
- **The wrong-account warning.** With the panel a set of switches, two accounts
  open at once is the intended case, so it fired on normal use and said
  something true and useless.
- The settings that drove all of the above: `showStatusBar`, `focusMode`,
  `closeAssistantTabs`, `warnOnMismatch`, `colorTheWindow`.

### Requires

- VS Code **1.93** or later, for the shell-integration API the auto-start uses.

