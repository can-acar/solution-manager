import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { SolutionTreeProvider } from '#src/solutionTreeProvider';

function activate(context) {
  registerDevelopmentAutoReload(context);
  updateAspireTemplateContext();

  const provider = new SolutionTreeProvider(context);
  const treeView = vscode.window.createTreeView(SolutionTreeProvider.viewType, {
    treeDataProvider: provider,
    canSelectMany: true,
    showCollapseAll: true,
    dragAndDropController: provider.getDragAndDropController()
  });
  provider.setTreeView(treeView);

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('solutionManager.open', () => provider.focus()),
    vscode.commands.registerCommand('solutionManager.openSolutionFile', () => provider.openSolutionFile()),
    vscode.commands.registerCommand('solutionManager.refresh', () => provider.refresh({ userVisible: true, force: true })),
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
    vscode.commands.registerCommand('solutionManager.addPackageReference', (node) => provider.runProjectAction('addPackageReference', node)),
    vscode.commands.registerCommand('solutionManager.addAssemblyReference', (node) => provider.runProjectAction('addAssemblyReference', node)),
    vscode.commands.registerCommand('solutionManager.addFrameworkReference', (node) => provider.runProjectAction('addFrameworkReference', node)),
    vscode.commands.registerCommand('solutionManager.addAnalyzerReference', (node) => provider.runProjectAction('addAnalyzerReference', node)),
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
    vscode.commands.registerCommand('solutionManager.showProperties', (node) => provider.runProjectAction('showProperties', node)),
    vscode.commands.registerCommand('solutionManager.projectFindInFiles', (node) => provider.runProjectAction('findInFiles', node)),
    vscode.commands.registerCommand('solutionManager.projectReplaceInFiles', (node) => provider.runProjectAction('replaceInFiles', node)),
    vscode.commands.registerCommand('solutionManager.projectFindFile', (node) => provider.runProjectAction('findFile', node)),
    vscode.commands.registerCommand('solutionManager.dependencyPackageDetails', (node) => provider.runDependencyAction('packageDetails', node)),
    vscode.commands.registerCommand('solutionManager.dependencyOpenNuGet', (node) => provider.runDependencyAction('openNuGet', node)),
    vscode.commands.registerCommand('solutionManager.dependencyOpenPackageFolder', (node) => provider.runDependencyAction('openPackageFolder', node)),
    vscode.commands.registerCommand('solutionManager.dependencyCopyPackageId', (node) => provider.runDependencyAction('copyPackageId', node)),
    vscode.commands.registerCommand('solutionManager.dependencyCopyPackageFolder', (node) => provider.runDependencyAction('copyPackageFolder', node)),
    vscode.commands.registerCommand('solutionManager.dependencyCopyPackageReference', (node) => provider.runDependencyAction('copyPackageReference', node)),
    vscode.commands.registerCommand('solutionManager.dependencyCopyPackageSourceMapping', (node) => provider.runDependencyAction('copyPackageSourceMappingXml', node)),
    vscode.commands.registerCommand('solutionManager.dependencyGroupDetails', (node) => provider.runDependencyAction('dependencyDetails', node)),
    vscode.commands.registerCommand('solutionManager.dependencyUpdatePackage', (node) => provider.runDependencyAction('updatePackage', node)),
    vscode.commands.registerCommand('solutionManager.dependencyRemovePackage', (node) => provider.runDependencyAction('removePackage', node)),
    vscode.commands.registerCommand('solutionManager.dependencyListPackages', (node) => provider.runDependencyAction('listPackages', node)),
    vscode.commands.registerCommand('solutionManager.dependencyReferenceDetails', (node) => provider.runDependencyReferenceAction('referenceDetails', node)),
    vscode.commands.registerCommand('solutionManager.dependencyOpenReference', (node) => provider.runDependencyReferenceAction('openReference', node)),
    vscode.commands.registerCommand('solutionManager.dependencyOpenReferenceFolder', (node) => provider.runDependencyReferenceAction('openReferenceFolder', node)),
    vscode.commands.registerCommand('solutionManager.dependencyCopyReferenceName', (node) => provider.runDependencyReferenceAction('copyReferenceName', node)),
    vscode.commands.registerCommand('solutionManager.dependencyCopyReferencePath', (node) => provider.runDependencyReferenceAction('copyReferencePath', node)),
    vscode.commands.registerCommand('solutionManager.dependencyCopyReferenceXml', (node) => provider.runDependencyReferenceAction('copyReferenceXml', node)),
    vscode.commands.registerCommand('solutionManager.dependencyRemoveReference', (node) => provider.runDependencyReferenceAction('removeReference', node)),
    vscode.commands.registerCommand('solutionManager.dependencyRemoveProjectReference', (node) => provider.runDependencyReferenceAction('removeProjectReference', node)),
    vscode.commands.registerCommand('solutionManager.dependencyFrameworkDetails', (node) => provider.runDependencyFrameworkAction('frameworkDetails', node)),
    vscode.commands.registerCommand('solutionManager.dependencyBuildFramework', (node) => provider.runDependencyFrameworkAction('build', node)),
    vscode.commands.registerCommand('solutionManager.dependencyTestFramework', (node) => provider.runDependencyFrameworkAction('test', node)),
    vscode.commands.registerCommand('solutionManager.dependencyCopyFramework', (node) => provider.runDependencyFrameworkAction('copyFramework', node)),
    vscode.commands.registerCommand('solutionManager.solutionAddNewProject', (node) => provider.runSolutionAction('addNewProject', node)),
    vscode.commands.registerCommand('solutionManager.solutionAddSolutionFolder', (node) => provider.runSolutionAction('addSolutionFolder', node)),
    vscode.commands.registerCommand('solutionManager.solutionAddDockerComposeFile', (node) => provider.runSolutionAction('addDockerComposeFile', node)),
    vscode.commands.registerCommand('solutionManager.solutionAddAspireOrchestration', (node) => provider.runSolutionAction('addAspireOrchestration', node)),
    vscode.commands.registerCommand('solutionManager.solutionAddExistingProject', (node) => provider.runSolutionAction('addExistingProject', node)),
    vscode.commands.registerCommand('solutionManager.solutionAddExistingFolder', (node) => provider.runSolutionAction('addExistingFolder', node)),
    vscode.commands.registerCommand('solutionManager.solutionManageNuGetPackages', (node) => provider.runSolutionAction('manageNuGetPackages', node)),
    vscode.commands.registerCommand('solutionManager.solutionUnloadProjects', (node) => provider.runSolutionAction('unloadProjects', node)),
    vscode.commands.registerCommand('solutionManager.solutionLoadProjects', (node) => provider.runSolutionAction('loadProjects', node)),
    vscode.commands.registerCommand('solutionManager.solutionLoadProjectsWithDependencies', (node) => provider.runSolutionAction('loadProjectsWithDependencies', node)),
    vscode.commands.registerCommand('solutionManager.solutionReloadAllProjects', (node) => provider.runSolutionAction('reloadAllProjects', node)),
    vscode.commands.registerCommand('solutionManager.solutionSaveAs', (node) => provider.runSolutionAction('saveAs', node)),
    vscode.commands.registerCommand('solutionManager.solutionEfAddMigration', (node) => provider.runSolutionAction('efAddMigration', node)),
    vscode.commands.registerCommand('solutionManager.solutionEfRemoveMigration', (node) => provider.runSolutionAction('efRemoveMigration', node)),
    vscode.commands.registerCommand('solutionManager.solutionEfUpdateDatabase', (node) => provider.runSolutionAction('efUpdateDatabase', node)),
    vscode.commands.registerCommand('solutionManager.solutionEfScriptMigration', (node) => provider.runSolutionAction('efScriptMigration', node)),
    vscode.commands.registerCommand('solutionManager.solutionBuild', (node) => provider.runSolutionAction('buildSolution', node)),
    vscode.commands.registerCommand('solutionManager.solutionRunMultipleProjects', (node) => provider.runSolutionAction('runMultipleProjects', node)),
    vscode.commands.registerCommand('solutionManager.solutionRunUnitTests', (node) => provider.runSolutionAction('runUnitTests', node)),
    vscode.commands.registerCommand('solutionManager.solutionPublish', (node) => provider.runSolutionAction('publish', node)),
    vscode.commands.registerCommand('solutionManager.solutionRestore', (node) => provider.runSolutionAction('restore', node)),
    vscode.commands.registerCommand('solutionManager.solutionClean', (node) => provider.runSolutionAction('clean', node)),
    vscode.commands.registerCommand('solutionManager.solutionRebuild', (node) => provider.runSolutionAction('rebuild', node)),
    vscode.commands.registerCommand('solutionManager.solutionPack', (node) => provider.runSolutionAction('pack', node)),
    vscode.commands.registerCommand('solutionManager.solutionGitStatus', (node) => provider.runSolutionAction('gitStatus', node)),
    vscode.commands.registerCommand('solutionManager.solutionGitDiff', (node) => provider.runSolutionAction('gitDiff', node)),
    vscode.commands.registerCommand('solutionManager.solutionGitLog', (node) => provider.runSolutionAction('gitLog', node)),
    vscode.commands.registerCommand('solutionManager.solutionEditFile', (node) => provider.runSolutionAction('editSolutionFile', node)),
    vscode.commands.registerCommand('solutionManager.solutionCopyFullPath', (node) => provider.runSolutionAction('copyFullPath', node)),
    vscode.commands.registerCommand('solutionManager.solutionCopyRelativePath', (node) => provider.runSolutionAction('copyRelativePath', node)),
    vscode.commands.registerCommand('solutionManager.solutionCopyName', (node) => provider.runSolutionAction('copySolutionName', node)),
    vscode.commands.registerCommand('solutionManager.solutionOpenInEditor', (node) => provider.runSolutionAction('openInEditor', node)),
    vscode.commands.registerCommand('solutionManager.solutionOpenInExplorer', (node) => provider.runSolutionAction('openInExplorer', node)),
    vscode.commands.registerCommand('solutionManager.solutionOpenInTerminal', (node) => provider.runSolutionAction('openInTerminal', node)),
    vscode.commands.registerCommand('solutionManager.solutionProperties', (node) => provider.runSolutionAction('showProperties', node)),
    vscode.commands.registerCommand('solutionManager.solutionFindInFiles', (node) => provider.runSolutionAction('findInFiles', node)),
    vscode.commands.registerCommand('solutionManager.solutionReplaceInFiles', (node) => provider.runSolutionAction('replaceInFiles', node)),
    vscode.commands.registerCommand('solutionManager.solutionFindFile', (node) => provider.runSolutionAction('findFile', node)),
    vscode.commands.registerCommand('solutionManager.fileRename', (node) => provider.runFileAction('rename', node)),
    vscode.commands.registerCommand('solutionManager.fileDelete', (node, nodes) => provider.runFileAction('delete', node, nodes)),
    vscode.commands.registerCommand('solutionManager.fileCut', (node, nodes) => provider.runFileAction('cut', node, nodes)),
    vscode.commands.registerCommand('solutionManager.fileCopy', (node, nodes) => provider.runFileAction('copy', node, nodes)),
    vscode.commands.registerCommand('solutionManager.filePaste', (node) => provider.runFileAction('paste', node)),
    vscode.commands.registerCommand('solutionManager.fileRevealInOS', (node) => provider.runFileAction('revealInOS', node)),
    vscode.commands.registerCommand('solutionManager.fileOpenToSide', (node) => provider.runFileAction('openToSide', node)),
    vscode.commands.registerCommand('solutionManager.fileCopyPath', (node) => provider.runFileAction('copyPath', node)),
    vscode.commands.registerCommand('solutionManager.fileCopyRelativePath', (node) => provider.runFileAction('copyRelativePath', node))
  );
}

