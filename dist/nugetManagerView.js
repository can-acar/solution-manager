"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.__test = exports.NuGetManagerView = void 0;
exports.mapProtocolDependencyGroups = mapProtocolDependencyGroups;
exports.mapProtocolPackage = mapProtocolPackage;
exports.getPackageSources = getPackageSources;
exports.canUpdatePackageReference = canUpdatePackageReference;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const projectFileEditor_1 = require("#src/projectFileEditor");
const nugetProtocolHost_1 = require("#src/nugetProtocolHost");
const terminalRunner_1 = require("#src/terminalRunner");
const NUGET_ORG_SOURCE = {
    key: 'nuget.org',
    value: 'https://api.nuget.org/v3/index.json',
    disabled: false
};
class NuGetManagerView {
    context;
    terminalRunner;
    getState;
    refresh;
    panel;
    projects = [];
    protocolHost;
    constructor(context, terminalRunner, getState, refresh) {
        this.context = context;
        this.terminalRunner = terminalRunner;
        this.getState = getState;
        this.refresh = refresh;
        this.protocolHost = new nugetProtocolHost_1.NuGetProtocolHost(context.extensionPath);
    }
    async show(node) {
        const state = await this.getState();
        this.projects = getProjectsForNode(node, state);
        if (this.projects.length === 0) {
            vscode.window.showInformationMessage('Solution Manager: no projects were found for NuGet management.');
            return;
        }
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('solutionManager.nugetManager', 'NuGet Manager', vscode.ViewColumn.One, {
                enableScripts: true,
                retainContextWhenHidden: true
            });
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
    async handleMessage(message) {
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
                const versionArg = version ? ` --version ${(0, terminalRunner_1.quoteForShell)(version)}` : '';
                const sourceArg = message.sourceUrl ? ` --source ${(0, terminalRunner_1.quoteForShell)(normalizeSourceForDotnet(message.sourceUrl))}` : '';
                const restoreArg = getSkipRestore() ? ' --no-restore' : '';
                this.terminalRunner.runCommand(`dotnet add ${(0, terminalRunner_1.quoteForShell)(project.path)} package ${(0, terminalRunner_1.quoteForShell)(packageId)}${versionArg}${sourceArg}${restoreArg}`);
                await this.postNotice(message.requestId, `${message.type === 'update' ? 'Update' : 'Install'} command sent to terminal.`);
                return;
            }
            if (message.type === 'remove') {
                const project = this.requireProject(message.projectPath);
                const packageId = requireText(message.packageId, 'Package id is required.');
                this.terminalRunner.runCommand(`dotnet remove ${(0, terminalRunner_1.quoteForShell)(project.path)} package ${(0, terminalRunner_1.quoteForShell)(packageId)}`);
                await this.postNotice(message.requestId, 'Remove command sent to terminal.');
                return;
            }
            if (message.type === 'list') {
                const project = this.requireProject(message.projectPath);
                this.terminalRunner.runCommand(`dotnet list ${(0, terminalRunner_1.quoteForShell)(project.path)} package --include-transitive`);
                await this.postNotice(message.requestId, 'List packages command sent to terminal.');
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            await this.postResponse(message.requestId, {
                error: errorMessage
            });
            vscode.window.showErrorMessage(`Solution Manager: ${errorMessage}`);
        }
    }
    async postState(requestId) {
        await this.postResponse(requestId, {
            projects: this.projects.map(toWebProject),
            sources: await this.getPackageSources()
        });
    }
    async postNotice(requestId, message) {
        await this.postResponse(requestId, {
            notice: message
        });
        vscode.window.setStatusBarMessage(`Solution Manager: ${message}`, 2500);
    }
    async postResponse(requestId, payload) {
        await this.panel?.webview.postMessage({
            type: 'response',
            requestId,
            ...payload
        });
    }
    requireProject(projectPath) {
        const project = this.projects.find((item) => normalizePath(item.path) === normalizePath(projectPath || ''));
        if (!project) {
            throw new Error('Selected project was not found.');
        }
        return project;
    }
    createHtml(webview) {
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
      $('sourceSelect').innerHTML = '<option value="">All sources</option>' + state.sources.map((source) =>
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
      document.querySelectorAll('#installedList [data-select-package]').forEach((row) => row.addEventListener('click', () => {
        const pkg = packages.find((item) => (item.id || item.name) === row.dataset.selectPackage);
        state.selectedPackage = pkg;
        state.selectedDetails = undefined;
        renderDetails();
        loadDetails(pkg.id || pkg.name, pkg.version || pkg.centralVersion);
      }));
      document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        runPackageAction('remove', button.dataset.remove);
      }));
      document.querySelectorAll('[data-list]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        request('list', { projectPath: state.selectedProjectPath });
      }));
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
        loadDetails(pkg.id, pkg.version, pkg.sourceUrl);
      }));
      document.querySelectorAll('[data-install]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        const pkg = state.searchResults.find((item) => item.id === button.dataset.install);
        runPackageAction(isInstalled(pkg.id) ? 'update' : 'install', pkg.id, pkg.version, pkg.sourceUrl);
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
      $('details').querySelector('#installSelectedButton').addEventListener('click', () => runPackageAction(isInstalled(pkg.id) ? 'update' : 'install', pkg.id, $('versionSelect').value, pkg.sourceUrl));
      $('details').querySelector('#versionSelect').addEventListener('change', (event) => loadDetails(pkg.id, event.target.value, pkg.sourceUrl));
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

    async function loadDetails(packageId, version, sourceUrl) {
      if (!packageId) return;
      await request('details', {
        packageId,
        version,
        prerelease: $('prereleaseInput').checked,
        sourceUrl: sourceUrl || $('sourceSelect').value || (state.sources[0] && state.sources[0].url)
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

    async function runPackageAction(type, packageId, version, sourceUrl) {
      if (!state.selectedProjectPath) return;
      setStatus(type + ' ' + packageId + '...');
      await request(type, {
        projectPath: state.selectedProjectPath,
        packageId,
        version,
        sourceUrl: sourceUrl || $('sourceSelect').value
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
    async getPackageSources() {
        return getPackageSources(this.projects, await this.listProtocolSources());
    }
    async listProtocolSources() {
        try {
            return (await this.protocolHost.listSources()).map((source) => ({
                name: String(source.Name || source.name || source.Url || source.url || ''),
                url: String(source.Url || source.url || ''),
                editable: false,
                origin: String(source.Origin || source.origin || 'nuget.config')
            })).filter((source) => source.name && source.url);
        }
        catch (error) {
            vscode.window.showWarningMessage(`Solution Manager: NuGet sources could not be loaded from nuget.config: ${getErrorMessage(error)}`);
            return [];
        }
    }
    async searchPackages(sourceUrl, query, prerelease) {
        const sources = sourceUrl
            ? [{ url: sourceUrl }]
            : (await this.getPackageSources()).map((source) => ({ url: source.url }));
        const results = await Promise.allSettled(sources.map(async (source) => {
            const packages = await this.protocolHost.search(source.url, query, prerelease, 0, 50);
            return packages.map((item) => mapProtocolPackage(item, source.url));
        }));
        const merged = new Map();
        const failures = [];
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
    async getPackageDetails(sourceUrl, packageId, version, prerelease) {
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
            licenseUrl: packageInfo.licenseUrl,
            projectUrl: packageInfo.projectUrl,
            tags: packageInfo.tags,
            versions: packageInfo.versions || [],
            dependencyGroups
        };
    }
    async tryApplyProjectFilePackageUpdate(project, packageId, version) {
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
            await (0, projectFileEditor_1.updateProjectItemReferences)(centralReference.path, [{
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
        await (0, projectFileEditor_1.updateProjectItemReferences)(project.path, [{
                action: 'add',
                elementName: 'PackageReference',
                include: packageId
            }]);
        await (0, projectFileEditor_1.updateProjectItemReferences)(centralManagement.path, [{
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
exports.NuGetManagerView = NuGetManagerView;
function getProjectsForNode(node, state) {
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
function mergeFreshProjectMetadata(projects, state) {
    const byPath = new Map(normalizeProjects(state?.projects || []).map((project) => [normalizePath(project.path), project]));
    return projects.map((project) => byPath.get(normalizePath(project.path)) || project);
}
function normalizeProjects(projects) {
    const seen = new Set();
    const result = [];
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
function toWebProject(project) {
    return {
        name: project.name || path.basename(project.path, path.extname(project.path)),
        path: project.path,
        relativePath: project.relativePath || project.path,
        packages: (project.metadata?.packageReferences || []).map((reference) => ({
            id: reference.name || reference.include,
            name: reference.name || reference.include,
            version: reference.version || reference.centralVersion || reference.resolvedVersion,
            centralVersion: reference.centralVersion,
            versionSource: reference.versionSource,
            canUpdate: canUpdatePackageReference(project, reference),
            updateBlockedReason: getPackageReferenceUpdateBlockedReason(reference)
        })).filter((reference) => reference.id)
    };
}
function getPackageSources(projects, protocolSources = []) {
    const sources = new Map();
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
    for (const source of protocolSources) {
        if (!source.url) {
            continue;
        }
        const key = source.url.toLowerCase();
        if (!sources.has(key)) {
            sources.set(key, source);
        }
    }
    if (!sources.has(NUGET_ORG_SOURCE.value.toLowerCase())) {
        sources.set(NUGET_ORG_SOURCE.value.toLowerCase(), {
            name: NUGET_ORG_SOURCE.key,
            url: NUGET_ORG_SOURCE.value,
            editable: true,
            origin: 'settings'
        });
    }
    return [...sources.values()];
}
function mapProtocolPackage(item, sourceUrl) {
    const id = String(item.Name || item.name || item.Id || item.id || '');
    const authors = item.Authors || item.authors || [];
    const tags = item.Tags || item.tags || [];
    const versions = item.Versions || item.versions || [];
    return {
        id,
        name: id,
        sourceUrl,
        version: String(item.Version || item.version || ''),
        description: String(item.Description || item.description || ''),
        authors: Array.isArray(authors) ? authors.join(', ') : String(authors || ''),
        totalDownloads: Number(item.TotalDownloads || item.totalDownloads || 0),
        versions: Array.isArray(versions)
            ? versions.map((version) => ({
                version: String(version.Version || version.version || ''),
                downloads: Number(version.Downloads || version.downloads || 0)
            })).filter((version) => version.version)
            : [],
        projectUrl: item.ProjectUrl || item.projectUrl,
        iconUrl: item.IconUrl || item.iconUrl,
        licenseUrl: item.LicenseUrl || item.licenseUrl,
        tags: Array.isArray(tags) ? tags.join(', ') : String(tags || '')
    };
}
function mapProtocolDependencyGroups(details) {
    const frameworks = details?.Dependencies?.Frameworks || details?.dependencies?.frameworks || {};
    return Object.entries(frameworks).map(([targetFramework, dependencies]) => ({
        targetFramework,
        dependencies: (Array.isArray(dependencies) ? dependencies : []).map((dependency) => ({
            id: String(dependency.Package || dependency.package || dependency.Id || dependency.id || ''),
            range: dependency.VersionRange || dependency.versionRange
        })).filter((dependency) => dependency.id)
    }));
}
function findPackageReference(project, packageId) {
    const normalized = normalizePackageId(packageId);
    return (project.metadata?.packageReferences || []).find((reference) => {
        return normalizePackageId(reference.name || reference.include || '') === normalized;
    });
}
function findCentralPackageVersion(project, packageId) {
    const normalized = normalizePackageId(packageId);
    return (project.metadata?.centralPackageVersions || []).find((reference) => {
        return normalizePackageId(reference.name || reference.include || '') === normalized;
    });
}
function isCentralPackageReference(reference) {
    return Boolean(reference && (reference.versionSource === 'Directory.Packages.props' ||
        reference.centralVersion ||
        reference.centralPackageVersion));
}
function canUpdatePackageReference(project, reference) {
    if (!isCentralPackageReference(reference)) {
        return true;
    }
    const centralReference = reference.centralPackageVersion || findCentralPackageVersion(project, reference.name || reference.include || '');
    return Boolean(centralReference?.path) && !hasReferenceCondition(reference) && !hasReferenceCondition(centralReference);
}
function getPackageReferenceUpdateBlockedReason(reference) {
    if (isCentralPackageReference(reference) && hasReferenceCondition(reference)) {
        return 'Conditional central package versions must be edited manually.';
    }
    return undefined;
}
function hasReferenceCondition(reference) {
    return Boolean(reference?.condition || reference?.itemCondition || reference?.groupCondition || reference?.versionSourceCondition);
}
function normalizePackageId(value) {
    return String(value || '').trim().toLowerCase();
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function readCentralPackageManagement(projectPath) {
    const propsPath = await findNearestCentralPackageProps(projectPath);
    if (!propsPath) {
        return { enabled: false };
    }
    const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(propsPath));
    const text = Buffer.from(buffer).toString('utf8');
    const enabled = /<ManagePackageVersionsCentrally\b[^>]*>\s*true\s*<\/ManagePackageVersionsCentrally>/i.test(text);
    return {
        enabled,
        path: propsPath
    };
}
async function findNearestCentralPackageProps(projectPath) {
    const projectUri = vscode.Uri.file(projectPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(projectUri);
    const stopDirectory = workspaceFolder?.uri.fsPath || path.parse(projectPath).root;
    let currentDirectory = path.dirname(projectPath);
    while (true) {
        const candidate = path.join(currentDirectory, 'Directory.Packages.props');
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
            if (stat.type === vscode.FileType.File) {
                return candidate;
            }
        }
        catch {
            // Keep walking toward the workspace root.
        }
        if (normalizePath(currentDirectory) === normalizePath(stopDirectory)) {
            break;
        }
        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            break;
        }
        currentDirectory = parentDirectory;
    }
    return undefined;
}
async function searchNuGetPackages(sourceUrl, query, prerelease) {
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
    const payload = await response.json();
    return (payload.data || []).map((item) => ({
        id: String(item.id || ''),
        version: String(item.version || ''),
        description: String(item.description || ''),
        authors: String(item.authors || ''),
        totalDownloads: Number(item.totalDownloads || 0),
        versions: Array.isArray(item.versions)
            ? item.versions.map((version) => ({
                version: String(version.version || ''),
                downloads: Number(version.downloads || 0)
            })).filter((version) => version.version)
            : [],
        projectUrl: item.projectUrl,
        iconUrl: item.iconUrl
    })).filter((item) => item.id);
}
async function getNuGetPackageDetails(sourceUrl, packageId, version) {
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
    const payload = await response.json();
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
function flattenRegistrationLeaves(payload) {
    const result = [];
    for (const page of payload.items || []) {
        if (Array.isArray(page.items)) {
            result.push(...page.items);
        }
    }
    if (Array.isArray(payload.items) && payload.items.some((item) => item.catalogEntry)) {
        result.push(...payload.items);
    }
    return result;
}
function readDependencyGroups(groups) {
    return (groups || []).map((group) => ({
        targetFramework: String(group.targetFramework || ''),
        dependencies: (group.dependencies || []).map((dependency) => ({
            id: String(dependency.id || ''),
            range: dependency.range ? String(dependency.range) : undefined
        })).filter((dependency) => dependency.id)
    }));
}
async function getSearchServiceUrl(sourceUrl) {
    return getServiceUrl(sourceUrl, 'searchqueryservice');
}
async function getServiceUrl(sourceUrl, serviceType) {
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
    const index = await response.json();
    const resource = (index.resources || []).find((item) => String(item['@type'] || '').toLowerCase().includes(serviceType));
    if (!resource?.['@id']) {
        throw new Error(`NuGet source does not expose a ${serviceType} endpoint.`);
    }
    return resource['@id'];
}
function getSettingsSources() {
    const configured = vscode.workspace.getConfiguration('solutionManager.nuget').get('sources') || [];
    const sources = [];
    for (const value of configured) {
        try {
            const source = JSON.parse(value);
            if (source.name && source.url) {
                sources.push({
                    name: source.name,
                    url: source.url,
                    editable: true,
                    origin: 'settings'
                });
            }
        }
        catch {
            continue;
        }
    }
    return sources;
}
async function upsertSettingsSource(previousUrl, name, url) {
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
async function removeSettingsSource(url) {
    const sources = getSettingsSources().filter((source) => source.url.toLowerCase() !== url.toLowerCase());
    await updateSettingsSources(sources);
}
async function updateSettingsSources(sources) {
    await vscode.workspace.getConfiguration('solutionManager.nuget').update('sources', sources.map((source) => JSON.stringify({ name: source.name, url: source.url })), vscode.ConfigurationTarget.Global);
}
function getSkipRestore() {
    return Boolean(vscode.workspace.getConfiguration('solutionManager.nuget').get('skipRestore'));
}
function normalizeSourceUrl(value) {
    const source = String(value || NUGET_ORG_SOURCE.value).trim();
    if (/^https?:\/\//i.test(source)) {
        return source;
    }
    throw new Error('Only HTTP(S) NuGet v3 sources can be searched from the manager.');
}
function normalizeSourceForDotnet(source) {
    try {
        const uri = vscode.Uri.parse(source);
        if (uri.scheme === 'file') {
            return uri.fsPath;
        }
    }
    catch {
        // Keep the original value if VS Code cannot parse it as a URI.
    }
    return source;
}
function requireText(value, message) {
    const text = String(value || '').trim();
    if (!text) {
        throw new Error(message);
    }
    return text;
}
function createNonce() {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index += 1) {
        value += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return value;
}
function normalizePath(value) {
    const resolved = path.resolve(value || '');
    return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}
const __test = {
    canUpdatePackageReference,
    getPackageSources,
    mapProtocolDependencyGroups,
    mapProtocolPackage
};
exports.__test = __test;
