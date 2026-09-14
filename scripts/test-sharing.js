// Checks that nothing a conversation said crosses into another account.
// Builds a fake main installation and account in a temporary folder, runs the
// sync from dist/sharing.js, and fails on the first thing that crossed or was
// lost. Run: node scripts/test-sharing.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncProjectSettings } = require(path.join(__dirname, '..', 'dist', 'sharing.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudes-sharing-'));
const main = path.join(root, 'main');
const acct = path.join(root, 'acct');
fs.mkdirSync(main);
fs.mkdirSync(path.join(acct, 'projects', 'C--Work-Own'), { recursive: true });
// The account's own conversation: a transcript in its folder.
fs.writeFileSync(path.join(acct, 'projects', 'C--Work-Own', 'own-session.jsonl'), '{}\n');

const conversation = (id, prompt) => ({
  lastSessionId: id,
  lastSessionFirstPrompt: prompt,
  lastCost: 1.5,
  lastModelUsage: { x: 1 },
  lastTotalInputTokens: 100
});

fs.writeFileSync(path.join(main, '.credentials.json'), '{"login":"main"}');
fs.writeFileSync(
  path.join(main, '.claude.json'),
  JSON.stringify({
    oauthAccount: { emailAddress: 'main@example.com' },
    mcpServers: { shared: { type: 'http', url: 'https://example.com' } },
    projects: {
      'C:/Work/ClientA': { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'], ...conversation('main-a', 'SECRET OF CLIENT A') },
      'C:/Work/Own': { hasTrustDialogAccepted: true, ...conversation('main-own', 'SECRET FROM MAIN') },
      'c:/Work/Spelled': { hasTrustDialogAccepted: false },
      'C:/Work/Spelled': { hasTrustDialogAccepted: true, mcpServers: { s: { type: 'http' } } }
    }
  })
);
fs.writeFileSync(
  path.join(acct, '.claude.json'),
  JSON.stringify({
    oauthAccount: { emailAddress: 'acct@example.com' },
    projects: {
      'C:/Work/Own': { hasTrustDialogAccepted: true, allowedTools: ['Bash(git status)'], ...conversation('own-session', 'my own prompt') },
      // Copied by an earlier version: a conversation this account never had.
      'C:/Work/Old': { hasTrustDialogAccepted: true, ...conversation('someone-else', 'SECRET COPIED BEFORE') },
      'C:\\Work\\Spelled': { hasTrustDialogAccepted: false }
    }
  })
);

let failures = 0;
function check(what, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const result = syncProjectSettings(main, acct);
check('sync reports no error', !result.error);
const after = JSON.parse(fs.readFileSync(path.join(acct, '.claude.json'), 'utf8'));
const text = JSON.stringify(after);
const p = after.projects;

check('no prompt from another installation', !text.includes('SECRET'));
check('no conversation id from another installation', !text.includes('main-a') && !text.includes('main-own') && !text.includes('someone-else'));
check("a new folder brings only its settings", JSON.stringify(Object.keys(p['C:/Work/ClientA']).sort()) === JSON.stringify(['allowedTools', 'hasTrustDialogAccepted']));
check("the account's own conversation is kept", p['C:/Work/Own'].lastSessionFirstPrompt === 'my own prompt' && p['C:/Work/Own'].lastSessionId === 'own-session');
check("the account's own permissions win", JSON.stringify(p['C:/Work/Own'].allowedTools) === '["Bash(git status)"]');
check('a folder copied earlier keeps its trust', p['C:/Work/Old'].hasTrustDialogAccepted === true);
check('the login stays the account\'s own', after.oauthAccount.emailAddress === 'acct@example.com');
check('MCP servers are shared', !!after.mcpServers && !!after.mcpServers.shared);
const spellings = ['c:/Work/Spelled', 'C:/Work/Spelled', 'C:\\Work\\Spelled'];
check('every spelling of a folder is kept', spellings.every((k) => p[k]));
check('every spelling is trusted', spellings.every((k) => p[k] && p[k].hasTrustDialogAccepted === true));
check('every spelling gets the MCP servers', spellings.every((k) => p[k] && p[k].mcpServers && p[k].mcpServers.s));

const second = syncProjectSettings(main, acct);
const again = fs.readFileSync(path.join(acct, '.claude.json'), 'utf8');
check('a second sync changes nothing', !second.error && again === JSON.stringify(after, null, 2));

// With no main installation file at all, what is not the account's is still removed.
const lone = path.join(root, 'lone');
fs.mkdirSync(lone);
fs.writeFileSync(path.join(lone, '.claude.json'), JSON.stringify({ projects: { 'C:/X': { hasTrustDialogAccepted: true, ...conversation('elsewhere', 'SECRET WITH NO MAIN') } } }));
const loneResult = syncProjectSettings(path.join(root, 'no-main-here'), lone);
const loneText = fs.readFileSync(path.join(lone, '.claude.json'), 'utf8');
check('cleaned even without a main installation', !loneResult.error && !loneText.includes('SECRET') && JSON.parse(loneText).projects['C:/X'].hasTrustDialogAccepted === true);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? 'All cases passed: nothing a conversation said crossed over.' : `${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
