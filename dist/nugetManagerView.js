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
const webviewUi_1 = require("#src/webviewUi");
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
    onDidChangeState;
    panel;
    projects = [];
    stateSubscription;
    protocolHost;
    constructor(context, terminalRunner, getState, refresh, onDidChangeState) {
        this.context = context;
        this.terminalRunner = terminalRunner;
        this.getState = getState;
        this.refresh = refresh;
        this.onDidChangeState = onDidChangeState;
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
                this.stateSubscription?.dispose();
                this.stateSubscription = undefined;
                this.panel = undefined;
            }, undefined, this.context.subscriptions);
            this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), undefined, this.context.subscriptions);
            if (this.onDidChangeState) {
                this.stateSubscription = this.onDidChangeState(() => { void this.repostPanelState(); });
            }
        }
        this.panel.title = 'NuGet Manager';
        this.panel.webview.html = this.createHtml(this.panel.webview);
        this.panel.reveal();
        await this.postState();
    }
    async syncPanelState(requestId) {
        await this.refresh({ userVisible: false });
        const state = await this.getState();
        this.projects = mergeFreshProjectMetadata(this.projects, state);
        await this.postState(requestId);
    }
    async repostPanelState() {
        if (!this.panel) {
            return;
        }
        const state = await this.getState();
        this.projects = mergeFreshProjectMetadata(this.projects, state);
        await this.postState();
    }
    async handleMessage(message) {
        try {
            if (message.type === 'ready' || message.type === 'refresh') {
                await this.syncPanelState(message.requestId);
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
                await upsertSource(message.type === 'updateSource' ? message.packageId : undefined, sourceName, sourceUrl);
                await this.postState(message.requestId);
                return;
            }
            if (message.type === 'openProject') {
                const project = this.requireProject(message.projectPath);
                await vscode.window.showTextDocument(vscode.Uri.file(project.path), { preview: true });
                await this.postNotice(message.requestId, `Opened ${project.name}.`);
                return;
            }
            if (message.type === 'removeSource') {
                const sourceUrl = requireText(message.sourceUrl, 'Source URL is required.');
                await removeSource(sourceUrl);
                await this.postState(message.requestId);
                return;
            }
            if (message.type === 'install' || message.type === 'update') {
                const packageId = (0, terminalRunner_1.assertValidPackageId)(requireText(message.packageId, 'Package id is required.'));
                const version = String(message.version || '').trim();
                if (version) {
                    (0, terminalRunner_1.assertValidPackageVersion)(version);
                }
                const projects = this.getActionProjects(message.projectPath, packageId, message.type, message.projectPaths);
                let updatedInProjectFiles = 0;
                let commandCount = 0;
                if (projects.length === 0) {
                    throw new Error('No projects were found for this package action.');
                }
                for (const project of projects) {
                    const didUpdateProjectFiles = await this.tryApplyProjectFilePackageUpdate(project, packageId, version);
                    if (didUpdateProjectFiles) {
                        updatedInProjectFiles += 1;
                        continue;
                    }
                    const versionArg = version ? ` --version ${(0, terminalRunner_1.quoteForShell)(version)}` : '';
                    const sourceArg = message.sourceUrl ? ` --source ${(0, terminalRunner_1.quoteForShell)(normalizeSourceForDotnet(message.sourceUrl))}` : '';
                    const restoreArg = getSkipRestore() ? ' --no-restore' : '';
                    this.terminalRunner.runCommand(`dotnet add ${(0, terminalRunner_1.quoteForShell)(project.path)} package ${(0, terminalRunner_1.quoteForShell)(packageId)}${versionArg}${sourceArg}${restoreArg}`, { onComplete: () => { void this.syncPanelState(); } });
                    commandCount += 1;
                }
                if (updatedInProjectFiles > 0) {
                    await this.syncPanelState(message.requestId);
                }
                const fileMessage = updatedInProjectFiles > 0 ? `${updatedInProjectFiles} project file update${updatedInProjectFiles === 1 ? '' : 's'}` : '';
                const terminalMessage = commandCount > 0 ? `${commandCount} terminal command${commandCount === 1 ? '' : 's'}` : '';
                await this.postNotice(message.requestId, `${message.type === 'update' ? 'Update' : 'Install'} applied to ${projects.length} project${projects.length === 1 ? '' : 's'}${fileMessage || terminalMessage ? ` (${[fileMessage, terminalMessage].filter(Boolean).join(', ')})` : ''}.`);
                return;
            }
            if (message.type === 'remove') {
                const packageId = (0, terminalRunner_1.assertValidPackageId)(requireText(message.packageId, 'Package id is required.'));
                const projects = this.getActionProjects(message.projectPath, packageId, message.type);
                if (projects.length === 0) {
                    throw new Error(`Package '${packageId}' is not installed in the selected scope.`);
                }
                let removedFromProjectFiles = 0;
                let terminalRemovals = 0;
                for (const project of projects) {
                    try {
                        await (0, projectFileEditor_1.updateProjectItemReferences)(project.path, [{
                                action: 'remove',
                                elementName: 'PackageReference',
                                include: packageId
                            }]);
                        removedFromProjectFiles += 1;
                    }
                    catch {
                        this.terminalRunner.runCommand(`dotnet remove ${(0, terminalRunner_1.quoteForShell)(project.path)} package ${(0, terminalRunner_1.quoteForShell)(packageId)}`, { onComplete: () => { void this.syncPanelState(); } });
                        terminalRemovals += 1;
                    }
                }
                if (removedFromProjectFiles > 0) {
                    await this.syncPanelState(message.requestId);
                }
                const removedMessage = removedFromProjectFiles > 0
                    ? `Removed '${packageId}' from ${removedFromProjectFiles} project file${removedFromProjectFiles === 1 ? '' : 's'}`
                    : '';
                const terminalMessage = terminalRemovals > 0
                    ? `${terminalRemovals} terminal command${terminalRemovals === 1 ? '' : 's'}`
                    : '';
                await this.postNotice(message.requestId, `${[removedMessage, terminalMessage].filter(Boolean).join(', ') || `Remove requested for ${projects.length} project${projects.length === 1 ? '' : 's'}`}.`);
                return;
            }
            if (message.type === 'clearCache') {
                this.terminalRunner.runCommand('dotnet nuget locals all --clear');
                await this.postNotice(message.requestId, 'Clear cache command sent (dotnet nuget locals all --clear).');
                return;
            }
            if (message.type === 'list') {
                const projects = this.getActionProjects(message.projectPath);
                if (projects.length === 0) {
                    throw new Error('No projects were found for package listing.');
                }
                for (const project of projects) {
                    this.terminalRunner.runCommand(`dotnet list ${(0, terminalRunner_1.quoteForShell)(project.path)} package --include-transitive`);
                }
                await this.postNotice(message.requestId, `List packages command sent for ${projects.length} project${projects.length === 1 ? '' : 's'}.`);
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
    getActionProjects(projectPath, packageId, action, projectPaths) {
        if (projectPaths?.length) {
            const projectsByPath = new Map(this.projects.map((project) => [normalizePath(project.path), project]));
            const normalizedPaths = [...new Set(projectPaths.filter(Boolean).map(normalizePath))];
            const projects = normalizedPaths.map((path) => projectsByPath.get(path));
            if (projects.some((project) => !project)) {
                throw new Error('One or more selected projects were not found.');
            }
            if (!packageId) {
                return projects;
            }
            if (action === 'install') {
                return projects.filter((project) => !hasInstalledPackage(project, packageId));
            }
            return projects.filter((project) => hasInstalledPackage(project, packageId));
        }
        if (projectPath) {
            return [this.requireProject(projectPath)];
        }
        if (!packageId) {
            return [...this.projects];
        }
        if (action === 'install') {
            return this.projects.filter((project) => !hasInstalledPackage(project, packageId));
        }
        return this.projects.filter((project) => hasInstalledPackage(project, packageId));
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
  <style nonce="${nonce}">
    ${(0, webviewUi_1.getWebviewUiStyles)()}
    :root {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    * {
      box-sizing: border-box;
    }
    html,
    body {
      height: 100%;
    }
    body {
      margin: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .nuget-shell {
      display: grid;
      grid-template-rows: 34px minmax(0, 1fr) 26px;
      height: 100vh;
      min-height: 0;
      background: var(--vscode-editor-background);
    }
    .main-tabs,
    .sub-tabs {
      display: flex;
      align-items: flex-end;
      gap: 18px;
      min-width: 0;
      padding: 0 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    .tab-button {
      height: 34px;
      padding: 0;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: 0;
      border-bottom: 1px solid transparent;
      font-weight: 700;
      cursor: pointer;
    }
    .tab-button.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    .tab-button:hover:not(.active) {
      color: var(--vscode-foreground);
    }
    .page {
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .page.hidden,
    .package-list.hidden,
    .browse-summary.hidden {
      display: none;
    }
    .packages-page {
      display: grid;
      grid-template-rows: 44px minmax(0, 1fr);
      height: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .package-toolbar {
      display: grid;
      grid-row: 1;
      grid-template-areas: "search refresh clear project source prerelease action";
      grid-template-columns: minmax(260px, 1fr) 28px 28px minmax(132px, 200px) minmax(132px, 200px) max-content 80px;
      gap: 8px;
      align-items: center;
      padding: 8px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    #projectSelect {
      grid-area: project;
      width: 100%;
      min-width: 0;
    }
    #sourceSelect {
      grid-area: source;
      width: 100%;
      min-width: 0;
    }
    #refreshButton {
      grid-area: refresh;
    }
    #clearCacheButton {
      grid-area: clear;
    }
    #prereleaseInput {
      flex: 0 0 auto;
    }
    .package-toolbar .checkbox-row {
      grid-area: prerelease;
    }
    #searchButton {
      grid-area: action;
      min-width: 80px;
    }
    .search-box {
      display: grid;
      grid-area: search;
      grid-template-columns: 24px 1fr;
      align-items: center;
      height: 28px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
    }
    .search-icon {
      display: flex;
      position: relative;
      align-items: center;
      justify-content: center;
      color: var(--vscode-descriptionForeground);
    }
    .search-icon::before {
      content: "";
      box-sizing: border-box;
      width: 10px;
      height: 10px;
      border: 1.5px solid currentColor;
      border-radius: 50%;
      transform: translate(-1px, -1px);
    }
    .search-icon::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 5px;
      height: 1.5px;
      border-radius: 1px;
      background: currentColor;
      transform: translate(1px, 1px) rotate(45deg);
      transform-origin: left center;
    }
    .browse-summary {
      min-width: 0;
      margin-left: auto;
      overflow: hidden;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .content-split {
      display: grid;
      grid-row: 2;
      grid-template-columns: minmax(240px, 49%) 8px minmax(240px, 1fr);
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .packages-page.installed-mode {
      grid-template-rows: 44px minmax(0, 1fr);
    }
    .packages-page.installed-mode .content-split {
      grid-row: 2;
    }
    .list-pane {
      display: grid;
      grid-template-rows: 34px 1fr;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .splitter {
      position: relative;
      z-index: 2;
      width: 8px;
      min-width: 8px;
      cursor: col-resize;
      background: linear-gradient(
        90deg,
        transparent 0,
        transparent 3px,
        var(--vscode-panel-border) 3px,
        var(--vscode-panel-border) 4px,
        transparent 4px
      );
    }
    .splitter:hover,
    .splitter.dragging {
      background: linear-gradient(
        90deg,
        transparent 0,
        transparent 3px,
        var(--vscode-focusBorder) 3px,
        var(--vscode-focusBorder) 5px,
        transparent 5px
      );
    }
    body.resizing,
    body.resizing * {
      cursor: col-resize !important;
      user-select: none;
    }
    .details-pane {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      background: var(--vscode-editor-background);
    }
    .sources-page {
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 0;
      padding: 14px;
      gap: 12px;
    }
    .source-editor {
      display: grid;
      grid-template-columns: minmax(180px, 260px) minmax(260px, 1fr) max-content;
      gap: 8px;
      align-items: center;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .source-editor.editing {
      padding: 10px;
      border: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
    }
    .source-editor-header {
      display: flex;
      grid-column: 1 / -1;
      gap: 8px;
      align-items: center;
      min-width: 0;
      color: var(--vscode-foreground);
      font-weight: 700;
    }
    .source-editor-mode {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .source-editor-mode.hidden,
    .source-editor-actions .hidden {
      display: none;
    }
    .source-editor-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
    }
    .source-list {
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .toolbar-inline {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    select, input, button {
      height: var(--ui-control-height);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: var(--ui-radius);
      font: inherit;
    }
    input[type="text"], input:not([type]) {
      min-width: 0;
      padding: 0 8px;
    }
    .search-box input {
      width: 100%;
      border: 0;
      background: transparent;
      outline: 0;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-border, transparent);
      border-radius: var(--ui-radius);
      padding: 0 10px;
      cursor: pointer;
    }
    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      padding: 0;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border-color: transparent;
    }
    .icon-button:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled {
      opacity: .45;
      cursor: default;
    }
    .checkbox-row {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .checkbox-row input {
      width: 18px;
      height: 18px;
      accent-color: var(--vscode-focusBorder);
    }
    .list {
      display: flex;
      flex-direction: column;
    }
    .row {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) max-content;
      gap: 7px;
      align-items: center;
      min-height: 36px;
      padding: 5px 8px 5px 16px;
      border-radius: var(--ui-radius);
      cursor: default;
    }
    .source-list .source-row {
      grid-template-columns: minmax(0, 1fr) max-content;
      gap: 12px;
      min-height: 58px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .source-list .source-row > div:first-child {
      min-width: 0;
    }
    .source-list .source-row .actions {
      grid-column: 2;
      flex-wrap: nowrap;
    }
    .row:hover,
    .row:focus-visible,
    .project-install-row:hover,
    .project-install-row:focus-visible {
      border-radius: var(--ui-radius);
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .row.active {
      border-radius: var(--ui-radius);
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .row:focus-visible,
    .project-install-row:focus-visible {
      position: relative;
      z-index: 1;
    }
    .package-list {
      height: 100%;
      min-height: 0;
      overflow: auto;
      padding: 8px 6px 0;
    }
    .package-list .package-row:hover,
    .package-list .package-row.active,
    .package-list .package-row:focus-visible {
      border-radius: var(--ui-radius);
    }
    .package-list .package-row {
      grid-template-columns: 22px minmax(0, 1fr) max-content;
      align-items: start;
      min-height: 64px;
      padding: 8px 10px 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .package-list .package-row .pkg-icon {
      margin-top: 3px;
    }
    .package-text {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .package-title-line {
      display: flex;
      gap: 4px;
      align-items: baseline;
      min-width: 0;
      overflow: hidden;
      line-height: 18px;
      white-space: nowrap;
    }
    .package-author {
      min-width: 0;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .package-list .package-row .meta,
    .package-list .package-row .desc {
      display: block;
      min-width: 0;
      margin-top: 0;
      line-height: 17px;
    }
    .package-list .package-row .desc {
      max-height: 17px;
    }
    .package-list .package-row .version-chip,
    .package-list .package-row .row-actions {
      align-self: start;
      margin-top: 2px;
    }
    .pkg-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 2px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 7px;
      font-weight: 800;
      line-height: 1;
    }
    .title {
      font-weight: 600;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .version-chip {
      color: var(--vscode-descriptionForeground);
      font-weight: 700;
      white-space: nowrap;
    }
    .meta,
    .desc {
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-actions {
      display: none;
      gap: 5px;
      justify-content: flex-end;
      grid-column: 3;
    }
    .row:hover .version-chip {
      display: none;
    }
    .row:focus-within .version-chip {
      display: none;
    }
    .row:hover .row-actions {
      display: flex;
    }
    .row:focus-within .row-actions {
      display: flex;
    }
    .actions {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
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
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      padding: 16px;
    }
    .details-label {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .details-actions {
      justify-content: flex-start;
      padding: 0 16px 14px;
    }
    .project-install-list {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 0 16px 16px;
    }
    .project-install-row {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) minmax(120px, max-content) max-content;
      gap: 12px;
      align-items: center;
      min-height: 34px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      border-radius: var(--ui-radius);
      color: inherit;
      background: transparent;
      cursor: pointer;
    }
    .project-install-row .pkg-icon {
      width: 16px;
      height: 16px;
      font-size: 7px;
    }
    .project-install-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .project-install-version {
      color: var(--vscode-descriptionForeground);
      font-weight: 700;
      white-space: nowrap;
    }
    .project-install-actions {
      display: flex;
      gap: 4px;
      justify-content: flex-end;
      min-width: 56px;
    }
    .project-action-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border-color: transparent;
      font-size: 15px;
      line-height: 1;
    }
    .project-action-button:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .project-action-button:disabled {
      opacity: .35;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent);
    }
    .modal-backdrop.hidden {
      display: none;
    }
    .project-selection-modal {
      display: grid;
      grid-template-rows: auto auto minmax(180px, 1fr) auto;
      width: min(760px, 94vw);
      max-height: min(720px, 88vh);
      min-height: 360px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      box-shadow: 0 16px 48px var(--vscode-widget-shadow, transparent);
      overflow: hidden;
    }
    .project-selection-header,
    .project-selection-footer {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .project-selection-footer {
      justify-content: space-between;
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 0;
    }
    .project-selection-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
    }
    .project-selection-close {
      margin-left: auto;
    }
    .project-selection-toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
    }
    .project-selection-list {
      min-height: 0;
      overflow: auto;
    }
    .project-choice {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      min-height: 44px;
      padding: 7px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      border-radius: var(--ui-radius);
      cursor: pointer;
    }
    .project-choice:hover,
    .project-choice:focus-within,
    .project-choice[aria-selected="true"] {
      border-radius: var(--ui-radius);
      background: var(--vscode-list-hoverBackground);
    }
    .project-choice input {
      width: 18px;
      height: 18px;
      accent-color: var(--vscode-focusBorder);
    }
    .project-choice-name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .project-choice .meta {
      display: block;
    }
    .project-selection-summary {
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .dependencies {
      padding: 0 16px 14px;
    }
    .dependencies ul {
      margin: 4px 0 8px 18px;
      padding: 0;
    }
    @media (max-width: 920px) {
      .package-toolbar {
        grid-template-areas:
          "search search refresh clear"
          "project source prerelease action";
        grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr) max-content 80px;
        grid-template-rows: repeat(2, var(--ui-control-height));
      }
      .packages-page {
        grid-template-rows: auto minmax(480px, 1fr);
        overflow-y: auto;
      }
      .packages-page.installed-mode {
        grid-template-rows: auto minmax(0, 1fr);
      }
      .content-split {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(240px, 1fr) minmax(240px, 1fr);
        min-height: 480px;
        overflow: visible;
      }
      .splitter {
        display: none;
      }
      .list-pane {
        border-right: 0;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
    }
    @media (max-width: 640px) {
      .package-toolbar {
        grid-template-areas:
          "search search refresh clear"
          "project project project project"
          "source source prerelease action";
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) max-content 80px;
      }
      .source-editor {
        grid-template-columns: minmax(0, 1fr);
      }
      .source-editor-actions {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="nuget-shell">
    <nav class="main-tabs" aria-label="NuGet sections">
      <button id="packagesTabButton" class="tab-button active" type="button">Packages</button>
      <button id="sourcesTabButton" class="tab-button" type="button">Sources</button>
    </nav>
    <section id="packagesView" class="page packages-page">
      <div class="package-toolbar">
        <div class="search-box">
          <span class="search-icon" aria-hidden="true"></span>
          <input id="queryInput" placeholder="Search NuGet packages" />
        </div>
        <button id="refreshButton" class="icon-button" title="Refresh" aria-label="Refresh">${(0, webviewUi_1.getWebviewIcon)('refresh')}</button>
        <button id="clearCacheButton" class="icon-button" title="Clear NuGet caches (dotnet nuget locals all --clear)" aria-label="Clear NuGet cache">${(0, webviewUi_1.getWebviewIcon)('trash')}</button>
        <select id="projectSelect" title="Project"></select>
        <select id="sourceSelect" title="Package source"></select>
        <label class="checkbox-row"><input id="prereleaseInput" type="checkbox" /> Prerelease</label>
        <button id="searchButton">Search</button>
      </div>
      <div id="contentSplit" class="content-split">
        <section class="list-pane">
          <div class="sub-tabs" aria-label="Package list mode">
            <button id="browseTabButton" class="tab-button active" type="button">Browse</button>
            <button id="installedTabButton" class="tab-button" type="button">Installed</button>
            <span id="browseSummary" class="browse-summary">Available Packages: Top 100</span>
          </div>
          <div id="searchResults" class="list package-list"></div>
          <div id="installedList" class="list package-list hidden"></div>
        </section>
        <div id="splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="Resize package details panel" title="Resize package details panel"></div>
        <section class="details-pane">
          <div class="section-title">Details</div>
          <div id="details" class="empty">Select a package to view details.</div>
        </section>
      </div>
    </section>
    <section id="sourcesView" class="page sources-page hidden">
      <div id="sourceEditor" class="source-editor">
        <div class="source-editor-header">
          <span id="sourceEditorTitle">Add Package Source</span>
          <span id="sourceEditorMode" class="source-editor-mode hidden"></span>
        </div>
        <input id="sourceNameInput" placeholder="Source name" />
        <input id="sourceUrlInput" placeholder="https://api.nuget.org/v3/index.json" />
        <div class="source-editor-actions">
          <button id="saveSourceButton">Add</button>
          <button id="cancelSourceButton" class="secondary hidden">Cancel</button>
        </div>
      </div>
      <div id="sourcesList" class="list source-list"></div>
    </section>
    <div id="status" class="status">Ready</div>
  </div>
  <div id="projectSelectionModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="projectSelectionTitle">
    <section class="project-selection-modal">
      <div class="project-selection-header">
        <div id="projectSelectionTitle" class="project-selection-title">Select projects</div>
        <button id="projectSelectionClose" class="icon-button project-selection-close" type="button" title="Close" aria-label="Close">${(0, webviewUi_1.getWebviewIcon)('close')}</button>
      </div>
      <div class="project-selection-toolbar">
        <button id="projectSelectionSelectAll" class="secondary" type="button">Select all</button>
        <button id="projectSelectionClear" class="secondary" type="button">Clear</button>
        <span id="projectSelectionSummary" class="project-selection-summary"></span>
      </div>
      <div id="projectSelectionList" class="project-selection-list"></div>
      <div class="project-selection-footer">
        <span id="projectSelectionHint" class="project-selection-summary"></span>
        <div class="actions">
          <button id="projectSelectionCancel" class="secondary" type="button">Cancel</button>
          <button id="projectSelectionInstall" type="button">Install</button>
        </div>
      </div>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = {
      projects: [],
      sources: [],
      selectedProjectPath: '',
      selectedPackage: undefined,
      selectedDetails: undefined,
      editingSourceUrl: '',
      activeMainTab: 'packages',
      activePackageTab: 'browse',
      lastBrowseRequestKey: '',
      searchResults: [],
      latestRequest: { search: '', details: '' }
    };
    let nextRequestId = 1;
    const pending = new Map();
    let projectSelectionResolve;
    const $ = (id) => document.getElementById(id);

    function request(type, payload = {}, channel) {
      const requestId = String(nextRequestId++);
      if (channel) {
        state.latestRequest[channel] = requestId;
      }
      vscode.postMessage({ type, requestId, ...payload });
      return new Promise((resolve) => pending.set(requestId, resolve));
    }

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type !== 'response') return;
      if (message.projects) {
        state.projects = message.projects;
        state.sources = message.sources || [];
        if (state.selectedProjectPath && !state.projects.some((project) => project.path === state.selectedProjectPath)) {
          state.selectedProjectPath = '';
        }
        render();
        loadTopPackagesIfNeeded();
      }
      if (message.packages && message.requestId === state.latestRequest.search) {
        state.searchResults = message.packages;
        renderSearchResults();
      }
      if (message.details && message.requestId === state.latestRequest.details) {
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
    $('clearCacheButton').addEventListener('click', async () => {
      setStatus('Clearing cache...');
      const response = await request('clearCache');
      setStatus(response && response.error ? response.error : 'Clear cache command sent');
    });
    $('projectSelect').addEventListener('change', (event) => {
      state.selectedProjectPath = event.target.value;
      renderInstalled();
    });
    $('sourceSelect').addEventListener('change', () => loadBrowsePackages());
    $('prereleaseInput').addEventListener('change', () => loadBrowsePackages());
    $('packagesTabButton').addEventListener('click', () => setMainTab('packages'));
    $('sourcesTabButton').addEventListener('click', () => setMainTab('sources'));
    $('browseTabButton').addEventListener('click', () => {
      setPackageTab('browse');
      loadTopPackagesIfNeeded();
    });
    $('installedTabButton').addEventListener('click', () => setPackageTab('installed'));
    $('searchButton').addEventListener('click', search);
    $('saveSourceButton').addEventListener('click', saveSource);
    $('cancelSourceButton').addEventListener('click', resetSourceEditor);
    $('queryInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') search();
    });
    $('projectSelectionCancel').addEventListener('click', () => closeProjectSelectionModal([]));
    $('projectSelectionClose').addEventListener('click', () => closeProjectSelectionModal([]));
    $('projectSelectionInstall').addEventListener('click', () => closeProjectSelectionModal(selectedProjectPathsFromModal()));
    $('projectSelectionSelectAll').addEventListener('click', () => setProjectSelectionChecked(true));
    $('projectSelectionClear').addEventListener('click', () => setProjectSelectionChecked(false));
    $('projectSelectionModal').addEventListener('click', (event) => {
      if (event.target === $('projectSelectionModal')) closeProjectSelectionModal([]);
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('projectSelectionModal').classList.contains('hidden')) {
        closeProjectSelectionModal([]);
      }
    });
    initializeSplitter();

    async function search() {
      state.lastBrowseRequestKey = '';
      await loadBrowsePackages();
    }

    async function loadBrowsePackages() {
      setPackageTab('browse');
      setStatus('Searching...');
      const response = await request('search', {
        query: $('queryInput').value,
        prerelease: $('prereleaseInput').checked,
        sourceUrl: $('sourceSelect').value
      }, 'search');

      if (response.requestId !== state.latestRequest.search || response.error) {
        return;
      }

      setStatus('Search complete');
    }

    function loadTopPackagesIfNeeded() {
      if (state.activeMainTab !== 'packages' || state.activePackageTab !== 'browse') return;
      if ($('queryInput').value.trim()) return;

      const key = [
        $('sourceSelect').value || state.sources.map((source) => source.url).join('|'),
        $('prereleaseInput').checked ? 'pre' : 'stable'
      ].join('::');

      if (state.lastBrowseRequestKey === key) return;
      state.lastBrowseRequestKey = key;
      loadBrowsePackages();
    }

    function render() {
      $('projectSelect').innerHTML = '<option value=""' + (!state.selectedProjectPath ? ' selected' : '') + '>All Solution</option>' + state.projects.map((project) =>
        '<option value="' + escapeAttribute(project.path) + '"' + (project.path === state.selectedProjectPath ? ' selected' : '') + '>' + escapeHtml(project.name) + '</option>'
      ).join('');
      $('sourceSelect').innerHTML = '<option value="">All Source</option>' + state.sources.map((source) =>
        '<option value="' + escapeAttribute(source.url) + '">' + escapeHtml(source.name) + '</option>'
      ).join('');
      renderTabs();
      renderInstalled();
      renderSources();
      renderSearchResults();
    }

    function renderTabs() {
      $('packagesView').classList.toggle('hidden', state.activeMainTab !== 'packages');
      $('packagesView').classList.toggle('installed-mode', state.activePackageTab === 'installed');
      $('sourcesView').classList.toggle('hidden', state.activeMainTab !== 'sources');
      $('packagesTabButton').classList.toggle('active', state.activeMainTab === 'packages');
      $('sourcesTabButton').classList.toggle('active', state.activeMainTab === 'sources');
      $('browseSummary').classList.toggle('hidden', state.activePackageTab !== 'browse');
      $('searchResults').classList.toggle('hidden', state.activePackageTab !== 'browse');
      $('installedList').classList.toggle('hidden', state.activePackageTab !== 'installed');
      $('browseTabButton').classList.toggle('active', state.activePackageTab === 'browse');
      $('installedTabButton').classList.toggle('active', state.activePackageTab === 'installed');
    }

    function setMainTab(tab) {
      state.activeMainTab = tab;
      renderTabs();
    }

    function setPackageTab(tab) {
      state.activePackageTab = tab;
      renderTabs();
    }

    function renderInstalled() {
      const packages = installedPackages();
      $('installedList').innerHTML = packages.length ? packages.map((pkg) => packageRow(pkg, true)).join('') : '<div class="empty">No PackageReference items found.</div>';
      document.querySelectorAll('#installedList [data-select-package]').forEach((row) => {
        const selectPackage = () => {
          const pkg = packages.find((item) => (item.id || item.name) === row.dataset.selectPackage);
          state.selectedPackage = pkg;
          state.selectedDetails = { installedOnly: true };
          setActivePackageRow('installedList', row);
          renderDetails();
        };
        row.addEventListener('click', selectPackage);
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          selectPackage();
        });
      });
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
        return '<div class="row source-row"><div><div class="title">' + escapeHtml(source.name) + badge + '</div><div class="meta">' + escapeHtml(source.url) + '</div></div><div class="actions">' + actions + '</div></div>';
      }).join('') : '<div class="empty">No package sources found.</div>';
      document.querySelectorAll('[data-edit-source]').forEach((button) => button.addEventListener('click', () => editSource(button.dataset.editSource)));
      document.querySelectorAll('[data-remove-source]').forEach((button) => button.addEventListener('click', () => removeSource(button.dataset.removeSource)));
    }

    function setActivePackageRow(listId, activeRow) {
      document.querySelectorAll('#' + listId + ' [data-select-package]').forEach((row) => {
        row.classList.toggle('active', row === activeRow);
      });
    }

    function renderSearchResults() {
      $('searchResults').innerHTML = state.searchResults.length ? state.searchResults.map((pkg) => packageRow(pkg, false)).join('') : '<div class="empty">Search for packages to install.</div>';
      document.querySelectorAll('#searchResults [data-select-package]').forEach((row) => {
        const selectPackage = () => {
          const pkg = state.searchResults.find((item) => item.id === row.dataset.selectPackage);
          state.selectedPackage = pkg;
          state.selectedDetails = undefined;
          setActivePackageRow('searchResults', row);
          renderDetails();
          loadDetails(pkg.id, pkg.version, pkg.sourceUrl);
        };
        row.addEventListener('click', selectPackage);
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          selectPackage();
        });
      });
      document.querySelectorAll('[data-install]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!button.dataset.packageAction) return;
        const pkg = state.searchResults.find((item) => item.id === button.dataset.install);
        runPackageAction(button.dataset.packageAction, pkg.id, pkg.version, pkg.sourceUrl);
      }));
      renderDetails();
    }

    function renderDetails() {
      const pkg = state.selectedPackage;
      if (!pkg) {
        $('details').innerHTML = '<div class="empty">Select a package to view details.</div>';
        return;
      }
      if (state.selectedDetails && state.selectedDetails.installedOnly) {
        renderInstalledPackageDetails(pkg);
        return;
      }
      const details = state.selectedDetails;
      const versions = details && details.versions && details.versions.length ? details.versions : (pkg.versions || [{ version: pkg.version }]);
      const selectedVersion = details ? details.version : pkg.version;
      const dependencyHtml = details ? renderDependencies(details.dependencyGroups || []) : '<div class="empty">Loading package details...</div>';
      const packageId = pkg.id || pkg.name;
      const projectHtml = renderPackageProjectSection(packageId, selectedVersion, pkg.sourceUrl);
      const actionState = packageActionState(packageId, selectedVersion);
      $('details').innerHTML =
        '<div class="details-grid">' +
        '<div class="details-label">Package</div><div><strong>' + escapeHtml(packageId) + '</strong></div>' +
        '<div class="details-label">Version</div><div><select id="versionSelect">' + versions.map((item) => '<option value="' + escapeAttribute(item.version) + '"' + (item.version === selectedVersion ? ' selected' : '') + '>' + escapeHtml(item.version) + '</option>').join('') + '</select></div>' +
        '<div class="details-label">Authors</div><div>' + escapeHtml((details && details.authors) || pkg.authors || '') + '</div>' +
        '<div class="details-label">Downloads</div><div>' + String(pkg.totalDownloads || 0) + '</div>' +
        '<div class="details-label">Description</div><div>' + escapeHtml((details && details.description) || pkg.description || 'No description.') + '</div>' +
        '</div>' +
        '<div class="actions" style="justify-content:flex-start;padding:0 8px 8px"><button id="installSelectedButton"' + (actionState.disabled ? ' disabled' : '') + ' data-package-action="' + escapeAttribute(actionState.type || '') + '">' + escapeHtml(actionState.label) + '</button></div>' +
        projectHtml +
        '<div class="section-title">Dependencies</div>' +
        dependencyHtml;
      $('details').querySelector('#installSelectedButton').addEventListener('click', () => {
        const action = $('details').querySelector('#installSelectedButton').dataset.packageAction;
        if (!action) return;
        runPackageAction(action, packageId, $('versionSelect').value, pkg.sourceUrl);
      });
      $('details').querySelector('#versionSelect').addEventListener('change', (event) => loadDetails(packageId, event.target.value, pkg.sourceUrl));
      wireProjectInstallRows();
    }

    function renderInstalledPackageDetails(pkg) {
      const projects = pkg.installedProjects || [];
      const versionText = pkg.version || pkg.centralVersion || (pkg.projectCount ? 'multiple' : '');
      $('details').innerHTML =
        '<div class="details-grid">' +
        '<div class="details-label">Package</div><div><strong>' + escapeHtml(pkg.id || pkg.name) + '</strong></div>' +
        '<div class="details-label">Version</div><div>' + escapeHtml(versionText || 'unspecified') + '</div>' +
        '<div class="details-label">Installed in</div><div>' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + '</div>' +
        '</div>' +
        renderPackageProjectSection(pkg.id || pkg.name, versionText, pkg.sourceUrl);
      wireProjectInstallRows();
    }

    function renderPackageProjectSection(packageId, targetVersion, sourceUrl) {
      const projects = installedProjectsForPackage(packageId);
      return '<div class="section-title">Installed Projects</div>' +
        '<div class="project-install-list">' +
        (projects.length ? projects.map((project) => renderPackageProjectRow(project, packageId, targetVersion, sourceUrl)).join('') : '<div class="empty">This package is not installed in the selected scope.</div>') +
        '</div>';
    }

    function renderPackageProjectRow(project, packageId, targetVersion, sourceUrl) {
      const updateAvailable = isPackageVersionNewer(targetVersion, project.version);
      const updateTitle = updateAvailable
        ? 'Upgrade ' + packageId + ' to ' + targetVersion + ' in ' + project.name
        : '';
      const removeTitle = 'Remove ' + packageId + (project.version ? ' ' + project.version : '') + ' from ' + project.name;
      const updateButton = updateAvailable
        ? '<button class="project-action-button" ' + (project.canUpdate === false ? 'disabled ' : '') + 'data-update-project="' + escapeAttribute(project.path) + '" data-update-package="' + escapeAttribute(packageId) + '" data-update-version="' + escapeAttribute(targetVersion) + '" data-update-source="' + escapeAttribute(sourceUrl || '') + '" title="' + escapeAttribute(project.canUpdate === false ? (project.updateBlockedReason || 'This package reference must be updated manually.') : updateTitle) + '" aria-label="' + escapeAttribute(project.canUpdate === false ? (project.updateBlockedReason || updateTitle) : updateTitle) + '">${(0, webviewUi_1.getWebviewIcon)('upgrade')}</button>'
        : '';
      const removeButton = '<button class="project-action-button" data-remove-project="' + escapeAttribute(project.path) + '" data-remove-package="' + escapeAttribute(packageId) + '" title="' + escapeAttribute(removeTitle) + '" aria-label="' + escapeAttribute(removeTitle) + '">${(0, webviewUi_1.getWebviewIcon)('remove')}</button>';

      return '<div class="project-install-row" role="button" tabindex="0" data-open-project="' + escapeAttribute(project.path) + '" title="' + escapeAttribute('Open ' + project.name) + '">' +
        '<span class="pkg-icon">C#</span>' +
        '<div><div class="project-install-name">' + escapeHtml(project.name) + '</div><div class="meta">' + escapeHtml(project.relativePath || project.path || '') + '</div></div>' +
        '<div class="project-install-version">' + escapeHtml(project.version || 'unspecified') + '</div>' +
        '<div class="project-install-actions">' + updateButton + removeButton + '</div>' +
        '</div>';
    }

    function wireProjectInstallRows() {
      document.querySelectorAll('[data-open-project]').forEach((row) => {
        const openProject = () => request('openProject', { projectPath: row.dataset.openProject });
        row.addEventListener('click', (event) => {
          if (event.target && event.target.closest && event.target.closest('button')) return;
          openProject();
        });
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          openProject();
        });
      });
      document.querySelectorAll('[data-update-project]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        runPackageAction('update', button.dataset.updatePackage, button.dataset.updateVersion, button.dataset.updateSource, button.dataset.updateProject);
      }));
      document.querySelectorAll('[data-remove-project]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        runPackageAction('remove', button.dataset.removePackage, undefined, undefined, button.dataset.removeProject);
      }));
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

    function initializeSplitter() {
      const split = $('contentSplit');
      const splitter = $('splitter');
      if (!split || !splitter) return;

      const minLeft = 280;
      const minRight = 340;
      const splitterWidth = 8;

      function applyWidth(clientX) {
        const bounds = split.getBoundingClientRect();
        if (!bounds.width) return;
        const maxLeft = Math.max(minLeft, bounds.width - minRight - splitterWidth);
        const nextLeft = Math.min(Math.max(clientX - bounds.left, minLeft), maxLeft);
        split.style.gridTemplateColumns = nextLeft + 'px ' + splitterWidth + 'px minmax(' + minRight + 'px, 1fr)';
      }

      splitter.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        splitter.classList.add('dragging');
        document.body.classList.add('resizing');
        splitter.setPointerCapture(event.pointerId);
        applyWidth(event.clientX);
      });

      splitter.addEventListener('pointermove', (event) => {
        if (!splitter.classList.contains('dragging')) return;
        applyWidth(event.clientX);
      });

      function stopResize(event) {
        splitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        if (event && splitter.hasPointerCapture(event.pointerId)) {
          splitter.releasePointerCapture(event.pointerId);
        }
      }

      splitter.addEventListener('pointerup', stopResize);
      splitter.addEventListener('pointercancel', stopResize);
      splitter.addEventListener('dblclick', () => {
        split.style.gridTemplateColumns = '';
      });
    }

    function packageActionState(packageId, targetVersion) {
      if (installCandidateProjects(packageId).length > 0) {
        return { type: 'install', label: 'Install', disabled: false };
      }

      if (updateCandidateProjects(packageId, targetVersion).length > 0) {
        return { type: 'update', label: 'Update', disabled: false };
      }

      if (isInstalled(packageId)) {
        return { type: '', label: 'Up to date', disabled: true };
      }

      return { type: 'install', label: 'Install', disabled: false };
    }

    function installCandidateProjects(packageId) {
      const normalized = String(packageId || '').toLowerCase();
      return scopedProjects()
        .filter((project) => !(project.packages || []).some((pkg) => String(pkg.id || pkg.name || '').toLowerCase() === normalized))
        .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' }));
    }

    function updateCandidateProjects(packageId, targetVersion) {
      const normalized = String(packageId || '').toLowerCase();
      return scopedProjects()
        .filter((project) => {
          const pkg = findProjectPackage(project, normalized);
          if (!pkg || pkg.canUpdate === false) return false;
          const installedVersion = pkg.version || pkg.centralVersion || pkg.resolvedVersion || '';
          return isPackageVersionNewer(targetVersion, installedVersion);
        })
        .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' }));
    }

    function showProjectSelectionModal(packageId, version, projects) {
      $('projectSelectionTitle').textContent = 'Install ' + packageId;
      $('projectSelectionHint').textContent = version ? 'Version ' + version : '';
      $('projectSelectionList').innerHTML = projects.map((project) =>
        '<label class="project-choice">' +
        '<input type="checkbox" data-project-choice value="' + escapeAttribute(project.path) + '" checked />' +
        '<span><span class="project-choice-name">' + escapeHtml(project.name) + '</span><span class="meta">' + escapeHtml(project.relativePath || project.path || '') + '</span></span>' +
        '</label>'
      ).join('');
      document.querySelectorAll('[data-project-choice]').forEach((checkbox) => checkbox.addEventListener('change', updateProjectSelectionSummary));
      updateProjectSelectionSummary();
      $('projectSelectionModal').classList.remove('hidden');
      $('projectSelectionInstall').focus();

      return new Promise((resolve) => {
        projectSelectionResolve = resolve;
      });
    }

    function selectedProjectPathsFromModal() {
      return Array.from(document.querySelectorAll('[data-project-choice]:checked')).map((input) => input.value);
    }

    function setProjectSelectionChecked(value) {
      document.querySelectorAll('[data-project-choice]').forEach((checkbox) => {
        checkbox.checked = value;
      });
      updateProjectSelectionSummary();
    }

    function updateProjectSelectionSummary() {
      const total = document.querySelectorAll('[data-project-choice]').length;
      const selected = selectedProjectPathsFromModal().length;
      $('projectSelectionSummary').textContent = selected + ' of ' + total + ' projects selected';
      $('projectSelectionInstall').disabled = selected === 0;
    }

    function closeProjectSelectionModal(projectPaths) {
      $('projectSelectionModal').classList.add('hidden');
      const resolve = projectSelectionResolve;
      projectSelectionResolve = undefined;

      if (resolve) {
        resolve(projectPaths);
      }
    }

    async function loadDetails(packageId, version, sourceUrl) {
      if (!packageId) return;
      await request('details', {
        packageId,
        version,
        prerelease: $('prereleaseInput').checked,
        sourceUrl: sourceUrl || $('sourceSelect').value || (state.sources[0] && state.sources[0].url)
      }, 'details');
    }

    function packageRow(pkg, installed) {
      const id = pkg.id || pkg.name;
      const version = pkg.version || pkg.centralVersion || '';
      const isActive = state.selectedPackage && String(state.selectedPackage.id || state.selectedPackage.name || '').toLowerCase() === String(id || '').toLowerCase();
      const projectMeta = installed && pkg.projectCount ? ' · ' + pkg.projectCount + ' project' + (pkg.projectCount === 1 ? '' : 's') : '';
      const author = pkg.authors ? '<span class="package-author">@' + escapeHtml(pkg.authors) + '</span>' : '';
      const installedMeta = installed ? 'Version: ' + escapeHtml(version || 'multiple') + (pkg.versionSource ? ' · ' + escapeHtml(pkg.versionSource) : '') + projectMeta : 'Latest: ' + escapeHtml(version || '');
      const title = '<div class="package-title-line"><span class="title">' + escapeHtml(id) + '</span>' + author + '</div>';
      const versionChip = '<span class="version-chip">' + escapeHtml(version || (installed ? 'multiple' : '')) + '</span>';
      const action = installed
        ? '<button class="secondary" data-list="' + escapeAttribute(id) + '">List</button><button data-remove="' + escapeAttribute(id) + '">Remove</button>'
        : renderBrowsePackageAction(id, version);
      return '<div class="row package-row' + (isActive ? ' active' : '') + '" role="button" tabindex="0" data-select-package="' + escapeAttribute(id) + '"><span class="pkg-icon">.NET</span><div class="package-text">' + title + '<div class="meta">' + installedMeta + '</div><div class="desc">' + escapeHtml(pkg.description || '') + '</div></div>' + versionChip + '<div class="row-actions">' + action + '</div></div>';
    }

    function renderBrowsePackageAction(packageId, version) {
      const actionState = packageActionState(packageId, version);
      return '<button data-install="' + escapeAttribute(packageId) + '"' + (actionState.disabled ? ' disabled' : '') + ' data-package-action="' + escapeAttribute(actionState.type || '') + '">' + escapeHtml(actionState.label) + '</button>';
    }

    async function runPackageAction(type, packageId, version, sourceUrl, projectPath) {
      let projectPaths;

      if (type === 'install' && !projectPath && !state.selectedProjectPath) {
        const projects = installCandidateProjects(packageId);

        if (!projects.length) {
          setStatus(packageId + ' is already installed in all projects.');
          return;
        }

        projectPaths = await showProjectSelectionModal(packageId, version, projects);

        if (!projectPaths.length) {
          setStatus('Install canceled');
          return;
        }
      }

      if (type === 'update' && !projectPath && !state.selectedProjectPath) {
        projectPaths = updateCandidateProjects(packageId, version).map((project) => project.path);

        if (!projectPaths.length) {
          setStatus(packageId + ' is already up to date.');
          return;
        }
      }

      setStatus(type + ' ' + packageId + '...');
      const response = await request(type, {
        projectPath: projectPaths ? undefined : (projectPath || state.selectedProjectPath),
        projectPaths,
        packageId,
        version,
        sourceUrl: sourceUrl || $('sourceSelect').value
      });

      if (response && !response.error) {
        applyPackageActionToState(type, packageId, version, projectPaths || (projectPath || state.selectedProjectPath ? [projectPath || state.selectedProjectPath] : undefined));
        renderInstalled();
        renderSearchResults();
      }
    }

    function applyPackageActionToState(type, packageId, version, targetProjectPaths) {
      const normalized = String(packageId || '').toLowerCase();
      const targetPaths = targetProjectPaths && targetProjectPaths.length
        ? new Set(targetProjectPaths.map((path) => String(path || '').toLowerCase()))
        : undefined;
      const projects = targetPaths
        ? state.projects.filter((project) => targetPaths.has(String(project.path || '').toLowerCase()))
        : scopedProjects();

      projects.forEach((project) => {
        project.packages = project.packages || [];

        if (type === 'remove') {
          project.packages = project.packages.filter((pkg) => String(pkg.id || pkg.name || '').toLowerCase() !== normalized);
          return;
        }

        const existing = findProjectPackage(project, normalized);

        if (existing) {
          if (version) {
            existing.version = version;
            existing.resolvedVersion = version;
            if (existing.centralVersion) {
              existing.centralVersion = version;
            }
          }
          return;
        }

        if (type === 'install') {
          project.packages.push({
            id: packageId,
            name: packageId,
            version: version || '',
            resolvedVersion: version || '',
            canUpdate: true
          });
        }
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
      resetSourceEditor();
      setStatus('Source saved');
    }

    function resetSourceEditor() {
      state.editingSourceUrl = '';
      $('sourceNameInput').value = '';
      $('sourceUrlInput').value = '';
      setSourceEditorMode();
    }

    function editSource(sourceUrl) {
      const source = state.sources.find((item) => item.url === sourceUrl && item.editable);
      if (!source) return;
      state.editingSourceUrl = source.url;
      $('sourceNameInput').value = source.name;
      $('sourceUrlInput').value = source.url;
      setSourceEditorMode(source);
      setStatus('Editing package source: ' + source.name);
      $('sourceNameInput').focus();
      $('sourceNameInput').select();
    }

    function setSourceEditorMode(source) {
      const isEditing = Boolean(source);
      $('sourceEditor').classList.toggle('editing', isEditing);
      $('sourceEditorTitle').textContent = isEditing ? 'Edit Package Source' : 'Add Package Source';
      $('sourceEditorMode').textContent = isEditing ? 'Editing: ' + source.name : '';
      $('sourceEditorMode').classList.toggle('hidden', !isEditing);
      $('saveSourceButton').textContent = isEditing ? 'Save' : 'Add';
      $('cancelSourceButton').classList.toggle('hidden', !isEditing);
    }

    async function removeSource(sourceUrl) {
      if (state.editingSourceUrl === sourceUrl) {
        resetSourceEditor();
      }
      await request('removeSource', { sourceUrl });
      setStatus('Source removed');
    }

    function selectedProject() {
      return state.projects.find((project) => project.path === state.selectedProjectPath);
    }

    function scopedProjects() {
      const project = selectedProject();
      return project ? [project] : state.projects;
    }

    function installedPackages() {
      const projects = scopedProjects();

      if (selectedProject()) {
        return (projects[0].packages || []).map((pkg) => ({
          ...pkg,
          projectCount: 1,
          installedProjects: [createInstalledProjectEntry(projects[0], pkg)]
        }));
      }

      const grouped = new Map();
      projects.forEach((project) => {
        (project.packages || []).forEach((pkg) => {
          const id = pkg.id || pkg.name;
          if (!id) return;
          const key = String(id).toLowerCase();
          const existing = grouped.get(key) || {
            ...pkg,
            id,
            name: id,
            versions: new Set(),
            sources: new Set(),
            installedProjects: [],
            projectCount: 0
          };
          existing.projectCount += 1;
          existing.installedProjects.push(createInstalledProjectEntry(project, pkg));
          if (pkg.version || pkg.centralVersion) existing.versions.add(pkg.version || pkg.centralVersion);
          if (pkg.versionSource) existing.sources.add(pkg.versionSource);
          grouped.set(key, existing);
        });
      });

      return Array.from(grouped.values()).map((pkg) => {
        const versions = Array.from(pkg.versions);
        const sources = Array.from(pkg.sources);
        return {
          ...pkg,
          version: versions.length === 1 ? versions[0] : '',
          versionSource: sources.length === 1 ? sources[0] : ''
        };
      }).sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''), undefined, { sensitivity: 'base' }));
    }

    function createInstalledProjectEntry(project, pkg) {
      return {
        name: project.name,
        path: project.path,
        relativePath: project.relativePath,
        version: pkg.version || pkg.centralVersion || pkg.resolvedVersion || '',
        versionSource: pkg.versionSource || '',
        canUpdate: pkg.canUpdate !== false,
        updateBlockedReason: pkg.updateBlockedReason || ''
      };
    }

    function installedProjectsForPackage(packageId) {
      const normalized = String(packageId || '').toLowerCase();
      const projects = [];

      scopedProjects().forEach((project) => {
        (project.packages || []).forEach((pkg) => {
          const id = pkg.id || pkg.name;
          if (String(id || '').toLowerCase() !== normalized) return;
          projects.push(createInstalledProjectEntry(project, pkg));
        });
      });

      return projects.sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' }));
    }

    function findProjectPackage(project, normalizedPackageId) {
      return (project.packages || []).find((pkg) => String(pkg.id || pkg.name || '').toLowerCase() === normalizedPackageId);
    }

    function isInstalled(packageId) {
      const normalized = String(packageId || '').toLowerCase();
      return scopedProjects().some((project) => {
        return Boolean(findProjectPackage(project, normalized));
      });
    }

    function isPackageVersionNewer(targetVersion, installedVersion) {
      if (!targetVersion || !installedVersion) return false;
      return comparePackageVersions(targetVersion, installedVersion) > 0;
    }

    function comparePackageVersions(left, right) {
      const leftVersion = parsePackageVersion(left);
      const rightVersion = parsePackageVersion(right);
      const releaseLength = Math.max(leftVersion.release.length, rightVersion.release.length);

      for (let index = 0; index < releaseLength; index += 1) {
        const result = compareVersionIdentifier(leftVersion.release[index] ?? 0, rightVersion.release[index] ?? 0);
        if (result !== 0) return result;
      }

      return comparePrereleaseVersions(leftVersion.prerelease, rightVersion.prerelease);
    }

    function parsePackageVersion(value) {
      let text = String(value || '').trim();

      while (text.length > 1 && ((text.startsWith('(') && text.endsWith(')')) || (text.startsWith('[') && text.endsWith(']')))) {
        text = text.slice(1, -1).trim();
      }

      if (text.startsWith('v') || text.startsWith('V')) {
        text = text.slice(1);
      }

      text = text.split('+')[0];
      const prereleaseIndex = text.indexOf('-');
      const releaseText = prereleaseIndex >= 0 ? text.slice(0, prereleaseIndex) : text;
      const prereleaseText = prereleaseIndex >= 0 ? text.slice(prereleaseIndex + 1) : '';

      return {
        release: releaseText.split('.').filter(Boolean).map(parseVersionIdentifier),
        prerelease: prereleaseText ? prereleaseText.split('.').filter(Boolean).map(parseVersionIdentifier) : []
      };
    }

    function parseVersionIdentifier(value) {
      const text = String(value || '').trim();
      const isNumeric = text.length > 0 && text.split('').every((char) => char >= '0' && char <= '9');
      return isNumeric ? Number(text) : text.toLowerCase();
    }

    function comparePrereleaseVersions(left, right) {
      if (!left.length && !right.length) return 0;
      if (!left.length) return 1;
      if (!right.length) return -1;

      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        if (index >= left.length) return -1;
        if (index >= right.length) return 1;
        const result = compareVersionIdentifier(left[index], right[index]);
        if (result !== 0) return result;
      }

      return 0;
    }

    function compareVersionIdentifier(left, right) {
      if (typeof left === 'number' && typeof right === 'number') {
        return left === right ? 0 : (left > right ? 1 : -1);
      }

      if (typeof left === 'number') return -1;
      if (typeof right === 'number') return 1;

      return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
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
                editable: true,
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
            const packages = await this.protocolHost.search(source.url, query, prerelease, 0, 100);
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
function getNuGetManagerHtml(cspSource = 'vscode-webview:') {
    return NuGetManagerView.prototype.createHtml.call({}, { cspSource });
}
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
    const hiddenSources = getHiddenSourceUrls();
    const isHidden = (url) => hiddenSources.has(normalizeSourceIdentity(url));
    for (const source of getSettingsSources()) {
        if (isHidden(source.url)) {
            continue;
        }
        sources.set(source.url.toLowerCase(), source);
    }
    for (const project of projects) {
        for (const source of project.metadata?.nugetConfig?.packageSources || []) {
            if (!source.value || source.disabled || isHidden(source.value)) {
                continue;
            }
            const key = source.value.toLowerCase();
            if (sources.has(key)) {
                continue;
            }
            sources.set(key, {
                name: source.key || source.value,
                url: source.value,
                editable: true,
                origin: 'nuget.config'
            });
        }
    }
    for (const source of protocolSources) {
        if (!source.url || isHidden(source.url)) {
            continue;
        }
        const key = source.url.toLowerCase();
        if (!sources.has(key)) {
            sources.set(key, {
                ...source,
                editable: true
            });
        }
    }
    if (!isHidden(NUGET_ORG_SOURCE.value) && !sources.has(NUGET_ORG_SOURCE.value.toLowerCase())) {
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
function hasInstalledPackage(project, packageId) {
    return Boolean(findPackageReference(project, packageId));
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
    url.searchParams.set('take', '100');
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
function getHiddenSourceUrls() {
    const configured = vscode.workspace.getConfiguration('solutionManager.nuget').get('hiddenSources') || [];
    return new Set(configured.map(normalizeSourceIdentity).filter(Boolean));
}
async function upsertSource(previousUrl, name, url) {
    const previousKey = normalizeSourceIdentity(previousUrl || '');
    const nextKey = normalizeSourceIdentity(url);
    const settingsSources = getSettingsSources();
    const previousWasInSettings = Boolean(previousKey && settingsSources.some((source) => normalizeSourceIdentity(source.url) === previousKey));
    const sources = settingsSources
        .filter((source) => !previousKey || normalizeSourceIdentity(source.url) !== previousKey)
        .filter((source) => normalizeSourceIdentity(source.url) !== nextKey);
    sources.push({
        name,
        url,
        editable: true,
        origin: 'settings'
    });
    await updateSettingsSources(sources);
    const hiddenSources = getHiddenSourceUrls();
    hiddenSources.delete(nextKey);
    if (previousKey && previousKey !== nextKey && !previousWasInSettings) {
        hiddenSources.add(previousKey);
    }
    await updateHiddenSourceUrls([...hiddenSources]);
}
async function removeSource(url) {
    const sourceKey = normalizeSourceIdentity(url);
    const sources = getSettingsSources().filter((source) => normalizeSourceIdentity(source.url) !== sourceKey);
    await updateSettingsSources(sources);
    if (sourceKey) {
        const hiddenSources = getHiddenSourceUrls();
        hiddenSources.add(sourceKey);
        await updateHiddenSourceUrls([...hiddenSources]);
    }
}
async function updateSettingsSources(sources) {
    await vscode.workspace.getConfiguration('solutionManager.nuget').update('sources', sources.map((source) => JSON.stringify({ name: source.name, url: source.url })), vscode.ConfigurationTarget.Global);
}
async function updateHiddenSourceUrls(urls) {
    await vscode.workspace.getConfiguration('solutionManager.nuget').update('hiddenSources', [...new Set(urls.map(normalizeSourceIdentity).filter(Boolean))], vscode.ConfigurationTarget.Global);
}
function getSkipRestore() {
    return Boolean(vscode.workspace.getConfiguration('solutionManager.nuget').get('skipRestore'));
}
function normalizeSourceIdentity(value) {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
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
    getNuGetManagerHtml,
    mapProtocolDependencyGroups,
    mapProtocolPackage
};
exports.__test = __test;
//# sourceMappingURL=nugetManagerView.js.map