function deactivate() {}

function registerDevelopmentAutoReload(context) {
  if (context.extensionMode !== vscode.ExtensionMode.Development) {
    return;
  }

  const activatedAt = Date.now();
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let buildTimer;
  let buildInProgress = false;
  let pendingBuildScript;
  let reloadTimer;

  const scheduleReload = () => {
    if (Date.now() - activatedAt < 1500) {
      return;
    }

    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }

    reloadTimer = setTimeout(() => {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }, 600);
  };

  const scheduleBuildAndReload = (script) => {
    if (Date.now() - activatedAt < 1500) {
      return;
    }

    pendingBuildScript = script;

    if (buildTimer) {
      clearTimeout(buildTimer);
    }

    buildTimer = setTimeout(() => runPendingBuild(), 450);
  };

  const runPendingBuild = () => {
    if (buildInProgress || !pendingBuildScript) {
      return;
    }

    const script = pendingBuildScript;
    pendingBuildScript = undefined;
    buildInProgress = true;

    execFile(
      npmCommand,
      ['run', script],
      {
        cwd: context.extensionPath,
        maxBuffer: 1024 * 1024 * 5
      },
      (error) => {
        buildInProgress = false;

        if (error) {
          vscode.window.showErrorMessage(`Solution Manager development build failed: npm run ${script}`);
          return;
        }

        scheduleReload();

        if (pendingBuildScript) {
          runPendingBuild();
        }
      }
    );
  };

  const registerWatcher = (pattern, handler) => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.extensionPath, pattern));
    watcher.onDidCreate(handler, undefined, context.subscriptions);
    watcher.onDidChange(handler, undefined, context.subscriptions);
    watcher.onDidDelete(handler, undefined, context.subscriptions);
    context.subscriptions.push(watcher);
  };

  registerWatcher('src/**/*.ts', () => scheduleBuildAndReload('compile:ts'));
  registerWatcher('src/protocol-host/**/*.cs', () => scheduleBuildAndReload('compile:protocol-host'));
  registerWatcher('src/protocol-host/**/*.csproj', () => scheduleBuildAndReload('compile:protocol-host'));
  registerWatcher('dist/**/*.js', scheduleReload);
  registerWatcher('dist/**/*.json', scheduleReload);
  registerWatcher('media/**/*', scheduleReload);
  registerWatcher('package.json', scheduleReload);

  context.subscriptions.push({
    dispose: () => {
      if (buildTimer) {
        clearTimeout(buildTimer);
      }
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }
    }
  });
}

function updateAspireTemplateContext() {
  vscode.commands.executeCommand('setContext', 'solutionManager.hasAspireTemplate', false);
  execFile('dotnet', ['new', 'list', 'aspire'], { timeout: 5000 }, (error, stdout) => {
    const hasAspireTemplate = !error && /aspire/i.test(stdout || '');
    vscode.commands.executeCommand('setContext', 'solutionManager.hasAspireTemplate', hasAspireTemplate);
  });
}

export {
  activate,
  deactivate
};
