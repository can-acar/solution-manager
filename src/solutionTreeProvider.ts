// @ts-nocheck
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectActions } from '#src/projectActions';
import { SolutionActions } from '#src/solutionActions';
import { PACKAGE_ASSET_GROUPS } from '#src/projectAssetsReader';
import { updateProjectItemReferences } from '#src/projectFileEditor';
import { TerminalRunner, quoteForShell } from '#src/terminalRunner';
import {
  WorkspaceScanner,
  enrichPackagesWithPackageSourceMappings
} from '#src/workspaceScanner';

const UNLOADED_PROJECTS_KEY = 'solutionManager.unloadedProjects';
const PROJECT_EXTENSIONS = new Set(['.csproj', '.fsproj', '.vbproj', '.proj']);
const SOLUTION_EXTENSIONS = new Set(['.sln', '.slnx']);
const SKIPPED_DIRECTORY_NAMES = new Set([
  '.git',
  '.vs',
  'bin',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'out',
  'packages'
]);

class SolutionTreeProvider {
  static viewType = 'solutionManager.solutionView';

  constructor(context) {
    this.context = context;
    this.scanner = new WorkspaceScanner(context);
    this.terminalRunner = new TerminalRunner();
    this.projectActions = new ProjectActions(
      context,
      this.terminalRunner,
      (options) => this.refresh(options),
      () => this.getState()
    );
    this.solutionActions = new SolutionActions(context, this.terminalRunner, {
      refresh: (options) => this.refresh(options),
      getState: () => this.getState(),
      openUri: (uri) => this.openUri(uri),
      addCustomItems: (uris) => this.scanner.addCustomItems(uris),
      runProjectAction: (action, node) => this.runProjectAction(action, node),
      getUnloadedProjectUris: () => this.getUnloadedProjectUris(),
      setUnloadedProjectUris: (uris) => this.setUnloadedProjectUris(uris)
    });
    this.onDidChangeTreeDataEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    this.currentState = undefined;
    this.treeView = undefined;
  }

  setTreeView(treeView) {
    this.treeView = treeView;
  }

  async focus() {
    await vscode.commands.executeCommand('workbench.view.extension.solutionManager');
  }

  async scanWorkspace() {
    await this.focus().catch(() => undefined);
    await this.refresh({ userVisible: true });
  }

  async refresh(options = {}) {
    this.currentState = await this.scanner.scan();
    this.updateViewTitle(this.currentState);
    this.onDidChangeTreeDataEmitter.fire();

    if (options.userVisible) {
      vscode.window.setStatusBarMessage('Solution Manager: solution tree refreshed.', 2500);
    }
  }

