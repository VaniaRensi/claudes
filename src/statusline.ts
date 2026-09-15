/**
 * The status line ClaudeS gives its own terminals: the account, and how much
 * of its plan is used, at the bottom of the Claude Code screen.
 *
 * Claude Code runs this with the session's data on stdin (statusline.md,
 * "Available data"), including `rate_limits.five_hour` and `seven_day` for
 * Pro and Max accounts. So the figure comes from Claude Code itself, for the
 * account that session runs on: no network request and no token here.
 *
 * It is started only for ClaudeS terminals, through `claude --settings`, so
 * nothing is written to the user's Claude Code settings. The account's name
 * arrives in CLAUDES_ACCOUNT_NAME, set on the terminal when it was opened.
 */
import * as fs from 'fs';

interface Window {
  used_percentage?: number;
  resets_at?: number;
}
interface StatusInput {
  rate_limits?: { five_hour?: Window; seven_day?: Window };
  context_window?: { used_percentage?: number };
}

function time(epochSeconds: number | undefined): string | undefined {
  if (typeof epochSeconds !== 'number' || !isFinite(epochSeconds)) return undefined;
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function pct(value: number | undefined): string | undefined {
  return typeof value === 'number' && isFinite(value) ? `${Math.round(value)}%` : undefined;
}

/** From which percentage a plan figure turns orange, and red. Below: green. */
export interface Thresholds {
  orangeAt: number;
  redAt: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { orangeAt: 70, redAt: 90 };

const GREEN = '\x1b[32m';
const ORANGE = '\x1b[38;5;208m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** A plan figure in the colour its level calls for. */
function planFigure(value: number | undefined, thresholds: Thresholds): string | undefined {
  const text = pct(value);
  if (!text || value === undefined) return text;
  const rounded = Math.round(value);
  const colour = rounded >= thresholds.redAt ? RED : rounded >= thresholds.orangeAt ? ORANGE : GREEN;
  return colour + text + RESET;
}

/**
 * The thresholds the user chose, from the small file ClaudeS keeps in its own
 * storage. Read on every redraw, so a change reaches terminals already open.
 * Anything unreadable falls back to the defaults rather than to no colour.
 */
export function readThresholds(file: string | undefined): Thresholds {
  if (!file) return DEFAULT_THRESHOLDS;
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Thresholds>;
    const ok = (n: unknown) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100;
    const orangeAt = ok(t.orangeAt) ? (t.orangeAt as number) : DEFAULT_THRESHOLDS.orangeAt;
    const redAt = ok(t.redAt) ? (t.redAt as number) : DEFAULT_THRESHOLDS.redAt;
    return { orangeAt, redAt: Math.max(orangeAt, redAt) };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export function formatStatus(input: StatusInput, account: string, thresholds: Thresholds = DEFAULT_THRESHOLDS): string {
  const parts = [account];
  const five = input.rate_limits?.five_hour;
  const week = input.rate_limits?.seven_day;
  const fiveUsed = planFigure(five?.used_percentage, thresholds);
  if (fiveUsed) {
    const resets = time(five?.resets_at);
    parts.push(`5h ${fiveUsed}${resets ? ` (resets ${resets})` : ''}`);
  }
  const weekUsed = planFigure(week?.used_percentage, thresholds);
  if (weekUsed) parts.push(`week ${weekUsed}`);
  if (!fiveUsed && !weekUsed) parts.push('usage shows after the first reply');
  const context = pct(input.context_window?.used_percentage);
  if (context) parts.push(`context ${context}`);
  return parts.join(' · ');
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    let input: StatusInput = {};
    try {
      input = JSON.parse(raw) as StatusInput;
    } catch {
      // Nothing readable: still say which account this is.
    }
    const thresholds = readThresholds(process.env.CLAUDES_STATUS_CONFIG);
    process.stdout.write(formatStatus(input, process.env.CLAUDES_ACCOUNT_NAME || 'ClaudeS', thresholds));
  });
}
