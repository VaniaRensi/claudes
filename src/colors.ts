import * as vscode from 'vscode';

/**
 * Account colours. The colour belongs to the account and lives on its terminal
 * tab, set when the terminal is created; nothing here writes any setting.
 */

/**
 * Suggested colours, chosen to stay legible in both light and dark themes.
 *
 * `themeId` is the same colour registered in package.json under
 * `contributes.colors`. A TreeItem icon can only be tinted with a ThemeColor —
 * an id, never a hex value — so the list of accounts can show a colour at all
 * only because each of these is contributed as one, with this exact value as
 * its light-theme default and a lighter variant for dark themes.
 */
export const PRESET_COLORS: { label: string; value: string; themeId: string }[] = [
  { label: 'Green', value: '#2E7D32', themeId: 'claudes.account.green' },
  { label: 'Blue', value: '#1565C0', themeId: 'claudes.account.blue' },
  { label: 'Light blue', value: '#0277BD', themeId: 'claudes.account.lightblue' },
  { label: 'Purple', value: '#6A1B9A', themeId: 'claudes.account.purple' },
  { label: 'Orange', value: '#E65100', themeId: 'claudes.account.orange' },
  { label: 'Red', value: '#C62828', themeId: 'claudes.account.red' },
  { label: 'Teal', value: '#00695C', themeId: 'claudes.account.teal' },
  { label: 'Brown', value: '#4E342E', themeId: 'claudes.account.brown' },
  { label: 'Grey', value: '#37474F', themeId: 'claudes.account.grey' }
];

/**
 * The ThemeColor for an account's colour, or undefined when it has none.
 *
 * A colour set by an older version may be any hex value at all; one that
 * matches no preset gets no marker rather than a wrong one.
 */
export function themeColorFor(value: string | undefined): vscode.ThemeColor | undefined {
  if (!value) return undefined;
  const match = PRESET_COLORS.find((c) => c.value.toLowerCase() === value.trim().toLowerCase());
  return match ? new vscode.ThemeColor(match.themeId) : undefined;
}

/**
 * The name of a colour, for showing it to someone.
 *
 * The stored value is hex because that is what a terminal tab takes, but a hex
 * value is unreadable as an answer to "which account is this?". Colours set by
 * older versions may be anything at all, so one that matches no preset falls
 * back to its own value rather than claiming a name it does not have.
 */
export function colorName(value: string | undefined): string {
  if (!value) return 'none';
  const match = PRESET_COLORS.find((c) => c.value.toLowerCase() === value.trim().toLowerCase());
  return match ? match.label : value;
}