  async addProject() {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Add to Solution Manager',
      filters: {
        'Solution and project files': ['sln', 'slnx', 'csproj', 'fsproj', 'vbproj', 'proj']
      }
    });

    if (!selection || selection.length === 0) {
      return;
    }

    await this.scanner.addCustomItems(selection);
    await this.refresh({ userVisible: true });
  }

  async openSolutionFile() {
    const state = await this.getState();
    const candidates = uniqueItemsByUri([
      ...state.solutions,
      ...state.customItems.filter(isSolutionItem)
    ]);

    if (candidates.length === 0) {
      vscode.window.showInformationMessage('Solution Manager: no .sln or .slnx files were found.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      candidates.map((item) => ({
        label: item.fileName,
        description: item.relativePath,
        detail: item.extension,
        item
      })),
      {
        title: 'Solution Manager: Open Solution File',
        placeHolder: 'Select a .sln or .slnx file to open'
      }
    );

    if (pick) {
      await this.openItem(pick.item, { expectedSolution: true });
    }
  }

  async pickAndRun(action) {
    const state = await this.getState();
    const candidates = [
      ...state.solutions,
      ...state.projects,
      ...state.customItems
    ];

    if (candidates.length === 0) {
      vscode.window.showInformationMessage('Solution Manager: no solution or project files were found.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      candidates.map((item) => ({
        label: item.fileName,
        description: item.relativePath,
        detail: item.kind,
        item
      })),
      {
        title: `Solution Manager: ${capitalize(action)}`,
        placeHolder: `Select a solution or project to ${action}`
      }
    );

    if (pick) {
      this.runTerminalAction(action, pick.item);
    }
  }

  async getTreeItem(node) {
    const item = new vscode.TreeItem(node.label, node.collapsibleState);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip || node.item?.path || node.uri?.fsPath || node.label;
    item.contextValue = node.contextValue;
    item.resourceUri = node.resourceUri;
    const icon = getIcon(node);

    if (icon) {
      item.iconPath = icon;
    }

    if (node.kind === 'file' || (node.kind === 'dependencyItem' && node.uri)) {
      item.command = {
        command: 'solutionManager.openTreeItem',
        title: 'Open',
        arguments: [node]
      };
    }

    return item;
  }

  async getChildren(node) {
    if (!node) {
      return this.getRootNodes();
    }

    switch (node.kind) {
      case 'solution':
        return node.children;
      case 'group':
        return node.children;
      case 'project':
        return this.getProjectChildren(node);
      case 'dependencies':
        return getDependencyChildren(node.item);
      case 'dependencyImports':
        return getDependencyImportChildren(node.item);
      case 'dependencyFramework':
        return getDependencyFrameworkChildren(node.item, node.framework);
      case 'dependencyGroup':
        return node.children || [];
      case 'dependencyPackage':
        return getDependencyPackageChildren(node.item, node.reference);
      case 'directory':
        return this.getDirectoryChildren(node.uri, node.projectPath);
      default:
        return [];
    }
  }

  async getRootNodes() {
    const state = await this.getState();
    state.unloadedProjects = this.getUnloadedProjectUris();
    this.updateViewTitle(state);

    if (!state.hasWorkspace && state.customItems.length === 0) {
      return [
        createMessageNode('no-workspace', 'Open a workspace to see solutions')
      ];
    }

    const solutionNodes = state.solutions.map((solution) => createSolutionNode(solution, state));
    const pinnedSolutionNodes = state.customItems
      .filter(isSolutionItem)
      .filter((item) => !solutionNodes.some((node) => node.item.uri === item.uri))
      .map((solution) => createSolutionNode(solution, state));
    const looseProjects = state.solutions.length === 0
      ? state.projects.map((project) => createProjectNode(project, state.unloadedProjects))
      : state.customItems
        .filter((item) => item.kind === 'project')
        .map((project) => createProjectNode(project, state.unloadedProjects));

    return [
      ...solutionNodes,
      ...pinnedSolutionNodes,
      ...looseProjects
    ];
  }

  async getProjectChildren(node) {
    if (this.isProjectUnloaded(node.item)) {
      return [];
    }

    const projectDirectory = vscode.Uri.file(path.dirname(node.item.path));
    const children = [
      {
        id: `dependencies:${node.item.uri}`,
        kind: 'dependencies',
        label: 'Dependencies',
        item: node.item,
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: 'dependencies'
      },
      ...await this.getDirectoryChildren(projectDirectory, node.item.path)
    ];

    return children;
  }

  async getDirectoryChildren(directoryUri, projectPath) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(directoryUri);
      const nodes = [];

      for (const [name, type] of entries) {
        if (shouldSkipDirectoryEntry(name, type)) {
          continue;
        }

        const uri = vscode.Uri.joinPath(directoryUri, name);

        if (isProjectFile(uri.fsPath) && normalizePath(uri.fsPath) === normalizePath(projectPath)) {
          continue;
        }

        if (type & vscode.FileType.Directory) {
          nodes.push(createDirectoryNode(uri, projectPath));
          continue;
        }

        if (type & vscode.FileType.File) {
          nodes.push(createFileNode(uri));
        }
      }

      return sortNodes(nodes);
    } catch {
      return [];
    }
  }

  async openTreeItem(node) {
    if (!node) {
      return;
    }

    if ((node.kind === 'dependencyItem' || node.kind === 'dependencyPackage') && node.uri) {
      await this.openUri(node.uri);
      return;
    }

    if (node.item) {
      await this.openItem(node.item);
      return;
    }

    if (node.uri) {
      await this.openUri(node.uri);
    }
  }

  runTreeItem(action, node) {
    if (!node || !node.item) {
      return;
    }

    this.runTerminalAction(action, node.item);
  }

  async runProjectAction(action, node) {
    try {
      switch (action) {
        case 'addNewCSharpClass':
          await this.projectActions.addNewCSharpClass(node);
          break;
        case 'addNewFile':
          await this.projectActions.addNewFile(node);
          break;
        case 'addNewFolder':
          await this.projectActions.addNewFolder(node);
          break;
        case 'addProjectReference':
          await this.projectActions.addProjectReference(node);
          break;
        case 'addPackageReference':
          await this.projectActions.addPackageReference(node);
          break;
        case 'addAssemblyReference':
          await this.projectActions.addAssemblyReference(node);
          break;
        case 'addFrameworkReference':
          await this.projectActions.addFrameworkReference(node);
          break;
        case 'addAnalyzerReference':
          await this.projectActions.addAnalyzerReference(node);
          break;
        case 'manageNuGetPackages':
          await this.projectActions.manageNuGetPackages(node);
          break;
        case 'unloadProject':
          await this.unloadProject(node);
          break;
        case 'reloadProject':
          await this.reloadProject(node);
          break;
        case 'efAddMigration':
          await this.projectActions.runEfAction('addMigration', node);
          break;
        case 'efRemoveMigration':
          await this.projectActions.runEfAction('removeMigration', node);
          break;
        case 'efUpdateDatabase':
          await this.projectActions.runEfAction('updateDatabase', node);
          break;
        case 'efScriptMigration':
          await this.projectActions.runEfAction('scriptMigration', node);
          break;
        case 'buildSelectedProjects':
          await this.buildSelectedProjects(node);
          break;
        case 'runUnitTest':
          await this.projectActions.runDotnetAction('test', node);
          break;
        case 'publishProject':
          await this.projectActions.runDotnetAction('publish', node);
          break;
        case 'restoreProject':
          await this.projectActions.runDotnetAction('restore', node);
          break;
        case 'cleanProject':
          await this.projectActions.runDotnetAction('clean', node);
          break;
        case 'rebuildProject':
          await this.rebuildProject(node);
          break;
        case 'packProject':
          await this.projectActions.runDotnetAction('pack', node);
          break;
        case 'gitStatusProject':
          await this.projectActions.runGitAction('status', node);
          break;
        case 'gitDiffProject':
          await this.projectActions.runGitAction('diff', node);
          break;
        case 'gitLogProject':
          await this.projectActions.runGitAction('log', node);
          break;
        case 'copyFullPath':
          await this.projectActions.copyValue('fullPath', node);
          break;
        case 'copyRelativePath':
          await this.projectActions.copyValue('relativePath', node);
          break;
        case 'copyProjectReferenceXml':
          await this.projectActions.copyValue('projectReferenceXml', node);
          break;
        case 'copyProjectName':
          await this.projectActions.copyValue('projectName', node);
          break;
        case 'openInEditor':
          await this.projectActions.openIn('editor', node);
          break;
        case 'openInExplorer':
          await this.projectActions.openIn('explorer', node);
          break;
        case 'openInTerminal':
          await this.projectActions.openIn('terminal', node);
          break;
        case 'showProperties':
          await this.projectActions.showProperties(node);
          break;
        default:
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Solution Manager: ${message}`);
    }
  }

  async runSolutionAction(action, node) {
    try {
      await this.solutionActions.run(action, node);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Solution Manager: ${message}`);
    }
  }

  async runDependencyAction(action, node) {
    try {
      if (action === 'dependencyDetails' && (node?.kind === 'dependencies' || node?.kind === 'dependencyImports' || node?.kind === 'dependencyGroup')) {
        await showDependencyNodeDetails(node);
        return;
      }

      if (action === 'listPackages' && (node?.kind === 'dependencyGroup' || node?.kind === 'dependencies') && node.item?.path) {
        const command = `dotnet list ${quoteForShell(node.item.path)} package --include-transitive`;
        this.terminalRunner.runCommand(command);
        return;
      }

      const packageInfo = getDependencyPackageInfo(node);

      if (!packageInfo) {
        vscode.window.showInformationMessage('Solution Manager: no package was selected.');
        return;
      }

      if (action === 'packageDetails') {
        await showDependencyPackageDetails(packageInfo);
        return;
      }

      if (action === 'openNuGet') {
        await vscode.env.openExternal(vscode.Uri.parse(`https://www.nuget.org/packages/${encodeURIComponent(packageInfo.name)}`));
        return;
      }

      if (action === 'openPackageFolder') {
        await openDependencyPackageFolder(packageInfo);
        return;
      }

      if (action === 'copyPackageId') {
        await vscode.env.clipboard.writeText(packageInfo.name);
        vscode.window.setStatusBarMessage('Solution Manager: package id copied.', 2000);
        return;
      }

      if (action === 'copyPackageFolder') {
        if (!packageInfo.packageFolderPath) {
          vscode.window.showInformationMessage(`Solution Manager: ${packageInfo.name} does not have a resolvable NuGet package folder.`);
          return;
        }

        await vscode.env.clipboard.writeText(packageInfo.packageFolderPath);
        vscode.window.setStatusBarMessage('Solution Manager: package folder copied.', 2000);
        return;
      }

      if (action === 'copyPackageReference') {
        await vscode.env.clipboard.writeText(createPackageReferenceXml(packageInfo));
        vscode.window.setStatusBarMessage('Solution Manager: PackageReference copied.', 2000);
        return;
      }

      if (action === 'copyPackageSourceMappingXml') {
        if (!packageInfo.packageSourceMappings || packageInfo.packageSourceMappings.length === 0) {
          vscode.window.showInformationMessage(`Solution Manager: ${packageInfo.name} does not match a NuGet package source mapping.`);
          return;
        }

        await vscode.env.clipboard.writeText(createPackageSourceMappingXml(packageInfo));
        vscode.window.setStatusBarMessage('Solution Manager: package source mapping copied.', 2000);
        return;
      }

      if (!packageInfo.project || !packageInfo.project.path) {
        vscode.window.showInformationMessage('Solution Manager: package action requires a project.');
        return;
      }

      if (action === 'updatePackage') {
        const version = await vscode.window.showInputBox({
          title: 'Update PackageReference',
          prompt: `Version for ${packageInfo.name}`,
          value: packageInfo.version || packageInfo.requested || packageInfo.resolved || '',
          placeHolder: 'Leave empty to omit the Version attribute'
        });

        if (version === undefined) {
          return;
        }

        await updateProjectItemReferences(packageInfo.project.path, [{
          action: 'add',
          elementName: 'PackageReference',
          include: packageInfo.include || packageInfo.name,
          groupCondition: packageInfo.groupCondition,
          metadata: createPackageReferenceMetadata(packageInfo, version.trim())
        }]);
        await this.refresh({ userVisible: true });
        vscode.window.setStatusBarMessage('Solution Manager: PackageReference updated.', 2000);
        return;
      }

      if (action === 'removePackage') {
        const answer = await vscode.window.showWarningMessage(
          `Remove ${packageInfo.name} from ${packageInfo.project.name}?`,
          { modal: true },
          'Remove'
        );

        if (answer !== 'Remove') {
          return;
        }

        await updateProjectItemReferences(packageInfo.project.path, [{
          action: 'remove',
          elementName: 'PackageReference',
          include: packageInfo.include || packageInfo.name,
          groupCondition: packageInfo.groupCondition
        }]);
        await this.refresh({ userVisible: true });
        vscode.window.setStatusBarMessage('Solution Manager: PackageReference removed.', 2000);
        return;
      }

      if (action === 'listPackages') {
        const command = `dotnet list ${quoteForShell(packageInfo.project.path)} package --include-transitive`;
        this.terminalRunner.runCommand(command);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Solution Manager: ${message}`);
    }
  }

  async runDependencyReferenceAction(action, node) {
    try {
      const referenceInfo = getDependencyReferenceInfo(node);

      if (!referenceInfo) {
        vscode.window.showInformationMessage('Solution Manager: no dependency reference was selected.');
        return;
      }

      if (action === 'referenceDetails') {
        await showDependencyReferenceDetails(referenceInfo);
        return;
      }

      if (action === 'openReference') {
        if (!referenceInfo.uri) {
          vscode.window.showInformationMessage(`Solution Manager: ${referenceInfo.name} does not have a resolvable file path.`);
          return;
        }

        await this.openUri(referenceInfo.uri);
        return;
      }

      if (action === 'openReferenceFolder') {
        await openDependencyReferenceFolder(referenceInfo);
        return;
      }

      if (action === 'copyReferenceName') {
        await vscode.env.clipboard.writeText(referenceInfo.name);
        vscode.window.setStatusBarMessage('Solution Manager: reference name copied.', 2000);
        return;
      }

      if (action === 'copyReferencePath') {
        const referencePath = getDependencyReferencePath(referenceInfo);

        if (!referencePath) {
          vscode.window.showInformationMessage(`Solution Manager: ${referenceInfo.name} does not have a resolvable file path.`);
          return;
        }

        await vscode.env.clipboard.writeText(referencePath);
        vscode.window.setStatusBarMessage('Solution Manager: reference path copied.', 2000);
        return;
      }

      if (action === 'copyReferenceXml') {
        await vscode.env.clipboard.writeText(createDependencyReferenceXml(referenceInfo));
        vscode.window.setStatusBarMessage('Solution Manager: reference XML copied.', 2000);
        return;
      }

      if (action === 'removeProjectReference') {
        if (referenceInfo.groupKind !== 'projects') {
          vscode.window.showInformationMessage('Solution Manager: only project references can be removed with this action.');
          return;
        }

        if (!referenceInfo.project || !referenceInfo.project.path) {
          vscode.window.showInformationMessage('Solution Manager: removing a project reference requires the source project path.');
          return;
        }

        const include = referenceInfo.reference.include || referenceInfo.reference.name || getDependencyReferencePath(referenceInfo) || referenceInfo.name;

        if (!include) {
          vscode.window.showInformationMessage(`Solution Manager: ${referenceInfo.name} does not have a removable project reference include.`);
          return;
        }

        const answer = await vscode.window.showWarningMessage(
          `Remove ${referenceInfo.name} from ${referenceInfo.project.name}?`,
          { modal: true },
          'Remove'
        );

        if (answer !== 'Remove') {
          return;
        }

        await updateProjectItemReferences(referenceInfo.project.path, [{
          action: 'remove',
          elementName: 'ProjectReference',
          include,
          groupCondition: referenceInfo.reference.groupCondition
        }]);
        await this.refresh({ userVisible: true });
        vscode.window.setStatusBarMessage('Solution Manager: ProjectReference removed.', 2000);
        return;
      }

      if (action === 'removeReference') {
        await this.projectActions.removeDependencyReference(node);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Solution Manager: ${message}`);
    }
  }

  async runDependencyFrameworkAction(action, node) {
    try {
      if (!node || node.kind !== 'dependencyFramework' || !node.item?.path) {
        vscode.window.showInformationMessage('Solution Manager: no target framework was selected.');
        return;
      }

      const framework = node.framework;

      if (!framework || framework === 'Dependencies') {
        vscode.window.showInformationMessage('Solution Manager: this dependency node does not have a concrete target framework.');
        return;
      }

      if (action === 'copyFramework') {
        await vscode.env.clipboard.writeText(framework);
        vscode.window.setStatusBarMessage('Solution Manager: target framework copied.', 2000);
        return;
      }

      if (action === 'frameworkDetails') {
        await showDependencyFrameworkDetails(node.item, framework);
        return;
      }

      if (action === 'build' || action === 'test') {
        const command = `dotnet ${action} ${quoteForShell(node.item.path)} -f ${quoteForShell(framework)}`;
        this.terminalRunner.runCommand(command);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Solution Manager: ${message}`);
    }
  }

  async buildSelectedProjects(node) {
    const selectedNodes = this.treeView
      ? this.treeView.selection.filter((item) => item.kind === 'project' && !this.isProjectUnloaded(item.item))
      : [];
    const nodes = selectedNodes.length > 0
      ? selectedNodes
      : node && node.kind === 'project' && !this.isProjectUnloaded(node.item)
        ? [node]
        : [];

    if (nodes.length === 0) {
      vscode.window.showInformationMessage('Solution Manager: no loaded project was selected.');
      return;
    }

    for (const projectNode of nodes) {
      this.projectActions.runDotnetAction('build', projectNode);
    }
  }

  async rebuildProject(node) {
    await this.projectActions.runDotnetAction('clean', node);
    await this.projectActions.runDotnetAction('build', node);
  }

  async unloadProject(node) {
    if (!node || !node.item) {
      return;
    }

    const unloaded = this.getUnloadedProjectUris();
    unloaded.add(node.item.uri);
    await this.context.workspaceState.update(UNLOADED_PROJECTS_KEY, [...unloaded]);
    this.onDidChangeTreeDataEmitter.fire();
  }

  async reloadProject(node) {
    if (!node || !node.item) {
      return;
    }

    const unloaded = this.getUnloadedProjectUris();
    unloaded.delete(node.item.uri);
    await this.context.workspaceState.update(UNLOADED_PROJECTS_KEY, [...unloaded]);
    this.onDidChangeTreeDataEmitter.fire();
  }

  isProjectUnloaded(project) {
    return project && this.getUnloadedProjectUris().has(project.uri);
  }

  getUnloadedProjectUris() {
    return new Set(this.context.workspaceState.get(UNLOADED_PROJECTS_KEY, []));
  }

  async setUnloadedProjectUris(uris) {
    await this.context.workspaceState.update(UNLOADED_PROJECTS_KEY, [...uris]);
  }

  updateViewTitle(state) {
    if (!this.treeView || !state) {
      return;
    }

    const solutionName = getActiveSolutionName(state);

    try {
      this.treeView.title = solutionName;
    } catch {
      // Older VS Code hosts may not allow dynamic view titles.
    }

    try {
      this.treeView.description = undefined;
    } catch {
      // Description is best-effort only.
    }
  }

  async openItem(item, options = {}) {
    const uri = itemToUri(item);
    if (!uri) {
      this.reportOpenError('Cannot open item because its URI is missing or invalid.');
      return;
    }

    if (options.expectedSolution && !isSolutionUri(uri)) {
      this.reportOpenError(`Cannot open ${path.basename(uri.fsPath)} because it is not a .sln or .slnx file.`);
      return;
    }

    await this.openUri(uri);
  }

  async openUri(uri) {
    const fileReady = await this.ensureFileExists(uri);
    if (!fileReady) {
      return;
    }

    await vscode.window.showTextDocument(uri, {
      preview: false
    });
  }

  async ensureFileExists(uri) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);

      if (!(stat.type & vscode.FileType.File)) {
        this.reportOpenError(`Cannot open ${path.basename(uri.fsPath)} because it is not a file.`);
        return false;
      }

      return true;
    } catch {
      this.reportOpenError(`Cannot open ${path.basename(uri.fsPath)} because the file no longer exists.`);
      return false;
    }
  }

  runTerminalAction(action, item) {
    try {
      const command = this.terminalRunner.run(action, item);
      vscode.window.setStatusBarMessage(`Solution Manager: ${command}`, 3500);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Solution Manager: ${message}`);
    }
  }

  reportOpenError(message) {
    vscode.window.showErrorMessage(`Solution Manager: ${message}`);
  }

  async getState() {
    if (!this.currentState) {
      this.currentState = await this.scanner.scan();
    }

    return this.currentState;
  }
}

