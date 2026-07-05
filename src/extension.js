const vscode = require('vscode');
const { SolutionTreeProvider } = require('./solutionTreeProvider');

function activate(context) {
  const provider = new SolutionTreeProvider(context);
  const treeView = vscode.window.createTreeView(SolutionTreeProvider.viewType, {
    treeDataProvider: provider,
    canSelectMany: true,
    showCollapseAll: true
  });
  provider.setTreeView(treeView);

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('solutionManager.open', () => provider.focus()),
    vscode.commands.registerCommand('solutionManager.openSolutionFile', () => provider.openSolutionFile()),
    vscode.commands.registerCommand('solutionManager.refresh', () => provider.refresh({ userVisible: true })),
    vscode.commands.registerCommand('solutionManager.scanWorkspace', () => provider.scanWorkspace()),
    vscode.commands.registerCommand('solutionManager.addProject', () => provider.addProject()),
    vscode.commands.registerCommand('solutionManager.build', () => provider.pickAndRun('build')),
    vscode.commands.registerCommand('solutionManager.test', () => provider.pickAndRun('test')),
    vscode.commands.registerCommand('solutionManager.openTreeItem', (node) => provider.openTreeItem(node)),
    vscode.commands.registerCommand('solutionManager.buildTreeItem', (node) => provider.runTreeItem('build', node)),
    vscode.commands.registerCommand('solutionManager.testTreeItem', (node) => provider.runTreeItem('test', node)),
    vscode.commands.registerCommand('solutionManager.addNewCSharpClass', (node) => provider.runProjectAction('addNewCSharpClass', node)),
    vscode.commands.registerCommand('solutionManager.addNewFile', (node) => provider.runProjectAction('addNewFile', node)),
    vscode.commands.registerCommand('solutionManager.addNewFolder', (node) => provider.runProjectAction('addNewFolder', node)),
    vscode.commands.registerCommand('solutionManager.addProjectReference', (node) => provider.runProjectAction('addProjectReference', node)),
    vscode.commands.registerCommand('solutionManager.manageNuGetPackages', (node) => provider.runProjectAction('manageNuGetPackages', node)),
    vscode.commands.registerCommand('solutionManager.unloadProject', (node) => provider.runProjectAction('unloadProject', node)),
    vscode.commands.registerCommand('solutionManager.reloadProject', (node) => provider.runProjectAction('reloadProject', node)),
    vscode.commands.registerCommand('solutionManager.efAddMigration', (node) => provider.runProjectAction('efAddMigration', node)),
    vscode.commands.registerCommand('solutionManager.efRemoveMigration', (node) => provider.runProjectAction('efRemoveMigration', node)),
    vscode.commands.registerCommand('solutionManager.efUpdateDatabase', (node) => provider.runProjectAction('efUpdateDatabase', node)),
    vscode.commands.registerCommand('solutionManager.efScriptMigration', (node) => provider.runProjectAction('efScriptMigration', node)),
    vscode.commands.registerCommand('solutionManager.buildSelectedProjects', (node) => provider.runProjectAction('buildSelectedProjects', node)),
    vscode.commands.registerCommand('solutionManager.runUnitTest', (node) => provider.runProjectAction('runUnitTest', node)),
    vscode.commands.registerCommand('solutionManager.publishProject', (node) => provider.runProjectAction('publishProject', node)),
    vscode.commands.registerCommand('solutionManager.restoreProject', (node) => provider.runProjectAction('restoreProject', node)),
    vscode.commands.registerCommand('solutionManager.cleanProject', (node) => provider.runProjectAction('cleanProject', node)),
    vscode.commands.registerCommand('solutionManager.rebuildProject', (node) => provider.runProjectAction('rebuildProject', node)),
    vscode.commands.registerCommand('solutionManager.packProject', (node) => provider.runProjectAction('packProject', node)),
    vscode.commands.registerCommand('solutionManager.gitStatusProject', (node) => provider.runProjectAction('gitStatusProject', node)),
    vscode.commands.registerCommand('solutionManager.gitDiffProject', (node) => provider.runProjectAction('gitDiffProject', node)),
    vscode.commands.registerCommand('solutionManager.gitLogProject', (node) => provider.runProjectAction('gitLogProject', node)),
    vscode.commands.registerCommand('solutionManager.copyFullPath', (node) => provider.runProjectAction('copyFullPath', node)),
    vscode.commands.registerCommand('solutionManager.copyRelativePath', (node) => provider.runProjectAction('copyRelativePath', node)),
    vscode.commands.registerCommand('solutionManager.copyProjectReferenceXml', (node) => provider.runProjectAction('copyProjectReferenceXml', node)),
    vscode.commands.registerCommand('solutionManager.copyProjectName', (node) => provider.runProjectAction('copyProjectName', node)),
    vscode.commands.registerCommand('solutionManager.openInEditor', (node) => provider.runProjectAction('openInEditor', node)),
    vscode.commands.registerCommand('solutionManager.openInExplorer', (node) => provider.runProjectAction('openInExplorer', node)),
    vscode.commands.registerCommand('solutionManager.openInTerminal', (node) => provider.runProjectAction('openInTerminal', node)),
    vscode.commands.registerCommand('solutionManager.showProperties', (node) => provider.runProjectAction('showProperties', node))
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
