import * as path from 'path';
import * as vscode from 'vscode';
import { updateProjectItemReferences } from '#src/projectFileEditor';
import { NuGetProtocolHost } from '#src/nugetProtocolHost';
import { quoteForShell, TerminalRunner } from '#src/terminalRunner';

type NuGetManagerProject = {
  name: string;
  path: string;
  uri?: string;
  relativePath?: string;
  metadata?: {
    packageReferences?: NuGetPackageReference[];
    nugetConfig?: NuGetConfig;
  };
};

type NuGetPackageReference = {
  name?: string;
  include?: string;
  version?: string;
  centralVersion?: string;
  centralPackageVersion?: NuGetPackageReference;
  versionSourcePath?: string;
  versionSourceCondition?: string;
  resolvedVersion?: string;
  versionSource?: string;
  identityAttribute?: string;
  condition?: string;
  itemCondition?: string;
  groupCondition?: string;
};

type NuGetConfig = {
  packageSources?: NuGetPackageSource[];
};

type NuGetPackageSource = {
  key?: string;
  value?: string;
  disabled?: boolean;
  editable?: boolean;
  origin?: string;
};

type NuGetSearchResult = {
  id: string;
  name?: string;
  sourceUrl?: string;
  version: string;
  description: string;
  authors: string;
  totalDownloads: number;
  versions?: NuGetPackageVersion[];
  projectUrl?: string;
  iconUrl?: string;
};

type NuGetPackageVersion = {
  version: string;
  downloads?: number;
};

type NuGetPackageDetails = {
  id: string;
  version: string;
  description: string;
  authors: string;
  licenseUrl?: string;
  projectUrl?: string;
  tags?: string;
  versions: NuGetPackageVersion[];
  dependencyGroups: Array<{
    targetFramework: string;
    dependencies: Array<{
      id: string;
      range?: string;
    }>;
  }>;
};

type NuGetManagerMessage = {
  type: string;
  requestId?: string;
  projectPath?: string;
  query?: string;
  prerelease?: boolean;
  sourceUrl?: string;
  sourceName?: string;
  packageId?: string;
  version?: string;
};

const NUGET_ORG_SOURCE: NuGetPackageSource = {
  key: 'nuget.org',
  value: 'https://api.nuget.org/v3/index.json',
  disabled: false
};