function createSolutionNode(solution, state) {
  const projects = getProjectsForSolution(solution, state);
  const unloadedProjects = state.unloadedProjects || new Set();
  const children = buildGroupedProjectNodes(projects, unloadedProjects, solution.solutionFolders);
  const projectCount = projects.length;
  const unloadedCount = (solution.unloadedCount || 0)
    + projects.filter((project) => unloadedProjects.has(project.uri)).length;
  const description = `${projectCount} projects${unloadedCount ? `, ${unloadedCount} unloaded` : ''}`;

  return {
    id: `solution:${solution.uri}`,
    kind: 'solution',
    label: solution.name,
    description,
    item: solution,
    children,
    collapsibleState: children.length
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None,
    contextValue: 'solution'
  };
}

function getProjectsForSolution(solution, state) {
  if (Array.isArray(solution.children) && solution.children.length > 0) {
    return solution.children;
  }

  if (state.solutions.length === 1) {
    return state.projects;
  }

  return [];
}

function buildGroupedProjectNodes(projects, unloadedProjects, solutionFolders = []) {
  const root = [];

  for (const folder of solutionFolders || []) {
    ensureGroupPath(root, Array.isArray(folder.path) ? folder.path : []);
  }

  for (const project of projects) {
    const groupParts = getProjectGroupParts(project);
    const target = ensureGroupPath(root, groupParts);

    target.push(createProjectNode(project, unloadedProjects));
  }

  return addGroupProjectCounts(sortNodes(root));
}

function ensureGroupPath(root, groupParts) {
  let target = root;
  let groupId = '';

  for (const part of groupParts) {
    groupId = groupId ? `${groupId}/${part}` : part;
    let groupNode = target.find((node) => node.kind === 'group' && node.label === part);

    if (!groupNode) {
      groupNode = {
        id: `group:${groupId}`,
        kind: 'group',
        label: part,
        children: [],
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
        contextValue: 'group'
      };
      target.push(groupNode);
    }

    target = groupNode.children;
  }

  return target;
}

function createProjectNode(project, unloadedProjects = new Set()) {
  const unloaded = unloadedProjects.has(project.uri);
  const isTestProject = Boolean(project.isTestProject || project.metadata?.isTestProject);

  return {
    id: `project:${project.uri}`,
    kind: 'project',
    label: unloaded ? `${project.name} (unloaded)` : project.name,
    item: project,
    collapsibleState: unloaded
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
    contextValue: unloaded ? 'projectUnloaded' : isTestProject ? 'projectTestLoaded' : 'projectLoaded'
  };
}

function createDirectoryNode(uri, projectPath) {
  return {
    id: `directory:${uri.toString()}`,
    kind: 'directory',
    label: path.basename(uri.fsPath),
    uri,
    resourceUri: uri,
    projectPath,
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    contextValue: 'directory'
  };
}

function createFileNode(uri) {
  return {
    id: `file:${uri.toString()}`,
    kind: 'file',
    label: path.basename(uri.fsPath),
    uri,
    resourceUri: uri,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    contextValue: 'file'
  };
}

function createMessageNode(id, label) {
  return {
    id,
    kind: 'message',
    label,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    contextValue: 'message'
  };
}

function getDependencyPackageInfo(node) {
  if (!node || (node.kind !== 'dependencyPackage' && node.kind !== 'dependencyItem')) {
    return undefined;
  }

  const reference = node.reference || {};
  const name = reference.name || node.label;
  const packageFolderPath = getPackageFolderPath(reference);

  if (!name) {
    return undefined;
  }

  return {
    name,
    include: reference.include || name,
    version: reference.version || node.description,
    requested: reference.requested,
    resolved: reference.resolved,
    direct: reference.direct,
    type: reference.type,
    dependencies: reference.dependencies || [],
    compile: reference.compile || [],
    runtime: reference.runtime || [],
    packageAssetGroups: getPackageAssetGroups(reference),
    path: reference.path,
    packageFolderPath,
    privateAssets: reference.privateAssets,
    includeAssets: reference.includeAssets,
    excludeAssets: reference.excludeAssets,
    versionOverride: reference.versionOverride,
    centralVersion: reference.centralVersion,
    centralPackageVersion: reference.centralPackageVersion,
    versionSource: reference.versionSource,
    versionSourcePath: reference.versionSourcePath,
    versionSourceCondition: reference.versionSourceCondition,
    packageSourceMappings: reference.packageSourceMappings || [],
    packageSourceMappingSources: reference.packageSourceMappingSources || [],
    packageSourceMappingPatterns: reference.packageSourceMappingPatterns || [],
    generatePathProperty: reference.generatePathProperty,
    aliases: reference.aliases,
    noWarn: reference.noWarn,
    condition: reference.condition,
    itemCondition: reference.itemCondition,
    groupCondition: reference.groupCondition,
    project: node.item,
    reference
  };
}

async function openDependencyPackageFolder(packageInfo) {
  if (!packageInfo.packageFolderPath) {
    vscode.window.showInformationMessage(`Solution Manager: ${packageInfo.name} does not have a resolvable NuGet package folder.`);
    return;
  }

  const uri = vscode.Uri.file(packageInfo.packageFolderPath);

  try {
    const stat = await vscode.workspace.fs.stat(uri);

    if (!(stat.type & vscode.FileType.Directory)) {
      vscode.window.showInformationMessage(`Solution Manager: ${packageInfo.packageFolderPath} is not a package folder.`);
      return;
    }

    await vscode.commands.executeCommand('revealFileInOS', uri);
  } catch {
    vscode.window.showInformationMessage(`Solution Manager: package folder was not found: ${packageInfo.packageFolderPath}`);
  }
}

async function showDependencyPackageDetails(packageInfo) {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: createDependencyPackageDetailsMarkdown(packageInfo)
  });

  await vscode.window.showTextDocument(document, {
    preview: false
  });
}

async function showDependencyNodeDetails(node) {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: createDependencyNodeDetailsMarkdown(node)
  });

  await vscode.window.showTextDocument(document, {
    preview: false
  });
}

function createDependencyNodeDetailsMarkdown(node) {
  if (node.kind === 'dependencies') {
    return createDependencyRootDetailsMarkdown(node.item);
  }

  if (node.kind === 'dependencyImports') {
    return createDependencyImportsDetailsMarkdown(node.item);
  }

  return createDependencyGroupDetailsMarkdown(node);
}

function createDependencyRootDetailsMarkdown(project) {
  const metadata = project.metadata || {};
  const packageLock = metadata.packageLock || {};
  const targetFrameworks = metadata.targetFrameworks && metadata.targetFrameworks.length
    ? metadata.targetFrameworks
    : ['Dependencies'];
  const frameworkRows = targetFrameworks.map((framework) => {
    const resolved = getResolvedFrameworkDependencies(metadata, framework);
    const packages = getFrameworkPackages(metadata, resolved, framework);
    const projectReferences = getProjectDependencyReferences(metadata, resolved, framework);
    const frameworkReferences = getFrameworkDependencyReferences(metadata, resolved, framework);
    const directPackages = packages.filter((item) => item.direct !== false);
    const transitivePackages = packages.filter((item) => item.direct === false);

    return `- ${formatFrameworkName(framework)}: ${directPackages.length} direct packages, ${transitivePackages.length} transitive packages, ${projectReferences.length} projects, ${frameworkReferences.length} frameworks`;
  });

  return [
    `# Dependencies - ${project.name}`,
    '',
    '## Summary',
    `- Project File: ${formatPackageDetail(project.path)}`,
    `- Target Frameworks: ${targetFrameworks.length}`,
    `- Imports: ${countItems(metadata.imports)}`,
    `- Package References: ${countItems(metadata.packageReferences)}`,
    `- Package Lock File: ${formatPackageDetail(formatPackageLockPath(packageLock))}`,
    `- Locked Packages: ${countItems(packageLock.packages)}`,
    `- Project References: ${countItems(metadata.projectReferences)}`,
    `- Assembly References: ${countItems(metadata.assemblyReferences)}`,
    `- Analyzer References: ${countItems(metadata.analyzerReferences)}`,
    `- Framework References: ${countItems(metadata.frameworkReferences)}`,
    `- Source Generators: ${countItems(metadata.sourceGenerators)}`,
    `- MSBuild Targets: ${countItems(metadata.targets)}`,
    '',
    '## Target Frameworks',
    ...(frameworkRows.length ? frameworkRows : ['- None']),
    '',
    '## Imports',
    ...formatDependencyNameList(metadata.imports || [])
  ].join('\n');
}

