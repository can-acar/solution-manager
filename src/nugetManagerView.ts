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
    centralPackageVersions?: NuGetPackageReference[];
    nugetConfig?: NuGetConfig;
  };
};

type NuGetPackageReference = {
  name?: string;
  include?: string;
  version?: string;
  centralVersion?: string;
  centralPackageVersion?: NuGetPackageReference;
  path?: string;
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
  licenseUrl?: string;
  tags?: string;
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
        const packageId = requireText(message.packageId, 'Package id is required.');
        const version = String(message.version || '').trim();
        const projects = this.getActionProjects(message.projectPath, packageId, message.type);
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

          const versionArg = version ? ` --version ${quoteForShell(version)}` : '';
          const sourceArg = message.sourceUrl ? ` --source ${quoteForShell(normalizeSourceForDotnet(message.sourceUrl))}` : '';
          const restoreArg = getSkipRestore() ? ' --no-restore' : '';
          this.terminalRunner.runCommand(`dotnet add ${quoteForShell(project.path)} package ${quoteForShell(packageId)}${versionArg}${sourceArg}${restoreArg}`);
          commandCount += 1;
        }

        if (updatedInProjectFiles > 0) {
          await this.refresh({ userVisible: false });
          const state = await this.getState();
          this.projects = mergeFreshProjectMetadata(this.projects, state);
          await this.postState(message.requestId);
        }

        const fileMessage = updatedInProjectFiles > 0 ? `${updatedInProjectFiles} project file update${updatedInProjectFiles === 1 ? '' : 's'}` : '';
        const terminalMessage = commandCount > 0 ? `${commandCount} terminal command${commandCount === 1 ? '' : 's'}` : '';
        await this.postNotice(
          message.requestId,
          `${message.type === 'update' ? 'Update' : 'Install'} applied to ${projects.length} project${projects.length === 1 ? '' : 's'}${fileMessage || terminalMessage ? ` (${[fileMessage, terminalMessage].filter(Boolean).join(', ')})` : ''}.`
        );
        return;
      }

      if (message.type === 'remove') {
        const packageId = requireText(message.packageId, 'Package id is required.');
        const projects = this.getActionProjects(message.projectPath, packageId, message.type);

        if (projects.length === 0) {
          throw new Error(`Package '${packageId}' is not installed in the selected scope.`);
        }

        for (const project of projects) {
          this.terminalRunner.runCommand(`dotnet remove ${quoteForShell(project.path)} package ${quoteForShell(packageId)}`);
        }

        await this.postNotice(message.requestId, `Remove command sent for ${projects.length} project${projects.length === 1 ? '' : 's'}.`);
        return;
      }

      if (message.type === 'list') {
        const projects = this.getActionProjects(message.projectPath);

        if (projects.length === 0) {
          throw new Error('No projects were found for package listing.');
        }

        for (const project of projects) {
          this.terminalRunner.runCommand(`dotnet list ${quoteForShell(project.path)} package --include-transitive`);
        }

        await this.postNotice(message.requestId, `List packages command sent for ${projects.length} project${projects.length === 1 ? '' : 's'}.`);
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

  private getActionProjects(projectPath?: string, packageId?: string, action?: string): NuGetManagerProject[] {
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
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .nuget-shell {
      display: grid;
      grid-template-rows: 30px 34px 1fr 26px;
      height: 100vh;
      min-height: 0;
      background: var(--vscode-editor-background);
    }
    .titlebar {
      display: flex;
      align-items: center;
      padding: 0 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    .title-caption {
      display: flex;
      align-items: center;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .3px;
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
    .page {
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
      grid-template-rows: 42px 38px 1fr;
      min-height: 0;
    }
    .package-toolbar {
      display: grid;
      grid-template-columns: minmax(320px, 1fr) 28px max-content minmax(130px, 160px) max-content max-content;
      gap: 8px;
      align-items: center;
      padding: 8px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    #projectSelect {
      width: auto;
      min-width: 132px;
      max-width: 320px;
    }
    .search-box {
      display: grid;
      grid-template-columns: 24px 1fr;
      align-items: center;
      height: 28px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
    }
    .search-icon {
      display: flex;
      position: relative;
      justify-content: center;
      color: var(--vscode-descriptionForeground);
    }
    .search-icon::before {
      content: "";
      width: 11px;
      height: 11px;
      border: 1.5px solid currentColor;
      border-radius: 50%;
    }
    .search-icon::after {
      content: "";
      position: absolute;
      width: 6px;
      height: 1.5px;
      right: 5px;
      bottom: 7px;
      background: currentColor;
      transform: rotate(-45deg);
      transform-origin: center;
    }
    .browse-summary {
      display: flex;
      align-items: center;
      min-width: 0;
      padding: 0 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-size: 15px;
      font-style: italic;
      font-weight: 700;
    }
    .content-split {
      display: grid;
      grid-template-columns: minmax(340px, 49%) 8px minmax(320px, 1fr);
      min-height: 0;
      height: 100%;
    }
    .list-pane {
      display: grid;
      grid-template-rows: 34px 1fr;
      min-width: 0;
      min-height: 0;
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
    .splitter::after {
      content: "< | >";
      position: absolute;
      top: 48%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(90deg);
      padding: 1px 5px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 10px;
      font-weight: 700;
      line-height: 1.2;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
    }
    .splitter:hover::after,
    .splitter.dragging::after {
      opacity: 1;
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
      height: 28px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
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
      font-size: 16px;
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
    .row.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .package-list {
      min-height: 0;
      overflow: auto;
      padding-top: 8px;
    }
    .pkg-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 2px;
      color: #f8fafc;
      background: linear-gradient(135deg, #7c3aed, #2563eb);
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
    .row:hover .row-actions {
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
      grid-template-columns: minmax(0, 1fr) max-content;
      gap: 12px;
      align-items: center;
      min-height: 34px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
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
    .dependencies {
      padding: 0 16px 14px;
    }
    .dependencies ul {
      margin: 4px 0 8px 18px;
      padding: 0;
    }
    @media (max-width: 920px) {
      .package-toolbar {
        grid-template-columns: minmax(160px, 1fr) 28px minmax(140px, 1fr);
        grid-auto-flow: row;
      }
      .packages-page {
        grid-template-rows: auto 36px 1fr;
      }
      .content-split {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(220px, 48%) 1fr;
      }
      .splitter {
        display: none;
      }
      .list-pane {
        border-right: 0;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
    }
  </style>
</head>
<body>
  <div class="nuget-shell">
    <header class="titlebar">
      <div class="title-caption">NUGET</div>
    </header>
    <nav class="main-tabs" aria-label="NuGet sections">
      <button id="packagesTabButton" class="tab-button active" type="button">Paketler</button>
      <button id="sourcesTabButton" class="tab-button" type="button">Kaynaklar</button>
    </nav>
    <section id="packagesView" class="page packages-page">
      <div class="package-toolbar">
        <div class="search-box">
          <span class="search-icon" aria-hidden="true"></span>
          <input id="queryInput" placeholder="Search NuGet packages" />
        </div>
        <button id="refreshButton" class="icon-button" title="Refresh" aria-label="Refresh">↻</button>
        <select id="projectSelect" title="Project"></select>
        <select id="sourceSelect" title="Package source"></select>
        <label class="checkbox-row"><input id="prereleaseInput" type="checkbox" /> Prerelease</label>
        <button id="searchButton">Search</button>
      </div>
      <div id="browseSummary" class="browse-summary">Available Packages: Top 100</div>
      <div id="contentSplit" class="content-split">
        <section class="list-pane">
          <div class="sub-tabs" aria-label="Package list mode">
            <button id="browseTabButton" class="tab-button active" type="button">ARA</button>
            <button id="installedTabButton" class="tab-button" type="button">YUKLU</button>
          </div>
          <div id="searchResults" class="list package-list"></div>
          <div id="installedList" class="list package-list hidden"></div>
        </section>
        <div id="splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="Resize package details panel" title="< | >"></div>
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
        if (state.selectedProjectPath && !state.projects.some((project) => project.path === state.selectedProjectPath)) {
          state.selectedProjectPath = '';
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
    $('packagesTabButton').addEventListener('click', () => setMainTab('packages'));
    $('sourcesTabButton').addEventListener('click', () => setMainTab('sources'));
    $('browseTabButton').addEventListener('click', () => setPackageTab('browse'));
    $('installedTabButton').addEventListener('click', () => setPackageTab('installed'));
    $('searchButton').addEventListener('click', search);
    $('saveSourceButton').addEventListener('click', saveSource);
    $('cancelSourceButton').addEventListener('click', resetSourceEditor);
    $('queryInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') search();
    });
    initializeSplitter();

    async function search() {
      setPackageTab('browse');
      setStatus('Searching...');
      await request('search', {
        query: $('queryInput').value,
        prerelease: $('prereleaseInput').checked,
        sourceUrl: $('sourceSelect').value
      });
      setStatus('Search complete');
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
      document.querySelectorAll('#installedList [data-select-package]').forEach((row) => row.addEventListener('click', () => {
        const pkg = packages.find((item) => (item.id || item.name) === row.dataset.selectPackage);
        state.selectedPackage = pkg;
        state.selectedDetails = { installedOnly: true };
        renderDetails();
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
        return '<div class="row source-row"><div><div class="title">' + escapeHtml(source.name) + badge + '</div><div class="meta">' + escapeHtml(source.url) + '</div></div><div class="actions">' + actions + '</div></div>';
      }).join('') : '<div class="empty">No package sources found.</div>';
      document.querySelectorAll('[data-edit-source]').forEach((button) => button.addEventListener('click', () => editSource(button.dataset.editSource)));
      document.querySelectorAll('[data-remove-source]').forEach((button) => button.addEventListener('click', () => removeSource(button.dataset.removeSource)));
    }

    function renderSearchResults() {
      $('searchResults').innerHTML = state.searchResults.length ? state.searchResults.map((pkg) => packageRow(pkg, false)).join('') : '<div class="empty">Search for packages to install.</div>';
      document.querySelectorAll('#searchResults [data-select-package]').forEach((row) => row.addEventListener('click', () => {
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
      if (state.selectedDetails && state.selectedDetails.installedOnly) {
        renderInstalledPackageDetails(pkg);
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

    function renderInstalledPackageDetails(pkg) {
      const projects = pkg.installedProjects || [];
      const versionText = pkg.version || pkg.centralVersion || (pkg.projectCount ? 'multiple' : '');
      $('details').innerHTML =
        '<div class="details-grid">' +
        '<div class="details-label">Package</div><div><strong>' + escapeHtml(pkg.id || pkg.name) + '</strong></div>' +
        '<div class="details-label">Version</div><div>' + escapeHtml(versionText || 'unspecified') + '</div>' +
        '<div class="details-label">Installed in</div><div>' + projects.length + ' project' + (projects.length === 1 ? '' : 's') + '</div>' +
        '</div>' +
        '<div class="section-title">Installed Projects</div>' +
        '<div class="project-install-list">' +
        (projects.length ? projects.map((project) =>
          '<div class="project-install-row">' +
          '<div><div class="project-install-name">' + escapeHtml(project.name) + '</div><div class="meta">' + escapeHtml(project.relativePath || project.path || '') + '</div></div>' +
          '<div class="project-install-version">' + escapeHtml(project.version || 'unspecified') + '</div>' +
          '</div>'
        ).join('') : '<div class="empty">This package is not installed in the selected scope.</div>') +
        '</div>';
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
      const projectMeta = installed && pkg.projectCount ? ' · ' + pkg.projectCount + ' project' + (pkg.projectCount === 1 ? '' : 's') : '';
      const author = pkg.authors ? ' @' + escapeHtml(pkg.authors) : '';
      const installedMeta = installed ? 'Version: ' + escapeHtml(version || 'multiple') + (pkg.versionSource ? ' · ' + escapeHtml(pkg.versionSource) : '') + projectMeta : 'Latest: ' + escapeHtml(version || '');
      const title = '<span class="title">' + escapeHtml(id) + '</span>' + author;
      const versionChip = '<span class="version-chip">' + escapeHtml(version || (installed ? 'multiple' : '')) + '</span>';
      const action = installed
        ? '<button class="secondary" data-list="' + escapeAttribute(id) + '">List</button><button data-remove="' + escapeAttribute(id) + '">Remove</button>'
        : '<button data-install="' + escapeAttribute(id) + '">' + (isInstalled(id) ? 'Update' : 'Install') + '</button>';
      return '<div class="row" data-select-package="' + escapeAttribute(id) + '"><span class="pkg-icon">.NET</span><div><div>' + title + '</div><div class="meta">' + installedMeta + '</div><div class="desc">' + escapeHtml(pkg.description || '') + '</div></div>' + versionChip + '<div class="row-actions">' + action + '</div></div>';
    }

    async function runPackageAction(type, packageId, version, sourceUrl) {
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
        versionSource: pkg.versionSource || ''
      };
    }

    function isInstalled(packageId) {
      return scopedProjects().some((project) => {
        return (project.packages || []).some((pkg) => String(pkg.id).toLowerCase() === String(packageId).toLowerCase());
      });
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
      versionSource: reference.versionSource,
      canUpdate: canUpdatePackageReference(project, reference),
      updateBlockedReason: getPackageReferenceUpdateBlockedReason(reference)
    })).filter((reference) => reference.id)
  };
}

function getPackageSources(projects: NuGetManagerProject[], protocolSources: Array<{ name: string; url: string; editable: boolean; origin: string }> = []): Array<{ name: string; url: string; editable: boolean; origin: string }> {
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

  for (const source of protocolSources) {
    if (!source.url) {
      continue;
    }

    const key = source.url.toLowerCase();

    if (!sources.has(key)) {
      sources.set(key, source);
    }
  }

  if (!sources.has(NUGET_ORG_SOURCE.value!.toLowerCase())) {
    sources.set(NUGET_ORG_SOURCE.value!.toLowerCase(), {
      name: NUGET_ORG_SOURCE.key!,
      url: NUGET_ORG_SOURCE.value!,
      editable: true,
      origin: 'settings'
    });
  }

  return [...sources.values()];
}

function mapProtocolPackage(item: any, sourceUrl: string): NuGetSearchResult {
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
      ? versions.map((version: any) => ({
        version: String(version.Version || version.version || ''),
        downloads: Number(version.Downloads || version.downloads || 0)
      })).filter((version: NuGetPackageVersion) => version.version)
      : [],
    projectUrl: item.ProjectUrl || item.projectUrl,
    iconUrl: item.IconUrl || item.iconUrl,
    licenseUrl: item.LicenseUrl || item.licenseUrl,
    tags: Array.isArray(tags) ? tags.join(', ') : String(tags || '')
  } as NuGetSearchResult;
}

function mapProtocolDependencyGroups(details: any): NuGetPackageDetails['dependencyGroups'] {
  const frameworks = details?.Dependencies?.Frameworks || details?.dependencies?.frameworks || {};

  return Object.entries(frameworks).map(([targetFramework, dependencies]) => ({
    targetFramework,
    dependencies: (Array.isArray(dependencies) ? dependencies : []).map((dependency: any) => ({
      id: String(dependency.Package || dependency.package || dependency.Id || dependency.id || ''),
      range: dependency.VersionRange || dependency.versionRange
    })).filter((dependency) => dependency.id)
  }));
}

function findPackageReference(project: NuGetManagerProject, packageId: string): NuGetPackageReference | undefined {
  const normalized = normalizePackageId(packageId);

  return (project.metadata?.packageReferences || []).find((reference) => {
    return normalizePackageId(reference.name || reference.include || '') === normalized;
  });
}

function hasInstalledPackage(project: NuGetManagerProject, packageId: string): boolean {
  return Boolean(findPackageReference(project, packageId));
}

function findCentralPackageVersion(project: NuGetManagerProject, packageId: string): NuGetPackageReference | undefined {
  const normalized = normalizePackageId(packageId);

  return (project.metadata?.centralPackageVersions || []).find((reference) => {
    return normalizePackageId(reference.name || reference.include || '') === normalized;
  });
}

function isCentralPackageReference(reference?: NuGetPackageReference): boolean {
  return Boolean(reference && (
    reference.versionSource === 'Directory.Packages.props' ||
    reference.centralVersion ||
    reference.centralPackageVersion
  ));
}

function canUpdatePackageReference(project: NuGetManagerProject, reference: NuGetPackageReference): boolean {
  if (!isCentralPackageReference(reference)) {
    return true;
  }

  const centralReference = reference.centralPackageVersion || findCentralPackageVersion(project, reference.name || reference.include || '');
  return Boolean(centralReference?.path) && !hasReferenceCondition(reference) && !hasReferenceCondition(centralReference);
}

function getPackageReferenceUpdateBlockedReason(reference: NuGetPackageReference): string | undefined {
  if (isCentralPackageReference(reference) && hasReferenceCondition(reference)) {
    return 'Conditional central package versions must be edited manually.';
  }

  return undefined;
}

function hasReferenceCondition(reference?: NuGetPackageReference): boolean {
  return Boolean(reference?.condition || reference?.itemCondition || reference?.groupCondition || reference?.versionSourceCondition);
}

function normalizePackageId(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readCentralPackageManagement(projectPath: string): Promise<{ enabled: boolean; path?: string }> {
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

async function findNearestCentralPackageProps(projectPath: string): Promise<string | undefined> {
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
    } catch {
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
  NuGetManagerView,
  mapProtocolDependencyGroups,
  mapProtocolPackage,
  getPackageSources,
  canUpdatePackageReference,
  __test
};

const __test = {
  canUpdatePackageReference,
  getPackageSources,
  mapProtocolDependencyGroups,
  mapProtocolPackage
};