class NuGetManagerView {
  private panel?: vscode.WebviewPanel;
  private projects: NuGetManagerProject[] = [];
  private readonly protocolHost: NuGetProtocolHost;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly terminalRunner: TerminalRunner,
    private readonly getState: () => Promise<any>,
    private readonly refresh: (options?: any) => Promise<void>
  ) {
    this.protocolHost = new NuGetProtocolHost(context.extensionPath);
  }

  async show(node?: any): Promise<void> {
    const state = await this.getState();
    this.projects = getProjectsForNode(node, state);

    if (this.projects.length === 0) {
      vscode.window.showInformationMessage('Solution Manager: no projects were found for NuGet management.');
      return;
    }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'solutionManager.nugetManager',
        'NuGet Manager',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }, undefined, this.context.subscriptions);
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), undefined, this.context.subscriptions);
    }

    this.panel.title = 'NuGet Manager';
    this.panel.webview.html = this.createHtml(this.panel.webview);
    this.panel.reveal();
    await this.postState();
  }

  private async handleMessage(message: NuGetManagerMessage): Promise<void> {
    try {
      if (message.type === 'ready' || message.type === 'refresh') {
        await this.refresh({ userVisible: false });
        const state = await this.getState();
        this.projects = mergeFreshProjectMetadata(this.projects, state);
        await this.postState(message.requestId);
        return;
      }

      if (message.type === 'search') {
        const results = await this.searchPackages(message.sourceUrl, message.query || '', Boolean(message.prerelease));
        await this.postResponse(message.requestId, {
          packages: results
        });
        return;
      }

      if (message.type === 'details') {
        const sourceUrl = message.sourceUrl || NUGET_ORG_SOURCE.value;
        const packageId = requireText(message.packageId, 'Package id is required.');
        const details = await this.getPackageDetails(sourceUrl, packageId, message.version, Boolean(message.prerelease));
        await this.postResponse(message.requestId, {
          details
        });
        return;
      }

      if (message.type === 'addSource' || message.type === 'updateSource') {
        const sourceName = requireText(message.sourceName, 'Source name is required.');
        const sourceUrl = requireText(message.sourceUrl, 'Source URL is required.');
        await upsertSettingsSource(message.type === 'updateSource' ? message.packageId : undefined, sourceName, sourceUrl);
        await this.postState(message.requestId);
        return;
      }

      if (message.type === 'removeSource') {
        const sourceUrl = requireText(message.sourceUrl, 'Source URL is required.');
        await removeSettingsSource(sourceUrl);
        await this.postState(message.requestId);
        return;
      }

      if (message.type === 'install' || message.type === 'update') {
        const project = this.requireProject(message.projectPath);
        const packageId = requireText(message.packageId, 'Package id is required.');
        const version = String(message.version || '').trim();
        const updatedInProjectFiles = await this.tryApplyProjectFilePackageUpdate(project, packageId, version);

        if (updatedInProjectFiles) {
          await this.refresh({ userVisible: false });
          const state = await this.getState();
          this.projects = mergeFreshProjectMetadata(this.projects, state);
          await this.postState(message.requestId);
          await this.postNotice(message.requestId, `${message.type === 'update' ? 'Updated' : 'Installed'} ${packageId} in project files.`);
          return;
        }

        const versionArg = version ? ` --version ${quoteForShell(version)}` : '';
        const sourceArg = message.sourceUrl ? ` --source ${quoteForShell(normalizeSourceForDotnet(message.sourceUrl))}` : '';
        const restoreArg = getSkipRestore() ? ' --no-restore' : '';
        this.terminalRunner.runCommand(`dotnet add ${quoteForShell(project.path)} package ${quoteForShell(packageId)}${versionArg}${sourceArg}${restoreArg}`);
        await this.postNotice(message.requestId, `${message.type === 'update' ? 'Update' : 'Install'} command sent to terminal.`);
        return;
      }

      if (message.type === 'remove') {
        const project = this.requireProject(message.projectPath);
        const packageId = requireText(message.packageId, 'Package id is required.');
        this.terminalRunner.runCommand(`dotnet remove ${quoteForShell(project.path)} package ${quoteForShell(packageId)}`);
        await this.postNotice(message.requestId, 'Remove command sent to terminal.');
        return;
      }

      if (message.type === 'list') {
        const project = this.requireProject(message.projectPath);
        this.terminalRunner.runCommand(`dotnet list ${quoteForShell(project.path)} package --include-transitive`);
        await this.postNotice(message.requestId, 'List packages command sent to terminal.');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.postResponse(message.requestId, {
        error: errorMessage
      });
      vscode.window.showErrorMessage(`Solution Manager: ${errorMessage}`);
    }
  }

  private async postState(requestId?: string): Promise<void> {
    await this.postResponse(requestId, {
      projects: this.projects.map(toWebProject),
      sources: await this.getPackageSources()
    });
  }

  private async postNotice(requestId: string | undefined, message: string): Promise<void> {
    await this.postResponse(requestId, {
      notice: message
    });
    vscode.window.setStatusBarMessage(`Solution Manager: ${message}`, 2500);
  }

  private async postResponse(requestId: string | undefined, payload: Record<string, unknown>): Promise<void> {
    await this.panel?.webview.postMessage({
      type: 'response',
      requestId,
      ...payload
    });
  }

  private requireProject(projectPath?: string): NuGetManagerProject {
    const project = this.projects.find((item) => normalizePath(item.path) === normalizePath(projectPath || ''));

    if (!project) {
      throw new Error('Selected project was not found.');
    }

    return project;
  }

  private createHtml(webview: vscode.Webview): string {
    const nonce = createNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>NuGet Manager</title>
  <style>
    :root {
      color-scheme: dark light;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    body {
      margin: 0;
      padding: 12px;
      overflow: hidden;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(220px, 30%) 1fr;
      gap: 12px;
      height: calc(100vh - 24px);
      min-height: 0;
    }
    .pane {
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .toolbar, .search {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    select, input, button {
      height: 28px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      font: inherit;
    }
    input {
      min-width: 0;
      flex: 1;
      padding: 0 8px;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-border, transparent);
      padding: 0 10px;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled {
      opacity: .45;
      cursor: default;
    }
    .list {
      display: flex;
      flex-direction: column;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .row.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .title {
      font-weight: 600;
      line-height: 1.35;
    }
    .meta, .desc {
      color: var(--vscode-descriptionForeground);
      margin-top: 3px;
      line-height: 1.35;
    }
    .actions {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .split {
      display: grid;
      grid-template-rows: minmax(150px, 42%) 1fr;
      height: 100%;
      min-height: 0;
    }
    .section-title {
      padding: 8px;
      font-weight: 600;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .empty {
      padding: 18px 12px;
      color: var(--vscode-descriptionForeground);
    }
    .status {
      padding: 6px 8px;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-panel-border);
    }
    .source-editor {
      display: grid;
      grid-template-columns: 1fr 1.5fr auto;
      gap: 6px;
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      height: 16px;
      padding: 0 5px;
      margin-left: 6px;
      border: 1px solid var(--vscode-descriptionForeground);
      border-radius: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 400;
    }
    .details-grid {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 6px 14px;
      padding: 8px;
    }
    .details-label {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .dependencies {
      padding: 0 8px 10px;
    }
    .dependencies ul {
      margin: 4px 0 8px 18px;
      padding: 0;
    }
    @media (max-width: 820px) {
      .shell {
        grid-template-columns: 1fr;
        grid-template-rows: 42% 58%;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="pane">
      <div class="toolbar">
        <select id="projectSelect" title="Project"></select>
        <button id="refreshButton" class="secondary">Refresh</button>
      </div>
      <div class="section-title">Installed Packages</div>
      <div id="installedList" class="list"></div>
      <div class="section-title">Package Sources</div>
      <div id="sourcesList" class="list"></div>
      <div class="source-editor">
        <input id="sourceNameInput" placeholder="Source name" />
        <input id="sourceUrlInput" placeholder="https://api.nuget.org/v3/index.json" />
        <button id="saveSourceButton">Add</button>
      </div>
    </section>
    <section class="pane split">
      <div>
        <div class="search">
          <input id="queryInput" placeholder="Search NuGet packages" />
          <label><input id="prereleaseInput" type="checkbox" style="height:auto" /> Prerelease</label>
          <select id="sourceSelect" title="Package source"></select>
          <button id="searchButton">Search</button>
        </div>
        <div id="searchResults" class="list"></div>
      </div>
      <div>
        <div class="section-title">Details</div>
        <div id="details" class="empty">Select a package to view details.</div>
      </div>
    </section>
  </div>
  <div id="status" class="status">Ready</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      projects: [],
      sources: [],
      selectedProjectPath: '',
      selectedPackage: undefined,
      selectedDetails: undefined,
      editingSourceUrl: '',
      searchResults: []
    };
    let nextRequestId = 1;
    const pending = new Map();
    const $ = (id) => document.getElementById(id);

    function request(type, payload = {}) {
      const requestId = String(nextRequestId++);
      vscode.postMessage({ type, requestId, ...payload });
      return new Promise((resolve) => pending.set(requestId, resolve));
    }

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type !== 'response') return;
      if (message.projects) {
        state.projects = message.projects;
        state.sources = message.sources || [];
        if (!state.selectedProjectPath && state.projects[0]) {
          state.selectedProjectPath = state.projects[0].path;
        }
        render();
      }
      if (message.packages) {
        state.searchResults = message.packages;
        renderSearchResults();
      }
      if (message.details) {
        state.selectedDetails = message.details;
        renderDetails();
      }
      if (message.notice) setStatus(message.notice);
      if (message.error) setStatus(message.error);
      const resolve = pending.get(message.requestId);
      if (resolve) {
        pending.delete(message.requestId);
        resolve(message);
      }
    });

    $('refreshButton').addEventListener('click', async () => {
      setStatus('Refreshing...');
      await request('refresh');
      setStatus('Refreshed');
    });
    $('projectSelect').addEventListener('change', (event) => {
      state.selectedProjectPath = event.target.value;
      renderInstalled();
    });
    $('searchButton').addEventListener('click', search);
    $('saveSourceButton').addEventListener('click', saveSource);
    $('queryInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') search();
    });

    async function search() {
      setStatus('Searching...');
      await request('search', {
        query: $('queryInput').value,
        prerelease: $('prereleaseInput').checked,
        sourceUrl: $('sourceSelect').value
      });
      setStatus('Search complete');
    }

    function render() {
      $('projectSelect').innerHTML = state.projects.map((project) =>
        '<option value="' + escapeAttribute(project.path) + '"' + (project.path === state.selectedProjectPath ? ' selected' : '') + '>' + escapeHtml(project.name) + '</option>'
      ).join('');
      $('sourceSelect').innerHTML = state.sources.map((source) =>
        '<option value="' + escapeAttribute(source.url) + '">' + escapeHtml(source.name) + '</option>'
      ).join('');
      renderInstalled();
      renderSources();
      renderSearchResults();
    }

    function renderInstalled() {
      const project = selectedProject();
      const packages = project ? project.packages : [];
      $('installedList').innerHTML = packages.length ? packages.map((pkg) => packageRow(pkg, true)).join('') : '<div class="empty">No PackageReference items found.</div>';
      document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => runPackageAction('remove', button.dataset.remove)));
      document.querySelectorAll('[data-list]').forEach((button) => button.addEventListener('click', () => request('list', { projectPath: state.selectedProjectPath })));
    }

    function renderSources() {
      $('sourcesList').innerHTML = state.sources.length ? state.sources.map((source) => {
        const badge = source.editable ? '' : '<span class="badge">' + escapeHtml(source.origin || 'nuget.config') + '</span>';
        const actions = source.editable
          ? '<button class="secondary" data-edit-source="' + escapeAttribute(source.url) + '">Edit</button><button data-remove-source="' + escapeAttribute(source.url) + '">Remove</button>'
          : '';
        return '<div class="row"><div><div class="title">' + escapeHtml(source.name) + badge + '</div><div class="meta">' + escapeHtml(source.url) + '</div></div><div class="actions">' + actions + '</div></div>';
      }).join('') : '<div class="empty">No package sources found.</div>';
      document.querySelectorAll('[data-edit-source]').forEach((button) => button.addEventListener('click', () => editSource(button.dataset.editSource)));
      document.querySelectorAll('[data-remove-source]').forEach((button) => button.addEventListener('click', () => removeSource(button.dataset.removeSource)));
    }

    function renderSearchResults() {
      $('searchResults').innerHTML = state.searchResults.length ? state.searchResults.map((pkg) => packageRow(pkg, false)).join('') : '<div class="empty">Search for packages to install.</div>';
      document.querySelectorAll('[data-select-package]').forEach((row) => row.addEventListener('click', () => {
        const pkg = state.searchResults.find((item) => item.id === row.dataset.selectPackage);
        state.selectedPackage = pkg;
        state.selectedDetails = undefined;
        renderDetails();
        loadDetails(pkg.id, pkg.version);
      }));
      document.querySelectorAll('[data-install]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        const pkg = state.searchResults.find((item) => item.id === button.dataset.install);
        runPackageAction(isInstalled(pkg.id) ? 'update' : 'install', pkg.id, pkg.version);
      }));
      renderDetails();
    }

    function renderDetails() {
      const pkg = state.selectedPackage;
      if (!pkg) {
        $('details').innerHTML = '<div class="empty">Select a package to view details.</div>';
        return;
      }
      const details = state.selectedDetails;
      const versions = details && details.versions && details.versions.length ? details.versions : (pkg.versions || [{ version: pkg.version }]);
      const selectedVersion = details ? details.version : pkg.version;
      const dependencyHtml = details ? renderDependencies(details.dependencyGroups || []) : '<div class="empty">Loading package details...</div>';
      $('details').innerHTML =
        '<div class="details-grid">' +
        '<div class="details-label">Package</div><div><strong>' + escapeHtml(pkg.id) + '</strong></div>' +
        '<div class="details-label">Version</div><div><select id="versionSelect">' + versions.map((item) => '<option value="' + escapeAttribute(item.version) + '"' + (item.version === selectedVersion ? ' selected' : '') + '>' + escapeHtml(item.version) + '</option>').join('') + '</select></div>' +
        '<div class="details-label">Authors</div><div>' + escapeHtml((details && details.authors) || pkg.authors || '') + '</div>' +
        '<div class="details-label">Downloads</div><div>' + String(pkg.totalDownloads || 0) + '</div>' +
        '<div class="details-label">Description</div><div>' + escapeHtml((details && details.description) || pkg.description || 'No description.') + '</div>' +
        '</div>' +
        '<div class="actions" style="justify-content:flex-start;padding:0 8px 8px"><button id="installSelectedButton">' + (isInstalled(pkg.id) ? 'Update' : 'Install') + '</button></div>' +
        '<div class="section-title">Dependencies</div>' +
        dependencyHtml;
      $('details').querySelector('#installSelectedButton').addEventListener('click', () => runPackageAction(isInstalled(pkg.id) ? 'update' : 'install', pkg.id, $('versionSelect').value));
      $('details').querySelector('#versionSelect').addEventListener('change', (event) => loadDetails(pkg.id, event.target.value));
    }

    function renderDependencies(groups) {
      if (!groups.length) {
        return '<div class="empty">No dependencies.</div>';
      }
      return '<div class="dependencies">' + groups.map((group) =>
        '<div class="meta">' + escapeHtml(group.targetFramework || 'Any') + '</div><ul>' +
        (group.dependencies && group.dependencies.length ? group.dependencies.map((dep) => '<li>' + escapeHtml(dep.id) + ' ' + escapeHtml(dep.range || '') + '</li>').join('') : '<li>No dependencies</li>') +
        '</ul>'
      ).join('') + '</div>';
    }

    async function loadDetails(packageId, version) {
      if (!packageId) return;
      await request('details', {
        packageId,
        version,
        sourceUrl: $('sourceSelect').value
      });
    }

    function packageRow(pkg, installed) {
      const id = pkg.id || pkg.name;
      const version = pkg.version || pkg.centralVersion || '';
      const installedMeta = installed ? 'Version: ' + escapeHtml(version || 'unspecified') + (pkg.versionSource ? ' · ' + escapeHtml(pkg.versionSource) : '') : 'Latest: ' + escapeHtml(version || '');
      const action = installed
        ? '<button class="secondary" data-list="' + escapeAttribute(id) + '">List</button><button data-remove="' + escapeAttribute(id) + '">Remove</button>'
        : '<button data-install="' + escapeAttribute(id) + '">' + (isInstalled(id) ? 'Update' : 'Install') + '</button>';
      return '<div class="row" data-select-package="' + escapeAttribute(id) + '"><div><div class="title">' + escapeHtml(id) + '</div><div class="meta">' + installedMeta + '</div><div class="desc">' + escapeHtml(pkg.description || '') + '</div></div><div class="actions">' + action + '</div></div>';
    }

    async function runPackageAction(type, packageId, version) {
      if (!state.selectedProjectPath) return;
      setStatus(type + ' ' + packageId + '...');
      await request(type, {
        projectPath: state.selectedProjectPath,
        packageId,
        version,
        sourceUrl: $('sourceSelect').value
      });
    }

    async function saveSource() {
      const sourceName = $('sourceNameInput').value.trim();
      const sourceUrl = $('sourceUrlInput').value.trim();
      if (!sourceName || !sourceUrl) {
        setStatus('Source name and URL are required.');
        return;
      }
      await request(state.editingSourceUrl ? 'updateSource' : 'addSource', {
        packageId: state.editingSourceUrl,
        sourceName,
        sourceUrl
      });
      state.editingSourceUrl = '';
      $('sourceNameInput').value = '';
      $('sourceUrlInput').value = '';
      $('saveSourceButton').textContent = 'Add';
      setStatus('Source saved');
    }

    function editSource(sourceUrl) {
      const source = state.sources.find((item) => item.url === sourceUrl && item.editable);
      if (!source) return;
      state.editingSourceUrl = source.url;
      $('sourceNameInput').value = source.name;
      $('sourceUrlInput').value = source.url;
      $('saveSourceButton').textContent = 'Save';
    }

    async function removeSource(sourceUrl) {
      await request('removeSource', { sourceUrl });
      setStatus('Source removed');
    }

    function selectedProject() {
      return state.projects.find((project) => project.path === state.selectedProjectPath);
    }

    function isInstalled(packageId) {
      const project = selectedProject();
      return Boolean(project && project.packages.some((pkg) => String(pkg.id).toLowerCase() === String(packageId).toLowerCase()));
    }

    function setStatus(value) {
      $('status').textContent = value;
    }

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function escapeAttribute(value) {
      return escapeHtml(value).replace(/\\x60/g, '&#96;');
    }

    vscode.postMessage({ type: 'ready', requestId: 'ready' });
  </script>