function createDependencyImportsDetailsMarkdown(project) {
  const imports = project.metadata?.imports || [];
  const propertyCount = imports.reduce((total, item) => total + countItems(item.properties), 0);
  const targetCount = imports.reduce((total, item) => total + countItems(item.targets), 0);
  const taskCount = imports.reduce((total, item) => total + (item.targets || []).reduce((targetTotal, target) => targetTotal + countItems(target.tasks), 0), 0);

  return [
    `# Imports - ${project.name}`,
    '',
    '## Summary',
    `- Project File: ${formatPackageDetail(project.path)}`,
    `- Imports: ${imports.length}`,
    `- Imported Properties: ${propertyCount}`,
    `- Imported Targets: ${targetCount}`,
    `- Imported Tasks: ${taskCount}`,
    '',
    '## Items',
    ...formatImportDependencyNameList(imports)
  ].join('\n');
}

function createDependencyGroupDetailsMarkdown(node) {
  const children = node.children || [];
  const references = children.map((child) => child.reference).filter(Boolean);
  const directPackages = references.filter((item) => item.direct !== false);
  const transitivePackages = references.filter((item) => item.direct === false);
  const compileAssetCount = references.reduce((total, item) => total + countItems(item.compile), 0);
  const runtimeAssetCount = references.reduce((total, item) => total + countItems(item.runtime), 0);
  const conditionCount = references.filter((item) => item.itemCondition || item.groupCondition || item.condition).length;

  return [
    `# ${node.label}`,
    '',
    '## Summary',
    `- Project: ${formatPackageDetail(node.item?.name)}`,
    `- Target Framework: ${formatPackageDetail(node.framework)}`,
    `- Group: ${formatPackageDetail(node.groupKind)}`,
    `- Items: ${children.length}`,
    `- Direct Packages: ${node.groupKind === 'packages' || node.groupKind === 'transitivePackages' ? directPackages.length : 0}`,
    `- Transitive Packages: ${node.groupKind === 'packages' || node.groupKind === 'transitivePackages' ? transitivePackages.length : 0}`,
    `- Conditional Items: ${conditionCount}`,
    `- Compile Assets: ${compileAssetCount}`,
    `- Runtime Assets: ${runtimeAssetCount}`,
    '',
    '## Items',
    ...formatDependencyTreeNodeList(children)
  ].join('\n');
}

function createDependencyPackageDetailsMarkdown(packageInfo) {
  const packageAssetGroups = getPackageAssetGroups(packageInfo);
  const lines = [
    `# ${packageInfo.name}`,
    '',
    '## Summary',
    `- Effective Include: ${formatPackageDetail(packageInfo.include || packageInfo.name)}`,
    `- Dependency Count: ${countItems(packageInfo.dependencies)}`,
    `- Compile Asset Count: ${countItems(packageInfo.compile)}`,
    `- Runtime Asset Count: ${countItems(packageInfo.runtime)}`,
    `- Asset Group Count: ${packageAssetGroups.length}`,
    '',
    '## Metadata',
    `- Version: ${formatPackageDetail(packageInfo.version)}`,
    `- Requested: ${formatPackageDetail(packageInfo.requested)}`,
    `- Resolved: ${formatPackageDetail(packageInfo.resolved)}`,
    `- Kind: ${packageInfo.direct === false ? 'Transitive' : 'Direct or project reference'}`,
    `- Type: ${formatPackageDetail(packageInfo.type)}`,
    `- Project: ${formatPackageDetail(packageInfo.project?.name)}`,
    `- Path: ${formatPackageDetail(packageInfo.path)}`,
    `- Package Folder: ${formatPackageDetail(packageInfo.packageFolderPath)}`,
    `- PrivateAssets: ${formatPackageDetail(packageInfo.privateAssets)}`,
    `- IncludeAssets: ${formatPackageDetail(packageInfo.includeAssets)}`,
    `- ExcludeAssets: ${formatPackageDetail(packageInfo.excludeAssets)}`,
    `- OutputItemType: ${formatPackageDetail(packageInfo.outputItemType)}`,
    `- ReferenceOutputAssembly: ${formatPackageDetail(packageInfo.referenceOutputAssembly)}`,
    `- VersionOverride: ${formatPackageDetail(packageInfo.versionOverride)}`,
    `- GeneratePathProperty: ${formatPackageDetail(packageInfo.generatePathProperty)}`,
    `- Aliases: ${formatPackageDetail(packageInfo.aliases)}`,
    `- NoWarn: ${formatPackageDetail(packageInfo.noWarn)}`,
    `- Version Source: ${formatPackageDetail(packageInfo.versionSource)}`,
    `- Central Package Version: ${formatPackageDetail(packageInfo.centralVersion)}`,
    `- Central Package File: ${formatPackageDetail(packageInfo.versionSourcePath)}`,
    `- Package Source Mapping: ${formatPackageDetail(formatPackageSourceMappings(packageInfo.packageSourceMappings))}`,
    `- Item Condition: ${formatPackageDetail(packageInfo.itemCondition)}`,
    `- Group Condition: ${formatPackageDetail(packageInfo.groupCondition)}`,
    `- Condition: ${formatPackageDetail(packageInfo.condition)}`,
    '',
    '## Dependencies',
    ...formatPackageDependencies(packageInfo.dependencies),
    '',
    ...formatPackageAssetGroupSections(packageAssetGroups, packageInfo.reference || packageInfo),
    '',
    '## XML',
    '```xml',
    createPackageReferenceXml(packageInfo),
    '```'
  ];

  return lines.join('\n');
}

function createPackageReferenceXml(packageInfo) {
  const attributes = [
    `Include="${escapeXmlAttribute(packageInfo.include || packageInfo.name)}"`,
    packageInfo.version && !isCentralPackageVersion(packageInfo) ? `Version="${escapeXmlAttribute(packageInfo.version)}"` : undefined,
    packageInfo.versionOverride ? `VersionOverride="${escapeXmlAttribute(packageInfo.versionOverride)}"` : undefined,
    packageInfo.privateAssets ? `PrivateAssets="${escapeXmlAttribute(packageInfo.privateAssets)}"` : undefined,
    packageInfo.includeAssets ? `IncludeAssets="${escapeXmlAttribute(packageInfo.includeAssets)}"` : undefined,
    packageInfo.excludeAssets ? `ExcludeAssets="${escapeXmlAttribute(packageInfo.excludeAssets)}"` : undefined,
    packageInfo.outputItemType ? `OutputItemType="${escapeXmlAttribute(packageInfo.outputItemType)}"` : undefined,
    packageInfo.referenceOutputAssembly ? `ReferenceOutputAssembly="${escapeXmlAttribute(packageInfo.referenceOutputAssembly)}"` : undefined,
    packageInfo.generatePathProperty ? `GeneratePathProperty="${escapeXmlAttribute(packageInfo.generatePathProperty)}"` : undefined,
    packageInfo.aliases ? `Aliases="${escapeXmlAttribute(packageInfo.aliases)}"` : undefined,
    packageInfo.noWarn ? `NoWarn="${escapeXmlAttribute(packageInfo.noWarn)}"` : undefined,
    getPackageItemCondition(packageInfo) ? `Condition="${escapeXmlAttribute(getPackageItemCondition(packageInfo))}"` : undefined
  ].filter(Boolean);

  return `<PackageReference ${attributes.join(' ')} />`;
}

function createPackageSourceMappingXml(packageInfo = {}) {
  const mappings = packageInfo.packageSourceMappings || [];

  if (mappings.length === 0) {
    return '<packageSourceMapping />';
  }

  const lines = ['<packageSourceMapping>'];

  for (const mapping of mappings) {
    lines.push(`  <packageSource key="${escapeXmlAttribute(mapping.source)}">`);

    for (const pattern of mapping.patterns || []) {
      lines.push(`    <package pattern="${escapeXmlAttribute(pattern)}" />`);
    }

    lines.push('  </packageSource>');
  }

  lines.push('</packageSourceMapping>');
  return lines.join('\n');
}

function isCentralPackageVersion(packageInfo = {}) {
  return packageInfo.versionSource === 'Directory.Packages.props' || packageInfo.centralVersion;
}

function getPackageItemCondition(packageInfo = {}) {
  return packageInfo.itemCondition === undefined ? packageInfo.condition : packageInfo.itemCondition;
}

function createPackageReferenceMetadata(packageInfo, version) {
  return {
    Version: version,
    VersionOverride: packageInfo.versionOverride,
    PrivateAssets: packageInfo.privateAssets,
    IncludeAssets: packageInfo.includeAssets,
    ExcludeAssets: packageInfo.excludeAssets,
    OutputItemType: packageInfo.outputItemType,
    ReferenceOutputAssembly: packageInfo.referenceOutputAssembly,
    GeneratePathProperty: packageInfo.generatePathProperty,
    Aliases: packageInfo.aliases,
    NoWarn: packageInfo.noWarn,
    Condition: getPackageItemCondition(packageInfo)
  };
}

function getDependencyReferenceInfo(node) {
  if (!node || node.kind !== 'dependencyItem') {
    return undefined;
  }

  const reference = node.reference || {};
  const name = reference.name || reference.include || reference.source || node.label;

  if (!name) {
    return undefined;
  }

  return {
    name,
    label: node.label,
    description: node.description,
    groupKind: node.groupKind,
    project: node.item,
    reference,
    path: reference.path,
    uri: node.uri
  };
}

