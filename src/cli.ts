import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Whether the `claude` command a terminal is about to run actually exists.
 *
 * ClaudeS types `claude` into a shell; without the CLI the user only saw the
 * shell's "command not found" and no idea what was missing. The Claude Code
 * extension for VS Code does not help: it bundles a private copy for its chat
 * panel and puts nothing on PATH (documented in troubleshoot-install).
 *
 * The official installer puts `claude` in ~/.local/bin and does not add that
 * folder to PATH, so an installed CLI is often still "not found". When it is
 * there, the terminal gets that folder in front of its PATH instead.
 */
export type ClaudeCli =
  | { found: true; extraPathDir?: string }
  | { found: false };

const NAMES = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];

const INSTALL_COMMAND =
  process.platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';

/**
 * Puts ~/.local/bin on the user's PATH after the install, which the installer
 * reports but does not do. Only if the install left `claude` there, and only
 * if the folder is not listed yet.
 *
 * Windows: the user PATH in the registry, read and written raw so entries like
 * %USERPROFILE% stay unexpanded (SetEnvironmentVariable would expand them for
 * good), with the old value printed first. Elsewhere: the line the official
 * troubleshooting page gives, in the login shell's own file.
 */
const ADD_TO_PATH_COMMAND =
  process.platform === 'win32'
    ? "$d = Join-Path $env:USERPROFILE '.local\\bin'; $k = 'HKCU:\\Environment'; " +
      "$p = (Get-Item $k).GetValue('Path', '', 'DoNotExpandEnvironmentNames'); " +
      "if ((Test-Path (Join-Path $d 'claude.exe')) -and (($p -split ';') -notcontains $d)) { " +
      "Write-Host \"Previous user PATH: $p\"; " +
      "Set-ItemProperty $k Path ((@($p.TrimEnd(';'), $d) | Where-Object { $_ }) -join ';') -Type ExpandString; " +
      "Write-Host \"Added $d to your user PATH. Restart VS Code to use claude in every terminal.\" }"
    : 'case "$SHELL" in */zsh) f="$HOME/.zshrc";; */bash) if [ "$(uname)" = Darwin ]; then f="$HOME/.bash_profile"; else f="$HOME/.bashrc"; fi;; *) f="";; esac; ' +
      'if [ -n "$f" ] && [ -x "$HOME/.local/bin/claude" ] && ! grep -qs "\\.local/bin" "$f"; then ' +
      "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> \"$f\" && echo \"Added ~/.local/bin to your PATH in $f. Open a new terminal to use claude.\"; fi";

const PATH_NOTE =
  process.platform === 'win32'
    ? 'it adds %USERPROFILE%\\.local\\bin to your user PATH, if it is not there yet, so "claude" works in every terminal. It prints the previous PATH first.'
    : 'it adds ~/.local/bin to your PATH in your shell file (~/.zshrc or ~/.bashrc), if it is not there yet, so "claude" works in every terminal.';

const INSTRUCTIONS_URL = 'https://code.claude.com/docs/en/setup';

function pathKey(): string {
  return Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function containsClaude(dir: string): boolean {
  return NAMES.some((name) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

export function findClaudeCli(command: string): ClaudeCli {
  // A command the user chose themselves is theirs to get right.
  if (command !== 'claude') return { found: true };

  const dirs = (process.env[pathKey()] ?? '').split(path.delimiter).filter(Boolean);
  if (dirs.some(containsClaude)) return { found: true };

  const localBin = path.join(os.homedir(), '.local', 'bin');
  if (containsClaude(localBin)) return { found: true, extraPathDir: localBin };

  return { found: false };
}

/** Adds the folder the CLI was found in to a terminal's environment. */
export function withClaudeOnPath(env: Record<string, string | null | undefined>, cli: ClaudeCli): void {
  if (!cli.found || !cli.extraPathDir) return;
  const key = pathKey();
  env[key] = [cli.extraPathDir, process.env[key] ?? ''].filter(Boolean).join(path.delimiter);
}

let asking = false;

/**
 * Tells the user the CLI is missing and offers to install it.
 *
 * Installing runs Anthropic's official installer in a visible terminal, only
 * when the user clicks for it, and the command is shown before they do.
 */
export async function offerToInstallClaudeCli(): Promise<void> {
  if (asking) return;
  asking = true;
  try {
    // Changing the PATH is a separate decision from installing, so it is a
    // separate button rather than part of the install.
    const installWithPath = 'Install and add to PATH';
    const install = 'Install only';
    const instructions = 'Installation instructions';
    const choice = await vscode.window.showWarningMessage(
      'Claude Code CLI not found. ClaudeS needs the "claude" command-line tool, and it is not installed on this computer.',
      {
        modal: true,
        detail:
          'The Claude Code extension for VS Code and the Claude desktop app do not provide it.\n\n' +
          `Both install buttons run Anthropic's official installer in a terminal:\n${INSTALL_COMMAND}\n` +
          'It installs Claude Code in your user folder.\n\n' +
          `"Install and add to PATH" also does this: ${PATH_NOTE}\n\n` +
          '"Install only" leaves your PATH alone: ClaudeS finds Claude Code anyway, but typing "claude" in your own terminals will not work.\n\n' +
          'When it finishes, open the account again.'
      },
      installWithPath,
      install,
      instructions
    );
    if (choice === install || choice === installWithPath) {
      const terminal = vscode.window.createTerminal({
        name: 'Install Claude Code',
        // A fixed shell, because the PATH step is written for it.
        shellPath: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
      });
      terminal.show();
      terminal.sendText(choice === installWithPath ? `${INSTALL_COMMAND}; ${ADD_TO_PATH_COMMAND}` : INSTALL_COMMAND, true);
    } else if (choice === instructions) {
      await vscode.env.openExternal(vscode.Uri.parse(INSTRUCTIONS_URL));
    }
  } finally {
    asking = false;
  }
}
