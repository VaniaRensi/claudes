# Support

ClaudeS is maintained in spare time: reports are read, but there is no promised
response time.

## First, ask Claude

The answer is very likely already in this documentation, and you have Claude
right there.

The quickest way: run **ClaudeS: Copy the Documentation for Claude** (also in
the `…` menu of the accounts panel). It puts this file and the README, as they
are in the version you have installed, on the clipboard. Paste that into any
Claude — a terminal, the desktop app, the website — and add your question.

Or open a terminal with ClaudeS and paste:

> Read the documentation of the ClaudeS extension for VS Code —
> https://github.com/VaniaRensi/claudes/blob/master/README.md and
> https://github.com/VaniaRensi/claudes/blob/master/SUPPORT.md — and help me
> with this: *describe what you expected and what happened instead*.

Claude can also read the copy installed on your computer, in your VS Code
extensions folder (`~/.vscode/extensions/veleawebvr.claudes-*/`). Only if the
answer is not there, report it below.

## If Claude Code will not start

ClaudeS only opens terminals with an environment variable set; it does not
modify your Claude Code installation. If `claude` stops working, first check
whether it works in a terminal ClaudeS did not open.

## Expected, not a bug

- **A new account asks you to sign in to your MCP servers again** (Gmail,
  GitHub, Figma…). The servers are shared between accounts, but Claude Code
  stores each server's sign-in with the Claude login, and ClaudeS never copies
  logins between accounts. Each account asks once, then never again.
- **A new account asks whether you trust a project folder**, or to approve a
  project's MCP servers. Claude Code keeps those answers per account, so each
  account asks once per folder.
- **The Claude Code chat panel stays on its own account.** ClaudeS chooses the
  account of the terminals it opens; the panel signs in separately (see the
  README).

## Reporting a problem

Open an issue at https://github.com/VaniaRensi/claudes/issues and include:

- your operating system and VS Code version
- what you expected, and what happened instead
- the output of **ClaudeS: What Is Stored / Before Uninstalling** from the
  Command Palette, with anonymising turned on if you would rather not share
  which accounts you have

## Removing it cleanly

Uninstalling from VS Code is enough: your Claude Code folder is never written
to, and your account folders are left in place because they hold your logins.
Delete `~/.claudes` yourself if you want them gone.