async function showDependencyReferenceDetails(referenceInfo) {
  const lines = [
    `# ${referenceInfo.label || referenceInfo.name}`,
    '',
    `- Name: ${formatPackageDetail(referenceInfo.name)}`,
    `- Group: ${formatPackageDetail(referenceInfo.groupKind)}`,
    `- Project: ${formatPackageDetail(referenceInfo.project?.name)}`,
    `- Include: ${formatPackageDetail(referenceInfo.reference.include)}`,
    `- Source: ${formatPackageDetail(referenceInfo.reference.source)}`,
    `- Path: ${formatPackageDetail(getDependencyReferencePath(referenceInfo) || referenceInfo.path)}`,
    `- Version: ${formatPackageDetail(referenceInfo.reference.version)}`,
    `- HintPath: ${formatPackageDetail(referenceInfo.reference.hintPath)}`,
    `- Aliases: ${formatPackageDetail(referenceInfo.reference.aliases)}`,
    `- Private: ${formatPackageDetail(referenceInfo.reference.private)}`,
    `- CopyLocal: ${formatPackageDetail(referenceInfo.reference.copyLocal)}`,
    `- ReferenceOutputAssembly: ${formatPackageDetail(referenceInfo.reference.referenceOutputAssembly)}`,
    `- OutputItemType: ${formatPackageDetail(referenceInfo.reference.outputItemType)}`,
    `- PrivateAssets: ${formatPackageDetail(referenceInfo.reference.privateAssets)}`,
    `- IncludeAssets: ${formatPackageDetail(referenceInfo.reference.includeAssets)}`,
    `- ExcludeAssets: ${formatPackageDetail(referenceInfo.reference.excludeAssets)}`,
    `- Item Condition: ${formatPackageDetail(referenceInfo.reference.itemCondition)}`,
    `- Group Condition: ${formatPackageDetail(referenceInfo.reference.groupCondition)}`,
    `- Condition: ${formatPackageDetail(referenceInfo.reference.condition)}`,
    `- Implicit: ${referenceInfo.reference.implicit ? 'Yes' : 'No'}`,
    '',
    '## XML',
    '```xml',
    createDependencyReferenceXml(referenceInfo),
    '```'
  ];
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: lines.join('\n')
  });

  await vscode.window.showTextDocument(document, {
    preview: false
  });
}

async function showDependencyFrameworkDetails(project, framework) {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: createDependencyFrameworkDetailsMarkdown(project, framework)
  });

  await vscode.window.showTextDocument(document, {
    preview: false
  });
}

function createDependencyFrameworkDetailsMarkdown(project, framework) {
  const metadata = project.metadata || {};
  const lockedPackages = getPackageLockFrameworkPackages(metadata.packageLock, framework);
  const resolved = getResolvedFrameworkDependencies(metadata, framework);
  const packages = getFrameworkPackages(metadata, resolved, framework);
  const directPackages = packages.filter((item) => item.direct !== false);
  const transitivePackages = packages.filter((item) => item.direct === false);
  const projectReferences = getProjectDependencyReferences(metadata, resolved, framework);
  const frameworkReferences = getFrameworkDependencyReferences(metadata, resolved, framework);
  const assemblyReferences = metadata.assemblyReferences || [];
  const analyzerReferences = metadata.analyzerReferences || [];
  const sourceGenerators = metadata.sourceGenerators || [];
  const compileAssetCount = packages.reduce((total, item) => total + countItems(item.compile), 0);
  const runtimeAssetCount = packages.reduce((total, item) => total + countItems(item.runtime), 0);
  const packageAssetCount = packages.reduce((total, item) => {
    return total + getPackageAssetGroups(item).reduce((groupTotal, group) => groupTotal + countItems(group.assets), 0);
  }, 0);

  return [
    `# ${formatFrameworkName(framework)}`,
    '',
    '## Summary',
    `- Project: ${formatPackageDetail(project.name)}`,
    `- Project File: ${formatPackageDetail(project.path)}`,
    `- Target Framework: ${formatPackageDetail(framework)}`,
    `- Direct Packages: ${directPackages.length}`,
    `- Transitive Packages: ${transitivePackages.length}`,
    `- Locked Packages: ${lockedPackages.length}`,
    `- Project References: ${projectReferences.length}`,
    `- Assembly References: ${assemblyReferences.length}`,
    `- Analyzer References: ${analyzerReferences.length}`,
    `- Framework References: ${frameworkReferences.length}`,
    `- Source Generators: ${sourceGenerators.length}`,
    `- Compile Assets: ${compileAssetCount}`,
    `- Runtime Assets: ${runtimeAssetCount}`,
    `- Package Assets: ${packageAssetCount}`,
    '',
    '## Direct Packages',
    ...formatDependencyNameList(directPackages),
    '',
    '## Transitive Packages',
    ...formatDependencyNameList(transitivePackages),
    '',
    '## Locked Packages',
    ...formatDependencyNameList(lockedPackages),
    '',
    '## Project References',
    ...formatDependencyNameList(projectReferences),
    '',
    '## Assembly References',
    ...formatDependencyNameList(assemblyReferences),
    '',
    '## Framework References',
    ...formatDependencyNameList(frameworkReferences),
    '',
    '## Analyzers',
    ...formatDependencyNameList(analyzerReferences),
    '',
    '## Source Generators',
    ...formatDependencyNameList(sourceGenerators)
  ].join('\n');
}

async function openDependencyReferenceFolder(referenceInfo) {
  const referencePath = getDependencyReferencePath(referenceInfo);

  if (!referencePath) {
    vscode.window.showInformationMessage(`Solution Manager: ${referenceInfo.name} does not have a resolvable file path.`);
    return;
  }

  const uri = vscode.Uri.file(referencePath);

  try {
    await vscode.workspace.fs.stat(uri);
    await vscode.commands.executeCommand('revealFileInOS', uri);
  } catch {
    vscode.window.showInformationMessage(`Solution Manager: reference path was not found: ${referencePath}`);
  }
}

function createDependencyReferenceXml(referenceInfo) {
  const reference = referenceInfo.reference || {};
  const include = reference.include || reference.name || reference.source || referenceInfo.name;

  switch (referenceInfo.groupKind) {
    case 'projects':
      return createSelfClosingXml('ProjectReference', [
        ['Include', reference.include || reference.name],
        ['ReferenceOutputAssembly', reference.referenceOutputAssembly],
        ['OutputItemType', reference.outputItemType],
        ['PrivateAssets', reference.privateAssets],
        ['IncludeAssets', reference.includeAssets],
        ['ExcludeAssets', reference.excludeAssets],
        ['Condition', getDependencyReferenceItemCondition(reference)]
      ]);
    case 'import':
      if (reference.implicit && reference.kind !== 'directory-build-props' && reference.kind !== 'directory-build-targets') {
        return `<!-- ${escapeXmlComment(referenceInfo.name)} is imported implicitly by ${escapeXmlComment(reference.source || 'the project SDK')} -->`;
      }

      return createSelfClosingXml('Import', [
        ['Project', reference.source || reference.include || reference.name],
        ['Condition', reference.condition],
        ['Label', reference.label]
      ]);
    case 'assemblies':
      return createReferenceXml(reference);
    case 'analyzers':
      return createSelfClosingXml('Analyzer', [
        ['Include', include],
        ['HintPath', reference.hintPath],
        ['PrivateAssets', reference.privateAssets],
        ['IncludeAssets', reference.includeAssets],
        ['ExcludeAssets', reference.excludeAssets],
        ['Aliases', reference.aliases],
        ['Condition', getDependencyReferenceItemCondition(reference)]
      ]);
    case 'frameworks':
      return createSelfClosingXml('FrameworkReference', [
        ['Include', include],
        ['PrivateAssets', reference.privateAssets],
        ['IncludeAssets', reference.includeAssets],
        ['ExcludeAssets', reference.excludeAssets],
        ['Condition', getDependencyReferenceItemCondition(reference)]
      ]);
    case 'sourceGenerators':
      if (reference.path || /[\\/]/.test(include)) {
        return createSelfClosingXml('Analyzer', [
          ['Include', include],
          ['HintPath', reference.hintPath],
          ['PrivateAssets', reference.privateAssets],
          ['IncludeAssets', reference.includeAssets],
          ['ExcludeAssets', reference.excludeAssets],
          ['Aliases', reference.aliases],
          ['Condition', getDependencyReferenceItemCondition(reference)]
        ]);
      }

      return createSelfClosingXml('PackageReference', [
        ['Include', include],
        ['Version', isCentralPackageVersion(reference) ? undefined : reference.version],
        ['VersionOverride', reference.versionOverride],
        ['PrivateAssets', reference.privateAssets || 'all'],
        ['IncludeAssets', reference.includeAssets],
        ['ExcludeAssets', reference.excludeAssets],
        ['OutputItemType', reference.outputItemType || 'Analyzer'],
        ['ReferenceOutputAssembly', reference.referenceOutputAssembly],
        ['GeneratePathProperty', reference.generatePathProperty],
        ['Aliases', reference.aliases],
        ['NoWarn', reference.noWarn],
        ['Condition', getDependencyReferenceItemCondition(reference)]
      ]);
    default:
      if (isPackageAssetGroupKind(referenceInfo.groupKind)) {
        return `<!-- Restored ${escapeXmlComment(getPackageAssetGroupLabel(referenceInfo.groupKind))}: ${escapeXmlComment(include)} -->`;
      }

      return createSelfClosingXml('Reference', [
        ['Include', include],
        ['Condition', getDependencyReferenceItemCondition(reference)]
      ]);
  }
}

function createReferenceXml(reference) {
  return createSelfClosingXml('Reference', [
    ['Include', reference.include || reference.name],
    ['HintPath', reference.hintPath],
    ['Aliases', reference.aliases],
    ['Private', reference.private],
    ['CopyLocal', reference.copyLocal],
    ['Condition', getDependencyReferenceItemCondition(reference)]
  ]);
}

function getDependencyReferenceItemCondition(reference = {}) {
  return reference.itemCondition === undefined ? reference.condition : reference.itemCondition;
}

function createSelfClosingXml(elementName, entries) {
  const attributes = createXmlAttributes(entries);
  return attributes ? `<${elementName} ${attributes} />` : `<${elementName} />`;
}

