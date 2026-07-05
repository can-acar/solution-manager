const path = require('path');
const vscode = require('vscode');
const { ProjectActions } = require('./projectActions');
const { TerminalRunner } = require('./terminalRunner');
const { WorkspaceScanner } = require('./workspaceScanner');

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

    if (node.kind === 'file') {
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
  const children = buildGroupedProjectNodes(projects, unloadedProjects);
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

function buildGroupedProjectNodes(projects, unloadedProjects) {
  const root = [];

  for (const project of projects) {
    const groupParts = getProjectGroupParts(project);
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

    target.push(createProjectNode(project, unloadedProjects));
  }

  return addGroupProjectCounts(sortNodes(root));
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
    case 'dependencyItem':
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

  return [
    createDependencyItem(project, 'import', 'Sdk.props', sdk),
    createDependencyItem(project, 'import', 'Sdk.targets', sdk)
  ];
}

function getDependencyFrameworkChildren(project, framework) {
  const metadata = project.metadata || {};

  return [
    createDependencyGroup(project, framework, 'assemblies', 'Assemblies', metadata.assemblyReferences || []),
    createDependencyGroup(project, framework, 'projects', 'Projects', metadata.projectReferences || []),
    createDependencyGroup(project, framework, 'analyzers', 'Analyzers', metadata.analyzerReferences || []),
    createDependencyGroup(project, framework, 'packages', 'Packages', metadata.packageReferences || []),
    createDependencyGroup(project, framework, 'frameworks', 'Frameworks', metadata.frameworkReferences || []),
    createDependencyGroup(project, framework, 'sourceGenerators', 'Source Generators', metadata.sourceGenerators || [])
  ];
}

function createDependencyGroup(project, framework, groupKind, label, references) {
  const children = references.map((reference) => createDependencyItem(
    project,
    groupKind,
    getReferenceLabel(reference),
    reference.version || reference.name
  ));

  return {
    id: `dependency-group:${project.uri}:${framework}:${groupKind}`,
    kind: 'dependencyGroup',
    groupKind,
    label,
    description: references.length ? `${references.length}` : undefined,
    children,
    collapsibleState: children.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    contextValue: `dependencyGroup:${groupKind}`
  };
}

function createDependencyItem(project, groupKind, label, description) {
  return {
    id: `dependency-item:${project.uri}:${groupKind}:${label}`,
    kind: 'dependencyItem',
    groupKind,
    label,
    description,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    contextValue: `dependencyItem:${groupKind}`
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

function formatFrameworkName(value) {
  if (!value || value === 'Dependencies') {
    return value;
  }

  const match = /^net(\d+)\.(\d+)/i.exec(value);

  if (match) {
    return `.NET ${match[1]}.${match[2]}`;
  }

  return value;
}

function getDependencyGroupIcon(groupKind) {
  switch (groupKind) {
    case 'assemblies':
      return new vscode.ThemeIcon('library');
    case 'projects':
      return new vscode.ThemeIcon('project');
    case 'analyzers':
      return new vscode.ThemeIcon('symbol-event');
    case 'packages':
      return new vscode.ThemeIcon('package');
    case 'frameworks':
      return new vscode.ThemeIcon('library');
    case 'sourceGenerators':
      return new vscode.ThemeIcon('sparkle');
    default:
      return new vscode.ThemeIcon('folder');
  }
}

function getDependencyItemIcon(groupKind) {
  switch (groupKind) {
    case 'packages':
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

module.exports = {
  SolutionTreeProvider
};
