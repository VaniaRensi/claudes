# ClaudeS — Accounts Manager

![version](https://img.shields.io/badge/version-0.2.2-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![VS Code](https://img.shields.io/badge/VS%20Code-1.93+-blueviolet)
![conversations](https://img.shields.io/badge/conversations-never%20shared%20between%20accounts-brightgreen)

Keep several Claude Code accounts side by side, and open a terminal on any of
them with one click.

If you work for more than one client, each with their own Claude subscription,
this stops one client's work from spending another's credits, and keeps each
client's conversations in that client's account.

![The accounts panel: three accounts, each with a + and a count of its open terminals, the hovered one showing x](https://raw.githubusercontent.com/VaniaRensi/claudes/master/docs/accounts-panel.png)

## The first time you open it

The panel is empty and offers **Add an account**. Give the account a name — the
client's, or "Personal" — and a terminal opens where you sign in to it, once.
Add the other accounts the same way.

ClaudeS never copies a login: each account is signed in by you, in its own
folder. Your existing Claude Code keeps its own login, and ClaudeS never writes
to it.

## What it does

**Add an account.** Each one gets its own folder, its own login, and its own
history. You sign in once per account; switching never asks again.

**Give it a colour.** The colour goes on the terminal tab, next to the account's
name — so the terminal you are typing into always says whose credits it spends.
To keep that name there, ClaudeS asks Claude Code not to retitle its terminals
after the conversation (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE`).

**See what is left, where you are working.** The bottom line of each ClaudeS
terminal says which account it is and how much of that account's plan is used:
the 5-hour window and when it resets, the week, and how full the conversation's
context is — for example `Client A · 5h 6% (resets 13:49) · week 34% · context 12%`.
The figures come from Claude Code itself, after the first reply of a session;
ClaudeS reads no token and makes no request for them. The line is handed to each
session with `claude --settings`, so your Claude Code settings are not changed,
and a status line you set up yourself stays. Turn it off with
`claudes.statusLine`.

The usage figures are green, turn orange from 70% and red from 90%, so a limit
coming close is visible without reading the number. Change the two points with
`claudes.usageOrangeFrom` and `claudes.usageRedFrom`; terminals already open
follow at once.

**Click + to open a terminal.** Each click opens one more terminal on that
account and starts `claude` in it, so several chats on the same account are just
several clicks. The number next to the account says how many are open. Hover
the row and click **x** to close all of that account's terminals at once; every
other account is left alone.

Several accounts can be open at once. Two terminals side by side, on two
different accounts, in the same project is a normal way to work: each terminal
keeps the account it was created with for its whole life.

![Three terminals side by side in one project, each on a different account with its own colour on the tab](https://raw.githubusercontent.com/VaniaRensi/claudes/master/docs/terminals.png)

## Close VS Code, keep the conversation

Close VS Code — or have it crash — and the next time you open the project,
every ClaudeS terminal comes back: on the same account, in the same column, with
its conversation where you left it.

Each terminal is remembered for its project the moment it opens, so a crash
has nothing to lose. When the project opens again, ClaudeS resumes each
conversation with `claude --resume`.

Closing a tab yourself is different: that terminal is forgotten and does not
come back.

Two limits. A reply Claude was in the middle of writing when VS Code went down
is lost — the conversation up to the last finished message comes back. And a
terminal where `claude` was not started automatically (`claudes.autoStartClaude`
off) is not remembered, since there is no conversation to resume.

## Hide who the accounts are

Sharing your screen with one client while another client's account is listed
beside theirs is awkward. The eye at the top of the panel (or **ClaudeS: Hide or
Show Who the Accounts Belong To**) lists them as `Account 1`, `Account 2`,
`Account 3` and masks the addresses as `o****@l****.com` — enough shape to
recognise your own, not enough for anyone else. Folder paths are hidden too,
since they carry the name.

The colours stay, so your own rows are still easy to tell apart.

The eye acts on **its own window only**: other VS Code windows keep showing
what they showed, and their terminals are left alone. To hide the names in
every window at once, turn on the `claudes.anonymiseAccounts` setting; while it
is on, no window can show them.

A terminal tab keeps the name it was opened with, so if terminals are already
open in the window when you hide the names, ClaudeS asks whether to reopen them
under the new ones. Reopening resumes each conversation on the same account.

![One account's page: names and addresses hidden, the environment shared, the folder read-only](https://raw.githubusercontent.com/VaniaRensi/claudes/master/docs/account-page.png)

## Terminals, not the chat panel

ClaudeS sets the account for the `claude` command in the terminals it opens. It
does **not** change the account of the Claude Code chat panel, which signs in
separately and keeps spending whichever account it is signed in to.

This is a real limit, not an oversight. Claude Code has no multi-account login,
and the only lever an extension has over the panel is machine-wide — one value
for every window at once, which cannot be a per-project account and would
misreport which one is live. When Anthropic supports signing into several
accounts, it will come with its own way to manage it.

## How it works

Claude Code reads the `CLAUDE_CONFIG_DIR` environment variable at startup to
decide where to keep its settings and credentials. A terminal opened with that
variable set runs on that account for as long as it lives.

ClaudeS gives each account its own folder under `~/.claudes` — **beside** your
Claude Code configuration, never inside it — and sets that variable on the
terminals it opens.

### Your setup is shared; your logins and conversations are not

Your settings, skills, plugins and MCP servers are shared across every account,
by link rather than by copy. Configure them once and every account has them: if
you have set Claude Code up for the work you do, that setup does not change
depending on who is being billed.

Because it is one copy, a change you make from any account — a permission you
grant, a plugin you install — is made by Claude Code in that shared copy, and
every account sees it. ClaudeS itself never writes there. To give an account a
setup of its own instead, use **ClaudeS: Share or Separate This Account's
Setup**.

What is separate is the login, and the conversation history that belongs with
it. That is the whole of what an account is here.

### What a new account asks once — expected, not a bug

The MCP servers are shared, but **signing in to them is not**. Claude Code
stores an MCP server's sign-in together with the Claude login, in the same
place, and ClaudeS never copies one account's login into another. So the first
time each account uses an MCP server that needs you to sign in (Gmail, GitHub,
Figma…), Claude Code asks you to authorise it — once per account, and never
again for that account.

The same goes for a few other answers Claude Code keeps per account:

- **Signing in to Claude** itself — once per account.
- **Trusting a folder** — the first time an account opens a project folder
  Claude Code has not seen before, it asks whether you trust it.
- **Approving a project's own MCP servers** (from a `.mcp.json` in the project)
  — Claude Code may ask once per account.

This is how Claude Code keeps these answers, and ClaudeS cannot share them
without sharing the login too — which would defeat the point of separate
accounts.

### What never crosses from one account to another

The accounts are meant for different companies, so the rule is that **nothing
anyone said crosses over**:

- **Kept apart:** the login, every conversation and its history, Claude's
  memory, the list of running sessions (a Claude on one account cannot find or
  message a Claude on another), and each sign-in to an MCP server.
- **Copied from your main Claude Code setup into each account:** a project
  folder's *settings* only — whether you trust it, the tools you allowed there,
  which MCP servers it uses. Never what a conversation in it said: not its
  first message, not its cost.
- **Shared by link** (unless you give an account its own setup): your
  `settings.json`, skills and plugins. They are the same files for every
  account, so **whatever you write in them reaches every account's
  sessions**. Keep one client's confidential material out of a shared skill
  or a permission rule: put it in that client's project folder, or give that
  account a setup of its own.
- **Not ClaudeS's to separate:** a project folder's own files (`CLAUDE.md`,
  `.claude/`, `.mcp.json`). Any account opened in that folder reads them.
- **A credential that outranks the login:** Claude Code uses an API key or
  token in the environment ahead of the account's login. ClaudeS removes those
  from its terminals, and warns if one is written in the settings the accounts
  read.

### Your Claude Code installation

ClaudeS reads it and never writes to it, and never copies its login. Claude Code
does write to the shared settings, skills and plugins in it
when you change them from any account — they are the same files. Uninstall
ClaudeS and your installation is still signed in, still yours.

## Requirements

- VS Code 1.93 or later
- The `claude` CLI on your PATH ([install](https://claude.com/claude-code))

## Settings

| Setting | Default | What it does |
|---|---|---|
| `claudes.anonymiseAccounts` | `false` | List accounts as Account 1, 2, 3 with addresses masked |
| `claudes.autoStartClaude` | `true` | Run `claude` automatically in a terminal it opens |
| `claudes.claudeCommand` | `claude` | The command to run |
| `claudes.profilesRoot` | — | Where account folders are kept |
| `claudes.closeOtherProfileTerminals` | `false` | Close other accounts' terminals when opening one |
| `claudes.shareSetupWithNewAccounts` | `true` | Start new accounts from your existing setup |

## What is stored, and what happens if you uninstall

Everything ClaudeS keeps is in plain folders you can open, copy or delete
yourself. There is no database and no cloud: nothing about your accounts leaves
your machine.

| What | Where | On uninstall |
|---|---|---|
| Your accounts' logins and chat history | `~/.claudes/<account>/` | **Kept.** These are your credentials, and deleting them without asking would sign you out of every client at once. Delete the folder yourself when you want them gone. |
| The list of accounts, their names and colours | VS Code's own extension storage | Removed by VS Code with the extension. |
| Your Claude Code installation | `~/.claude` and `~/.claude.json` | **Never written by ClaudeS**, and its login is never copied. Claude Code writes to the shared settings, skills and plugins in it when you change them from any account. |
| Settings, skills, plugins, MCP servers | your main Claude Code folder | Shared with each account by link, so there is one copy and it is yours. Removing the links leaves the originals. |

To see the actual paths on this machine, with what is in each one, run
**ClaudeS: What Is Stored / Before Uninstalling** from the Command Palette.

Deleting an account from the panel is the one thing that does remove
credentials, and it says so before it does it.

## Help

Before asking, ask Claude: run **ClaudeS: Copy the Documentation for Claude**
(also in the `…` menu of the accounts panel), paste it into any Claude, and add
your question — the answer is very likely in there.
[SUPPORT.md](https://github.com/VaniaRensi/claudes/blob/master/SUPPORT.md) has
the behaviour that is expected rather than a bug, and how to report a problem
if it is not.

## About

ClaudeS is an independent open-source project. It is **not made, endorsed or
supported by Anthropic**. Claude and Claude Code are trademarks of Anthropic,
PBC, and are named here only to say what this extension works with.

Built with Claude Code. Every behaviour described here was tried by hand on
Windows before release; macOS and Linux have not been tested yet.

## License

MIT — provided as is, without warranty.