function createXmlAttributes(entries) {
  return entries
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`)
    .join(' ');
}

function getDependencyReferencePath(referenceInfo) {
  const reference = referenceInfo.reference || {};

  if (referenceInfo.groupKind === 'import') {
    return reference.path;
  }

  if (referenceInfo.groupKind === 'frameworks') {
    return undefined;
  }

  const rawPath = reference.path || reference.hintPath || reference.include || reference.name;

  if (!rawPath || /[$%*?]/.test(rawPath)) {
    return undefined;
  }

  const normalizedPath = rawPath.replace(/\\/g, path.sep);

  if (path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }

  if (!referenceInfo.project || !referenceInfo.project.path) {
    return normalizedPath;
  }

  return path.resolve(path.dirname(referenceInfo.project.path), normalizedPath);
}

function formatPackageDetail(value) {
  return value === undefined || value === '' ? 'Not specified' : String(value);
}

function formatPackageLockPath(packageLock = {}) {
  if (packageLock.path) {
    return packageLock.exists === false ? `${packageLock.path} (not found)` : packageLock.path;
  }

  if (packageLock.configuredPath) {
    return packageLock.unresolved ? `${packageLock.configuredPath} (unresolved)` : packageLock.configuredPath;
  }

  return undefined;
}

function getPackageLockFrameworkPackages(packageLock = {}, framework) {
  const normalizedFramework = normalizeFrameworkKey(framework);
  return (packageLock.packages || []).filter((item) => normalizeFrameworkKey(item.targetFramework) === normalizedFramework);
}

function formatPackageSourceMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return 'Not specified';
  }

  return mappings.map((mapping) => {
    const patterns = (mapping.patterns || []).join(', ');
    return patterns ? `${mapping.source}: ${patterns}` : mapping.source;
  }).join('; ');
}

function countItems(values) {
  return Array.isArray(values) ? values.length : 0;
}

function formatPackageDependencies(dependencies) {
  if (!dependencies || dependencies.length === 0) {
    return ['- None'];
  }

  return dependencies.map((dependency) => `- ${dependency.name}${dependency.version ? ` (${dependency.version})` : ''}`);
}

function formatDependencyNameList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return ['- None'];
  }

  return values.map((item) => {
    const name = item.name || item.include || item.source || item.path || 'Unknown';
    const version = item.version || item.requested || item.resolved || item.packageVersion;
    const condition = item.itemCondition || item.condition || item.groupCondition;
    const suffix = [
      version ? ` (${version})` : '',
      condition ? ` - ${condition}` : ''
    ].join('');

    return `- ${name}${suffix}`;
  });
}

function formatImportDependencyNameList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return ['- None'];
  }

  return values.map((item) => {
    const name = item.name || item.source || item.path || 'Unknown';
    const details = [
      item.source,
      item.propertyCount ? `${item.propertyCount} properties` : undefined,
      item.targetCount ? `${item.targetCount} targets` : undefined,
      item.taskCount ? `${item.taskCount} tasks` : undefined
    ].filter(Boolean);

    return details.length ? `- ${name}: ${details.join(' | ')}` : `- ${name}`;
  });
}

function formatDependencyTreeNodeList(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return ['- None'];
  }

  return nodes.map((node) => {
    const reference = node.reference || {};
    const name = node.label || reference.name || reference.include || reference.source || reference.path || 'Unknown';
    const details = [
      node.description,
      reference.version || reference.requested || reference.resolved || reference.packageVersion,
      reference.itemCondition || reference.condition || reference.groupCondition
    ].filter(Boolean);

    return details.length ? `- ${name}: ${details.join(' | ')}` : `- ${name}`;
  });
}

function formatPackageAssetList(values, packageReference) {
  if (!values || values.length === 0) {
    return ['- None'];
  }

  return values.map((value) => {
    const assetPath = getPackageAssetPath(packageReference, value);

    return assetPath ? `- ${value}\n  - Path: ${assetPath}` : `- ${value}`;
  });
}

function formatPackageAssetGroupSections(groups, packageReference) {
  if (!Array.isArray(groups) || groups.length === 0) {
    return [
      '## Package Assets',
      '- None'
    ];
  }

  return groups.flatMap((group) => [
    `## ${group.label}`,
    ...formatPackageAssetList(group.assets, packageReference),
    ''
  ]).slice(0, -1);
}

function getNuGetGlobalPackagesPath() {
  return process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages');
}

function getPackageFolderPath(reference = {}) {
  if (reference.packageReference) {
    return getPackageFolderPath(reference.packageReference);
  }

  const libraryPath = reference.path;

  if (libraryPath && isNuGetPackageLibraryPath(libraryPath)) {
    if (path.isAbsolute(libraryPath)) {
      return libraryPath;
    }

    return path.join(getNuGetGlobalPackagesPath(), normalizePackageRelativePath(libraryPath));
  }

  const name = reference.packageName || reference.name || reference.include;
  const version = normalizeNuGetPackageVersion(reference.packageVersion || reference.version || reference.resolved || reference.requested);

  if (!name || !version) {
    return undefined;
  }

  return path.join(getNuGetGlobalPackagesPath(), String(name).toLowerCase(), version.toLowerCase());
}

function getPackageAssetPath(reference = {}, assetPath) {
  const packageFolderPath = getPackageFolderPath(reference);

  if (!packageFolderPath || !assetPath) {
    return undefined;
  }

  return path.join(packageFolderPath, normalizePackageRelativePath(assetPath));
}

function isNuGetPackageLibraryPath(value) {
  const text = String(value).trim();

  if (!text || text.startsWith('..') || text.startsWith('.')) {
    return false;
  }

  if (path.isAbsolute(text)) {
    return true;
  }

  return text.split(/[\\/]/).length >= 2;
}

function normalizePackageRelativePath(value) {
  return String(value)
    .trim()
    .replace(/^[/\\]+/, '')
    .replace(/[\\/]+/g, path.sep);
}

function normalizeNuGetPackageVersion(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();

  if (!text || /[\s,[\]()<>]/.test(text)) {
    return undefined;
  }

  return text;
}

function escapeXmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlComment(value) {
  return String(value).replace(/--/g, '- -');
}

function getProjectGroupParts(project) {
  if (Array.isArray(project.solutionFolders) && project.solutionFolders.length > 0) {
    return project.solutionFolders;
  }

  const normalized = (project.relativePath || project.fileName || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length <= 1) {
    return [];
  }

  parts.pop();

  if (parts[parts.length - 1] === project.name) {
    parts.pop();
  }

  return parts;
}

function getIcon(node) {
  switch (node.kind) {
    case 'solution':
      return new vscode.ThemeIcon('symbol-namespace');
    case 'group':
    case 'directory':
      return new vscode.ThemeIcon('folder');
    case 'project':
      return new vscode.ThemeIcon('symbol-class');
    case 'dependencies':
      return new vscode.ThemeIcon('references');
    case 'dependencyImports':
      return new vscode.ThemeIcon('gear');
    case 'dependencyFramework':
      return new vscode.ThemeIcon('gear');
    case 'dependencyGroup':
      return getDependencyGroupIcon(node.groupKind);
    case 'dependencyPackage':
      return new vscode.ThemeIcon('package');
    case 'dependencyItem':
      if (isPackageAssetGroupKind(node.groupKind) && node.resourceUri) {
        return undefined;
      }

      return getDependencyItemIcon(node.groupKind);
    case 'file':
      return undefined;
    default:
      return new vscode.ThemeIcon('info');
  }
}

function getActiveSolutionName(state) {
  if (state.solutions && state.solutions.length === 1) {
    return state.solutions[0].name;
  }

  if (state.solutions && state.solutions.length > 1) {
    return `${state.solutions.length} Solutions`;
  }

  if (state.workspace && state.workspace.name && state.workspace.name !== 'No workspace') {
    return state.workspace.name;
  }

  return 'Solution';
}

function getDependencyChildren(project) {
  const metadata = project.metadata || {};
  const targetFrameworks = metadata.targetFrameworks && metadata.targetFrameworks.length
    ? metadata.targetFrameworks
    : ['Dependencies'];

  return [
    {
      id: `imports:${project.uri}`,
      kind: 'dependencyImports',
      label: 'Imports',
      item: project,
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      contextValue: 'dependencyImports'
    },
    ...targetFrameworks.map((framework) => ({
      id: `framework:${project.uri}:${framework}`,
      kind: 'dependencyFramework',
      label: formatFrameworkName(framework),
      framework,
      item: project,
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      contextValue: 'dependencyFramework'
    }))
  ];
}

function getDependencyImportChildren(project) {
  const metadata = project.metadata || {};
  const sdk = metadata.sdk || 'Microsoft.NET.Sdk';
  const imports = metadata.imports && metadata.imports.length
    ? metadata.imports
    : [
      { name: 'Sdk.props', source: sdk, implicit: true, kind: 'sdk' },
      { name: 'Sdk.targets', source: sdk, implicit: true, kind: 'sdk' }
    ];

  return imports.map((item) => createDependencyItem(
    project,
    'import',
    item.name,
    item.source || sdk,
    item
  ));
}

function getDependencyFrameworkChildren(project, framework) {
  const metadata = project.metadata || {};
  const resolved = getResolvedFrameworkDependencies(metadata, framework);
  const packageGroups = getPackageDependencyGroups(project, framework, metadata, resolved);
  const projectReferences = getProjectDependencyReferences(metadata, resolved, framework);
  const frameworkReferences = getFrameworkDependencyReferences(metadata, resolved, framework);

  return [
    createDependencyGroup(project, framework, 'assemblies', 'Assemblies', metadata.assemblyReferences || []),
    createDependencyGroup(project, framework, 'projects', 'Projects', projectReferences),
    createDependencyGroup(project, framework, 'analyzers', 'Analyzers', metadata.analyzerReferences || []),
    ...packageGroups,
    createDependencyGroup(project, framework, 'frameworks', 'Frameworks', frameworkReferences),
    createDependencyGroup(project, framework, 'sourceGenerators', 'Source Generators', metadata.sourceGenerators || [])
  ];
}

function getProjectDependencyReferences(metadata, resolved, framework) {
  if (!resolved || !resolved.projects || resolved.projects.length === 0) {
    return metadata.projectReferences || [];
  }

  return resolved.projects.map((item) => mergeResolvedProjectReference(item, metadata.projectReferences || [], framework));
}

function getFrameworkDependencyReferences(metadata, resolved, framework) {
  if (!resolved || !resolved.frameworkReferences || resolved.frameworkReferences.length === 0) {
    return metadata.frameworkReferences || [];
  }

  return resolved.frameworkReferences.map((item) => mergeResolvedFrameworkReference(item, metadata.frameworkReferences || [], framework));
}