</body>
</html>`;
  }

  private async getPackageSources(): Promise<Array<{ name: string; url: string; editable: boolean; origin: string }>> {
    return getPackageSources(this.projects, await this.listProtocolSources());
  }

  private async listProtocolSources(): Promise<Array<{ name: string; url: string; editable: boolean; origin: string }>> {
    try {
      return (await this.protocolHost.listSources()).map((source) => ({
        name: String(source.Name || source.name || source.Url || source.url || ''),
        url: String(source.Url || source.url || ''),
        editable: false,
        origin: String(source.Origin || source.origin || 'nuget.config')
      })).filter((source) => source.name && source.url);
    } catch (error) {
      vscode.window.showWarningMessage(`Solution Manager: NuGet sources could not be loaded from nuget.config: ${getErrorMessage(error)}`);
      return [];
    }
  }

  private async searchPackages(sourceUrl: string | undefined, query: string, prerelease: boolean): Promise<NuGetSearchResult[]> {
    const sources = sourceUrl
      ? [{ url: sourceUrl }]
      : (await this.getPackageSources()).map((source) => ({ url: source.url }));
    const results = await Promise.allSettled(
      sources.map(async (source) => {
        const packages = await this.protocolHost.search(source.url, query, prerelease, 0, 50);
        return packages.map((item) => mapProtocolPackage(item, source.url));
      })
    );
    const merged = new Map<string, NuGetSearchResult>();
    const failures: string[] = [];

    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(getErrorMessage(result.reason));
        continue;
      }

      for (const item of result.value) {
        const key = String(item.id || item.name || '').toLowerCase();
        if (key && !merged.has(key)) {
          merged.set(key, item);
        }
      }
    }

    if (merged.size === 0 && failures.length > 0) {
      throw new Error(failures[0]);
    }

    return [...merged.values()];
  }

  private async getPackageDetails(sourceUrl: string, packageId: string, version: string | undefined, prerelease: boolean): Promise<NuGetPackageDetails> {
    const packageInfo = mapProtocolPackage(await this.protocolHost.getPackage(sourceUrl, packageId, prerelease), sourceUrl);
    const selectedVersion = version && packageInfo.versions?.some((item) => item.version === version)
      ? version
      : packageInfo.version;
    const details = await this.protocolHost.getPackageDetails(sourceUrl, packageId, selectedVersion);
    const dependencyGroups = mapProtocolDependencyGroups(details);

    return {
      id: packageInfo.id,
      version: selectedVersion,
      description: packageInfo.description,
      authors: packageInfo.authors,
      licenseUrl: (packageInfo as any).licenseUrl,
      projectUrl: packageInfo.projectUrl,
      tags: (packageInfo as any).tags,
      versions: packageInfo.versions || [],
      dependencyGroups
    };
  }

  private async tryApplyProjectFilePackageUpdate(project: NuGetManagerProject, packageId: string, version: string): Promise<boolean> {
    if (!version) {
      return false;
    }

    const existingReference = findPackageReference(project, packageId);

    if (isCentralPackageReference(existingReference)) {
      const centralReference = existingReference?.centralPackageVersion || findCentralPackageVersion(project, packageId);

      if (!centralReference?.path) {
        return false;
      }

      if (hasReferenceCondition(centralReference) || hasReferenceCondition(existingReference)) {
        throw new Error(`Package '${packageId}' uses a conditional central package version. Edit Directory.Packages.props manually.`);
      }

      await updateProjectItemReferences(centralReference.path, [{
        action: 'add',
        elementName: 'PackageVersion',
        include: centralReference.include || centralReference.name || packageId,
        identityAttribute: centralReference.identityAttribute || 'Include',
        groupCondition: centralReference.groupCondition,
        metadata: {
          Version: version
        }
      }]);
      return true;
    }

    const centralManagement = await readCentralPackageManagement(project.path);

    if (!centralManagement.enabled || !centralManagement.path || existingReference) {
      return false;
    }

    await updateProjectItemReferences(project.path, [{
      action: 'add',
      elementName: 'PackageReference',
      include: packageId
    }]);
    await updateProjectItemReferences(centralManagement.path, [{
      action: 'add',
      elementName: 'PackageVersion',
      include: packageId,
      metadata: {
        Version: version
      }
    }]);
    return true;
  }
}

function getProjectsForNode(node: any, state: any): NuGetManagerProject[] {
  if (node?.item?.kind === 'solution') {
    return normalizeProjects(node.item.children || []);
  }

  if (node?.item?.kind === 'project') {
    return normalizeProjects([node.item]);
  }

  if (node?.kind === 'dependencies' && node.item) {
    return normalizeProjects([node.item]);
  }

  return normalizeProjects(state?.projects || []);
}

function mergeFreshProjectMetadata(projects: NuGetManagerProject[], state: any): NuGetManagerProject[] {
  const byPath = new Map(normalizeProjects(state?.projects || []).map((project) => [normalizePath(project.path), project]));

  return projects.map((project) => byPath.get(normalizePath(project.path)) || project);
}

function normalizeProjects(projects: any[]): NuGetManagerProject[] {
  const seen = new Set<string>();
  const result: NuGetManagerProject[] = [];

  for (const project of projects || []) {
    if (!project?.path) {
      continue;
    }

    const key = normalizePath(project.path);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(project);
  }

  return result.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

function toWebProject(project: NuGetManagerProject): Record<string, unknown> {
  return {
    name: project.name || path.basename(project.path, path.extname(project.path)),
    path: project.path,
    relativePath: project.relativePath || project.path,
    packages: (project.metadata?.packageReferences || []).map((reference) => ({
      id: reference.name || reference.include,
      name: reference.name || reference.include,
      version: reference.version || reference.centralVersion || reference.resolvedVersion,
      centralVersion: reference.centralVersion,
      versionSource: reference.versionSource
    })).filter((reference) => reference.id)
  };
}

function getPackageSources(projects: NuGetManagerProject[]): Array<{ name: string; url: string; editable: boolean; origin: string }> {
  const sources = new Map<string, { name: string; url: string; editable: boolean; origin: string }>();

  for (const source of getSettingsSources()) {
    sources.set(source.url.toLowerCase(), source);
  }

  for (const project of projects) {
    for (const source of project.metadata?.nugetConfig?.packageSources || []) {
      if (!source.value || source.disabled) {
        continue;
      }

      const key = source.value.toLowerCase();

      if (sources.has(key)) {
        continue;
      }

      sources.set(key, {
        name: source.key || source.value,
        url: source.value,
        editable: false,
        origin: 'nuget.config'
      });
    }
  }

  sources.set(NUGET_ORG_SOURCE.value!.toLowerCase(), {
    name: NUGET_ORG_SOURCE.key!,
    url: NUGET_ORG_SOURCE.value!,
    editable: true,
    origin: 'settings'
  });

  return [...sources.values()];
}

async function searchNuGetPackages(sourceUrl: string, query: string, prerelease: boolean): Promise<NuGetSearchResult[]> {
  const searchUrl = await getSearchServiceUrl(sourceUrl);
  const url = new URL(searchUrl);

  url.searchParams.set('q', query);
  url.searchParams.set('prerelease', prerelease ? 'true' : 'false');
  url.searchParams.set('skip', '0');
  url.searchParams.set('take', '30');

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`NuGet search failed with HTTP ${response.status}.`);
  }

  const payload = await response.json() as any;

  return (payload.data || []).map((item: any) => ({
    id: String(item.id || ''),
    version: String(item.version || ''),
    description: String(item.description || ''),
    authors: String(item.authors || ''),
    totalDownloads: Number(item.totalDownloads || 0),
    versions: Array.isArray(item.versions)
      ? item.versions.map((version: any) => ({
        version: String(version.version || ''),
        downloads: Number(version.downloads || 0)
      })).filter((version: NuGetPackageVersion) => version.version)
      : [],
    projectUrl: item.projectUrl,
    iconUrl: item.iconUrl
  })).filter((item: NuGetSearchResult) => item.id);
}

async function getNuGetPackageDetails(sourceUrl: string, packageId: string, version?: string): Promise<NuGetPackageDetails> {
  const registrationBaseUrl = await getServiceUrl(sourceUrl, 'registrationsbaseurl');
  const indexUrl = `${registrationBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(packageId.toLowerCase())}/index.json`;
  const response = await fetch(indexUrl, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`NuGet package details failed with HTTP ${response.status}.`);
  }

  const payload = await response.json() as any;
  const leaves = flattenRegistrationLeaves(payload);
  const versions = leaves.map((leaf) => ({
    version: String(leaf.catalogEntry?.version || leaf.version || ''),
    downloads: Number(leaf.packageContent ? 0 : leaf.downloads || 0)
  })).filter((item) => item.version);
  const selectedVersion = version && versions.some((item) => item.version === version)
    ? version
    : versions[versions.length - 1]?.version || '';
  const selectedLeaf = leaves.find((leaf) => String(leaf.catalogEntry?.version || leaf.version || '') === selectedVersion) || leaves[leaves.length - 1] || {};
  const entry = selectedLeaf.catalogEntry || {};

  return {
    id: String(entry.id || packageId),
    version: selectedVersion,
    description: String(entry.description || ''),
    authors: Array.isArray(entry.authors) ? entry.authors.join(', ') : String(entry.authors || ''),
    licenseUrl: entry.licenseUrl,
    projectUrl: entry.projectUrl,
    tags: Array.isArray(entry.tags) ? entry.tags.join(', ') : String(entry.tags || ''),
    versions,
    dependencyGroups: readDependencyGroups(entry.dependencyGroups || [])
  };
}

function flattenRegistrationLeaves(payload: any): any[] {
  const result: any[] = [];

  for (const page of payload.items || []) {
    if (Array.isArray(page.items)) {
      result.push(...page.items);
    }
  }

  if (Array.isArray(payload.items) && payload.items.some((item: any) => item.catalogEntry)) {
    result.push(...payload.items);
  }

  return result;
}

function readDependencyGroups(groups: any[]): NuGetPackageDetails['dependencyGroups'] {
  return (groups || []).map((group) => ({
    targetFramework: String(group.targetFramework || ''),
    dependencies: (group.dependencies || []).map((dependency: any) => ({
      id: String(dependency.id || ''),
      range: dependency.range ? String(dependency.range) : undefined
    })).filter((dependency: { id: string }) => dependency.id)
  }));
}

async function getSearchServiceUrl(sourceUrl: string): Promise<string> {
  return getServiceUrl(sourceUrl, 'searchqueryservice');
}

async function getServiceUrl(sourceUrl: string, serviceType: string): Promise<string> {
  const normalized = normalizeSourceUrl(sourceUrl);

  if (!/\/index\.json$/i.test(normalized)) {
    return normalized;
  }

  const response = await fetch(normalized, {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`NuGet source index failed with HTTP ${response.status}.`);
  }

  const index = await response.json() as any;
  const resource = (index.resources || []).find((item: any) => String(item['@type'] || '').toLowerCase().includes(serviceType));

  if (!resource?.['@id']) {
    throw new Error(`NuGet source does not expose a ${serviceType} endpoint.`);
  }

  return resource['@id'];
}

function getSettingsSources(): Array<{ name: string; url: string; editable: boolean; origin: string }> {
  const configured = vscode.workspace.getConfiguration('solutionManager.nuget').get<string[]>('sources') || [];
  const sources: Array<{ name: string; url: string; editable: boolean; origin: string }> = [];

  for (const value of configured) {
    try {
      const source = JSON.parse(value) as { name?: string; url?: string };

      if (source.name && source.url) {
        sources.push({
          name: source.name,
          url: source.url,
          editable: true,
          origin: 'settings'
        });
      }
    } catch {
      continue;
    }
  }

  return sources;
}

async function upsertSettingsSource(previousUrl: string | undefined, name: string, url: string): Promise<void> {
  const sources = getSettingsSources()
    .filter((source) => !previousUrl || source.url.toLowerCase() !== previousUrl.toLowerCase())
    .filter((source) => source.url.toLowerCase() !== url.toLowerCase());

  sources.push({
    name,
    url,
    editable: true,
    origin: 'settings'
  });
  await updateSettingsSources(sources);
}

async function removeSettingsSource(url: string): Promise<void> {
  const sources = getSettingsSources().filter((source) => source.url.toLowerCase() !== url.toLowerCase());
  await updateSettingsSources(sources);
}

async function updateSettingsSources(sources: Array<{ name: string; url: string }>): Promise<void> {
  await vscode.workspace.getConfiguration('solutionManager.nuget').update(
    'sources',
    sources.map((source) => JSON.stringify({ name: source.name, url: source.url })),
    vscode.ConfigurationTarget.Global
  );
}

function getSkipRestore(): boolean {
  return Boolean(vscode.workspace.getConfiguration('solutionManager.nuget').get<boolean>('skipRestore'));
}

function normalizeSourceUrl(value: string): string {
  const source = String(value || NUGET_ORG_SOURCE.value).trim();

  if (/^https?:\/\//i.test(source)) {
    return source;
  }

  throw new Error('Only HTTP(S) NuGet v3 sources can be searched from the manager.');
}

function normalizeSourceForDotnet(source: string): string {
  try {
    const uri = vscode.Uri.parse(source);

    if (uri.scheme === 'file') {
      return uri.fsPath;
    }
  } catch {
    // Keep the original value if VS Code cannot parse it as a URI.
  }

  return source;
}

function requireText(value: unknown, message: string): string {
  const text = String(value || '').trim();

  if (!text) {
    throw new Error(message);
  }

  return text;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return value;
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value || '');
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

export {
  NuGetManagerView
};
