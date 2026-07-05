const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = [
  'src/extension.js',
  'src/projectActions.js',
  'src/projectPropertiesView.js',
  'src/solutionTreeProvider.js',
  'src/terminalRunner.js',
  'src/workspaceScanner.js',
  'scripts/validate.js'
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', path.join(process.cwd(), file)], {
    stdio: 'inherit'
  });
}

validateManifest();

console.log(`Validated ${files.length} JavaScript files.`);

function validateManifest() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const extensionSource = fs.readFileSync(path.join(process.cwd(), 'src/extension.js'), 'utf8');
  const contributedCommands = new Set(packageJson.contributes.commands.map((command) => command.command));
  const registeredCommands = new Set([...extensionSource.matchAll(/registerCommand\('([^']+)'/g)].map((match) => match[1]));
  const missingRegistrations = [...contributedCommands].filter((command) => !registeredCommands.has(command));

  if (missingRegistrations.length > 0) {
    throw new Error(`Commands are contributed but not registered: ${missingRegistrations.join(', ')}`);
  }

  const submenuIds = new Set((packageJson.contributes.submenus || []).map((submenu) => submenu.id));
  const menus = packageJson.contributes.menus || {};

  for (const [location, entries] of Object.entries(menus)) {
    for (const entry of entries) {
      if (entry.command && !contributedCommands.has(entry.command)) {
        throw new Error(`Menu ${location} references an unknown command: ${entry.command}`);
      }

      if (entry.submenu && !submenuIds.has(entry.submenu)) {
        throw new Error(`Menu ${location} references an unknown submenu: ${entry.submenu}`);
      }
    }
  }
}