function getPackageDependencyGroups(project, framework, metadata, resolved) {
  if (!resolved || !resolved.packages || resolved.packages.length === 0) {
    return [
      createDependencyGroup(project, framework, 'packages', 'Packages', enrichPackagesWithPackageSourceMappings(metadata.packageReferences || [], metadata.nugetConfig))
    ];
  }

  const packages = enrichPackagesWithPackageSourceMappings(
    resolved.packages.map((item) => mergeResolvedPackageReference(item, metadata.packageReferences || [], framework)),
    metadata.nugetConfig
  );
  const directPackages = packages.filter((item) => item.direct);
  const transitivePackages = packages.filter((item) => !item.direct);
  const groups = [];

  groups.push(createPackageGroup(project, framework, 'packages', 'Packages', directPackages.length ? directPackages : packages));

  if (transitivePackages.length > 0) {
    groups.push(createPackageGroup(project, framework, 'transitivePackages', 'Transitive Packages', transitivePackages));
  }

  return groups;
}

function getFrameworkPackages(metadata, resolved, framework) {
  if (!resolved || !resolved.packages || resolved.packages.length === 0) {
    return enrichPackagesWithPackageSourceMappings(metadata.packageReferences || [], metadata.nugetConfig);
  }

  return enrichPackagesWithPackageSourceMappings(
    resolved.packages.map((item) => mergeResolvedPackageReference(item, metadata.packageReferences || [], framework)),
    metadata.nugetConfig
  );
}

function mergeResolvedPackageReference(resolvedPackage, packageReferences, framework) {
  const candidates = packageReferences.filter((reference) => {
    return String(reference.name || reference.include || '').toLowerCase() === String(resolvedPackage.name || '').toLowerCase();
  });
  const packageReference = choosePackageReferenceForFramework(candidates, framework);

  if (!packageReference) {
    return resolvedPackage;
  }

  return {
    ...resolvedPackage,
    include: packageReference.include || packageReference.name || resolvedPackage.name,
    version: packageReference.version || resolvedPackage.version,
    versionOverride: packageReference.versionOverride,
    centralVersion: packageReference.centralVersion,
    centralPackageVersion: packageReference.centralPackageVersion,
    versionSource: packageReference.versionSource,
    versionSourcePath: packageReference.versionSourcePath,
    versionSourceCondition: packageReference.versionSourceCondition,
    privateAssets: packageReference.privateAssets,
    includeAssets: packageReference.includeAssets,
    excludeAssets: packageReference.excludeAssets,
    outputItemType: packageReference.outputItemType,
    referenceOutputAssembly: packageReference.referenceOutputAssembly,
    generatePathProperty: packageReference.generatePathProperty,
    aliases: packageReference.aliases,
    noWarn: packageReference.noWarn,
    condition: packageReference.condition,
    itemCondition: packageReference.itemCondition,
    groupCondition: packageReference.groupCondition,
    packageReference
  };
}

function choosePackageReferenceForFramework(candidates, framework) {
  if (candidates.length <= 1) {
    return candidates[0];
  }

  const normalizedFramework = normalizeFrameworkKey(framework);
  return candidates.find((reference) => {
    const condition = `${reference.itemCondition || reference.condition || ''} ${reference.groupCondition || ''}`;
    return normalizeFrameworkKey(condition).includes(normalizedFramework);
  }) || candidates.find((reference) => !reference.itemCondition && !reference.condition && !reference.groupCondition) || candidates[0];
}

function mergeResolvedProjectReference(resolvedProject, projectReferences, framework) {
  const projectReference = chooseProjectReferenceForFramework(
    projectReferences.filter((reference) => isMatchingProjectReference(resolvedProject, reference)),
    framework
  );

  if (!projectReference) {
    return resolvedProject;
  }

  return {
    ...resolvedProject,
    name: projectReference.name || resolvedProject.name,
    include: projectReference.include || projectReference.path || resolvedProject.path || resolvedProject.name,
    path: projectReference.path || resolvedProject.path,
    referenceOutputAssembly: projectReference.referenceOutputAssembly,
    outputItemType: projectReference.outputItemType,
    privateAssets: projectReference.privateAssets,
    includeAssets: projectReference.includeAssets,
    excludeAssets: projectReference.excludeAssets,
    condition: projectReference.condition,
    itemCondition: projectReference.itemCondition,
    groupCondition: projectReference.groupCondition,
    projectReference
  };
}

function chooseProjectReferenceForFramework(candidates, framework) {
  if (candidates.length <= 1) {
    return candidates[0];
  }

  const normalizedFramework = normalizeFrameworkKey(framework);
  return candidates.find((reference) => {
    const condition = `${reference.itemCondition || reference.condition || ''} ${reference.groupCondition || ''}`;
    return normalizeFrameworkKey(condition).includes(normalizedFramework);
  }) || candidates.find((reference) => !reference.itemCondition && !reference.condition && !reference.groupCondition) || candidates[0];
}

function isMatchingProjectReference(resolvedProject, projectReference) {
  const resolvedValues = [
    resolvedProject.name,
    resolvedProject.path,
    resolvedProject.key
  ].filter(Boolean).map(normalizeProjectReferenceIdentity);
  const referenceValues = [
    projectReference.name,
    projectReference.include,
    projectReference.path
  ].filter(Boolean).map(normalizeProjectReferenceIdentity);

  return resolvedValues.some((resolvedValue) => referenceValues.some((referenceValue) => {
    return resolvedValue === referenceValue
      || resolvedValue.endsWith(`/${referenceValue}`)
      || referenceValue.endsWith(`/${resolvedValue}`)
      || path.basename(resolvedValue, path.extname(resolvedValue)) === path.basename(referenceValue, path.extname(referenceValue));
  }));
}

