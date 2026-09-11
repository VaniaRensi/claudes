// Run by test-delete.ps1, in VS Code's own runtime (ELECTRON_RUN_AS_NODE).
// Deletes <root>/acct, which links to <root>/main, and reports whether a single
// file of <root>/main was lost. Exit code 1 means it was.
const fs = require('fs');
const path = require('path');
const [root, repo] = process.argv.slice(2);
const main = path.join(root, 'main');

function count(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? count(path.join(dir, e.name)) : 1;
  }
  return n;
}

const before = count(main);
let outcome;
try {
  require(path.join(repo, 'dist', 'deletion.js')).deleteConfigFolder(
    path.join(root, 'acct'),
    path.join(root, 'not-the-main-install')
  );
  outcome = 'deleted';
} catch (e) {
  outcome = `stopped (${e.code || e.message})`;
}
const after = count(main);
console.log(`  ${outcome}; linked installation ${before} -> ${after} files`);
process.exit(after === before ? 0 : 1);