function normalizeProjectReferenceIdentity(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function mergeResolvedFrameworkReference(resolvedFramework, frameworkReferences, framework) {
  const frameworkReference = chooseFrameworkReferenceForFramework(
    frameworkReferences.filter((reference) => {
      return String(reference.name || reference.include || '').toLowerCase() === String(resolvedFramework.name || '').toLowerCase();
    }),
    framework
  );

  if (!frameworkReference) {
    return resolvedFramework;
  }

  return {
    ...resolvedFramework,
    name: frameworkReference.name || frameworkReference.include || resolvedFramework.name,
    include: frameworkReference.include || frameworkReference.name || resolvedFramework.name,
    privateAssets: frameworkReference.privateAssets,
    includeAssets: frameworkReference.includeAssets,
    excludeAssets: frameworkReference.excludeAssets,
    condition: frameworkReference.condition,
    itemCondition: frameworkReference.itemCondition,
    groupCondition: frameworkReference.groupCondition,
    frameworkReference
  };
}

function chooseFrameworkReferenceForFramework(candidates, framework) {
  if (candidates.length <= 1) {
    return candidates[0];
  }

  const normalizedFramework = normalizeFrameworkKey(framework);
  return candidates.find((reference) => {
    const condition = `${reference.itemCondition || reference.condition || ''} ${reference.groupCondition || ''}`;
    return normalizeFrameworkKey(condition).includes(normalizedFramework);
  }) || candidates.find((reference) => !reference.itemCondition && !reference.condition && !reference.groupCondition) || candidates[0];
}

function createDependencyGroup(project, framework, groupKind, label, references) {
  const children = references.map((reference) => createDependencyItem(
    project,
    groupKind,
    getReferenceLabel(reference),
    getReferenceDescription(reference, groupKind),
    reference
  ));

  return {
    id: `dependency-group:${project.uri}:${framework}:${groupKind}`,
    kind: 'dependencyGroup',
    groupKind,
    framework,
    label,
    description: references.length ? `${references.length}` : undefined,
    item: project,
    children,
    collapsibleState: children.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    contextValue: `dependencyGroup.${groupKind}`
  };
}

function createPackageGroup(project, framework, groupKind, label, packages) {
  const children = packages.map((reference) => createDependencyPackageNode(project, framework, groupKind, reference));

  return {
    id: `dependency-group:${project.uri}:${framework}:${groupKind}`,
    kind: 'dependencyGroup',
    groupKind,
    framework,
    label,
    description: children.length ? `${children.length}` : undefined,
    item: project,
    children,
    collapsibleState: children.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    contextValue: `dependencyGroup.${groupKind}`
  };
}

function createDependencyPackageNode(project, framework, groupKind, reference) {
  return {
    id: `dependency-package:${project.uri}:${framework}:${reference.key || reference.name}`,
    kind: 'dependencyPackage',
    groupKind,
    label: reference.name,
    description: [
      reference.version,
      reference.direct ? 'direct' : 'transitive'
    ].filter(Boolean).join(' '),
    tooltip: getDependencyTooltip(reference, groupKind, reference.name, reference.version),
    item: project,
    reference,
    collapsibleState: hasDependencyPackageChildren(reference)
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    contextValue: reference.direct === false ? 'dependencyPackage.transitive' : 'dependencyPackage.direct'
  };
}

function getDependencyPackageChildren(project, reference) {
  const children = [];

  if (reference.dependencies && reference.dependencies.length) {
    children.push(createDependencyGroup(
      project,
      reference.key || reference.name,
      'packageDependency',
      'Dependencies',
      reference.dependencies
    ));
  }

  for (const group of getPackageAssetGroups(reference)) {
    children.push(createDependencyGroup(
      project,
      reference.key || reference.name,
      getPackageAssetGroupKind(group.key),
      group.label,
      group.assets.map((asset) => ({
        name: asset,
        kind: group.key,
        assetPath: asset,
        packageName: reference.name,
        packageVersion: reference.version,
        packageReference: reference,
        path: getPackageAssetPath(reference, asset)
      }))
    ));
  }

  return children;
}

function hasDependencyPackageChildren(reference) {
  return Boolean(
    reference.dependencies?.length
      || getPackageAssetGroups(reference).some((group) => group.assets.length)
  );
}

function getPackageAssetGroups(reference = {}) {
  if (Array.isArray(reference.packageAssetGroups) && reference.packageAssetGroups.length > 0) {
    return reference.packageAssetGroups.filter((group) => Array.isArray(group.assets) && group.assets.length > 0);
  }

  return PACKAGE_ASSET_GROUPS.map(([key, label]) => ({
    key,
    label,
    assets: Array.isArray(reference[key]) ? reference[key] : []
  })).filter((group) => group.assets.length > 0);
}

function getPackageAssetGroupKind(key) {
  return `${key}Assets`;
}

function isPackageAssetGroupKind(groupKind) {
  return PACKAGE_ASSET_GROUPS.some(([key]) => groupKind === getPackageAssetGroupKind(key));
}

function getPackageAssetGroupLabel(groupKind) {
  const group = PACKAGE_ASSET_GROUPS.find(([key]) => groupKind === getPackageAssetGroupKind(key));
  return group ? group[1] : groupKind || 'Package Assets';
}

function getPackageAssetGroupIcon(groupKind) {
  switch (groupKind) {
    case 'compileAssets':
      return new vscode.ThemeIcon('file-code');
    case 'runtimeAssets':
    case 'nativeAssets':
    case 'runtimeTargetsAssets':
      return new vscode.ThemeIcon('file-binary');
    case 'analyzersAssets':
      return new vscode.ThemeIcon('symbol-event');
    case 'contentFilesAssets':
    case 'resourceAssets':
      return new vscode.ThemeIcon('file-media');
    case 'buildAssets':
    case 'buildMultiTargetingAssets':
    case 'buildTransitiveAssets':
      return new vscode.ThemeIcon('tools');
    case 'frameworkAssembliesAssets':
      return new vscode.ThemeIcon('library');
    default:
      return new vscode.ThemeIcon('file');
  }
}

function createDependencyItem(project, groupKind, label, description, reference = {}) {
  const uri = reference.path ? vscode.Uri.file(reference.path) : undefined;

  return {
    id: `dependency-item:${project.uri}:${groupKind}:${label}:${description || ''}`,
    kind: 'dependencyItem',
    groupKind,
    label,
    description,
    tooltip: getDependencyTooltip(reference, groupKind, label, description),
    item: project,
    reference,
    uri,
    resourceUri: uri,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    contextValue: `dependencyItem.${groupKind}`
  };
}

function getReferenceLabel(reference) {
  if (!reference || !reference.name) {
    return 'Reference';
  }

  if (/[\\/]/.test(reference.name)) {
    return path.basename(reference.name, path.extname(reference.name));
  }

  return reference.name;
}

function getReferenceDescription(reference, groupKind) {
  if (!reference) {
    return undefined;
  }

  if (groupKind === 'packages' || groupKind === 'transitivePackages') {
    return [
      reference.version,
      reference.direct === false ? 'transitive' : undefined,
      reference.privateAssets ? `PrivateAssets=${reference.privateAssets}` : undefined
    ].filter(Boolean).join(' ');
  }

  if (groupKind === 'projects') {
    return reference.referenceOutputAssembly ? `ReferenceOutputAssembly=${reference.referenceOutputAssembly}` : reference.include || reference.name;
  }

  if (groupKind === 'import') {
    return reference.implicit ? reference.source : reference.condition || reference.source;
  }

  if (isPackageAssetGroupKind(groupKind)) {
    return reference.kind || groupKind;
  }

  return reference.version || reference.hintPath || reference.include || reference.name;
}

function getDependencyTooltip(reference, groupKind, label, description) {
  const lines = [
    label,
    description ? `Detail: ${description}` : undefined,
    reference.include ? `Include: ${reference.include}` : undefined,
    reference.version ? `Version: ${reference.version}` : undefined,
    reference.requested ? `Requested: ${reference.requested}` : undefined,
    reference.resolved ? `Resolved: ${reference.resolved}` : undefined,
    reference.direct !== undefined ? `Direct: ${reference.direct ? 'yes' : 'no'}` : undefined,
    reference.privateAssets ? `PrivateAssets: ${reference.privateAssets}` : undefined,
    reference.includeAssets ? `IncludeAssets: ${reference.includeAssets}` : undefined,
    reference.excludeAssets ? `ExcludeAssets: ${reference.excludeAssets}` : undefined,
    reference.hintPath ? `HintPath: ${reference.hintPath}` : undefined,
    reference.referenceOutputAssembly ? `ReferenceOutputAssembly: ${reference.referenceOutputAssembly}` : undefined,
    reference.packageSourceMappings?.length ? `Package Source Mapping: ${formatPackageSourceMappings(reference.packageSourceMappings)}` : undefined,
    reference.dependencies && reference.dependencies.length ? `Dependencies: ${reference.dependencies.map((item) => `${item.name} ${item.version || ''}`.trim()).join(', ')}` : undefined,
    reference.itemCondition ? `Item Condition: ${reference.itemCondition}` : undefined,
    reference.groupCondition ? `Group Condition: ${reference.groupCondition}` : undefined,
    reference.condition ? `Condition: ${reference.condition}` : undefined,
    reference.packageName ? `Package: ${reference.packageName}${reference.packageVersion ? ` ${reference.packageVersion}` : ''}` : undefined,
    reference.assetPath ? `Asset: ${reference.assetPath}` : undefined,
    getPackageFolderPath(reference) ? `Package Folder: ${getPackageFolderPath(reference)}` : undefined,
    reference.path ? `Path: ${reference.path}` : undefined,
    groupKind ? `Group: ${groupKind}` : undefined
  ].filter(Boolean);

  return lines.join('\n');
}

function getResolvedFrameworkDependencies(metadata, framework) {
  const resolved = metadata.resolvedDependencies || {};

  if (resolved[framework]) {
    return resolved[framework];
  }

  const normalizedFramework = normalizeFrameworkKey(framework);
  const match = Object.entries(resolved).find(([key]) => normalizeFrameworkKey(key) === normalizedFramework);
  return match ? match[1] : undefined;
}

function normalizeFrameworkKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mergeReferences(primary, secondary) {
  const result = [];
  const seen = new Set();

  for (const reference of [...primary, ...secondary]) {
    const key = String(reference.name || '').toLowerCase();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(reference);
  }

  return result;
}

function formatFrameworkName(value) {
  if (!value || value === 'Dependencies') {
    return value;
  }

  const match = /^net(\d+)\.(\d+)/i.exec(value);

  if (match) {
    return `.NET ${match[1]}.${match[2]}`;
  }

  const standardMatch = /^netstandard(\d+)\.(\d+)/i.exec(value);

  if (standardMatch) {
    return `.NET Standard ${standardMatch[1]}.${standardMatch[2]}`;
  }

  return value;
}

function getDependencyGroupIcon(groupKind) {
  if (isPackageAssetGroupKind(groupKind)) {
    return getPackageAssetGroupIcon(groupKind);
  }

  switch (groupKind) {
    case 'assemblies':
      return new vscode.ThemeIcon('library');
    case 'projects':
      return new vscode.ThemeIcon('project');
    case 'analyzers':
      return new vscode.ThemeIcon('symbol-event');
    case 'packages':
      return new vscode.ThemeIcon('package');
    case 'packageDependency':
      return new vscode.ThemeIcon('references');
    case 'frameworks':
      return new vscode.ThemeIcon('library');
    case 'sourceGenerators':
      return new vscode.ThemeIcon('sparkle');
    default:
      return new vscode.ThemeIcon('folder');
  }
}

function getDependencyItemIcon(groupKind) {
  if (isPackageAssetGroupKind(groupKind)) {
    return getPackageAssetGroupIcon(groupKind);
  }

  switch (groupKind) {
    case 'packages':
    case 'packageDependency':
      return new vscode.ThemeIcon('package');
    case 'projects':
      return new vscode.ThemeIcon('project');
    case 'assemblies':
    case 'frameworks':
      return new vscode.ThemeIcon('library');
    case 'analyzers':
      return new vscode.ThemeIcon('symbol-event');
    case 'sourceGenerators':
      return new vscode.ThemeIcon('sparkle');
    case 'import':
      return new vscode.ThemeIcon('gear');
    default:
      return new vscode.ThemeIcon('symbol-property');
  }
}

function shouldSkipDirectoryEntry(name, type) {
  if (name.startsWith('.')) {
    return true;
  }

  if (type & vscode.FileType.Directory) {
    return SKIPPED_DIRECTORY_NAMES.has(name.toLowerCase());
  }

  return false;
}

function isSolutionItem(item) {
  return item && (item.kind === 'solution' || SOLUTION_EXTENSIONS.has((item.extension || '').toLowerCase()));
}

function isSolutionUri(uri) {
  return SOLUTION_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase());
}

function isProjectFile(value) {
  return PROJECT_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function itemToUri(item) {
  if (!item || !item.uri) {
    return undefined;
  }

  try {
    return vscode.Uri.parse(item.uri);
  } catch {
    return undefined;
  }
}

function uniqueItemsByUri(items) {
  const result = [];
  const seen = new Set();

  for (const item of items) {
    if (!item || !item.uri || seen.has(item.uri)) {
      continue;
    }

    seen.add(item.uri);
    result.push(item);
  }

  return result;
}

function sortNodes(nodes) {
  return [...nodes].sort((left, right) => {
    const rank = getSortRank(left) - getSortRank(right);

    if (rank !== 0) {
      return rank;
    }

    return left.label.localeCompare(right.label, undefined, {
      sensitivity: 'base'
    });
  });
}

function addGroupProjectCounts(nodes) {
  return nodes.map((node) => {
    if (node.kind !== 'group') {
      return node;
    }

    node.children = addGroupProjectCounts(sortNodes(node.children));
    const projectCount = countProjectNodes(node);
    node.description = `${projectCount} project${projectCount === 1 ? '' : 's'}`;
    return node;
  });
}

function countProjectNodes(node) {
  if (node.kind === 'project') {
    return 1;
  }

  return node.children.reduce((total, child) => total + countProjectNodes(child), 0);
}

function getSortRank(node) {
  if (node.kind === 'dependencies') {
    return 0;
  }

  if (node.kind === 'group' || node.kind === 'directory') {
    return 1;
  }

  if (node.kind === 'project') {
    return 2;
  }

  return 3;
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const __test = {
  createDependencyReferenceXml,
  createDependencyFrameworkDetailsMarkdown,
  createDependencyNodeDetailsMarkdown,
  createDependencyPackageDetailsMarkdown,
  createPackageSourceMappingXml,
  createPackageReferenceMetadata,
  createPackageReferenceXml,
  getPackageAssetPath,
  getPackageFolderPath,
  mergeResolvedProjectReference,
  mergeResolvedFrameworkReference,
  mergeResolvedPackageReference,
  normalizeNuGetPackageVersion
};

export {
  SolutionTreeProvider,
  __test
};
