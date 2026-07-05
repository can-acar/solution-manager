const vscode = require('vscode');

function showProjectProperties(context, project, metadata) {
  const panel = vscode.window.createWebviewPanel(
    'solutionManager.projectProperties',
    `Project Properties - ${project.name}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );
  const nonce = getNonce();

  panel.webview.onDidReceiveMessage(
    (message) => {
      if (message && message.command === 'close') {
        panel.dispose();
      }
    },
    undefined,
    context.subscriptions
  );
  panel.webview.html = getProjectPropertiesHtml(project, metadata, nonce);
}

function getProjectPropertiesHtml(project, metadata, nonce) {
  const targetFrameworks = metadata.targetFrameworks || [];
  const targetFramework = targetFrameworks[0] || 'Not specified';
  const assemblyName = metadata.assemblyName || project.name;
  const rootNamespace = metadata.rootNamespace || project.name;
  const outputType = formatOutputType(metadata.outputType);
  const languageVersion = metadata.langVersion || inferLanguageVersion(targetFramework);
  const nullable = formatNullable(metadata.nullable);
  const packageReferences = metadata.packageReferences || [];
  const projectReferences = metadata.projectReferences || [];
  const assemblyReferences = metadata.assemblyReferences || [];
  const frameworkReferences = metadata.frameworkReferences || [];
  const analyzerReferences = metadata.analyzerReferences || [];
  const sourceGenerators = metadata.sourceGenerators || [];
  const sdk = metadata.sdk || 'Microsoft.NET.Sdk';
  const relativePath = project.relativePath || vscode.workspace.asRelativePath(project.path, false);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Project Properties - ${escapeHtml(project.name)}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #18191c;
      --line: #34383e;
      --text: #d4d7dd;
      --muted: #9a9ca3;
      --field: #1f2227;
      --field-line: #454a52;
      --accent: #31518d;
      --accent-strong: #3f6fcb;
      --button: #3478e5;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      height: 100%;
      margin: 0;
      color: var(--text);
      background: var(--bg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 14px;
    }

    .window {
      display: grid;
      grid-template-rows: 46px minmax(0, 1fr) 72px;
      min-height: 100vh;
    }

    .titlebar {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
      padding: 0 18px;
      border-bottom: 1px solid #25282d;
      color: var(--muted);
      font-size: 15px;
      font-weight: 700;
    }

    .title {
      min-width: 0;
      overflow: hidden;
      color: var(--text);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .title-path {
      min-width: 0;
      overflow: hidden;
      color: var(--muted);
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .content {
      display: grid;
      grid-template-columns: 310px minmax(0, 1fr);
      min-height: 0;
    }

    .sidebar {
      overflow-y: auto;
      padding: 16px 12px;
      border-right: 1px solid #282c32;
    }

    .group-title {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      margin: 0 0 8px;
      color: var(--muted);
      font-style: italic;
      font-weight: 700;
    }

    .group-title::before,
    .group-title::after {
      content: "";
      height: 1px;
      background: var(--line);
    }

    .nav {
      display: grid;
      gap: 3px;
      margin: 0 0 18px;
      padding: 0;
      list-style: none;
    }

    .nav-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      width: 100%;
      min-height: 34px;
      padding: 6px 12px 6px 54px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 5px;
      font: inherit;
      text-align: left;
    }

    .nav-item:hover {
      color: var(--text);
      background: #24272d;
    }

    .nav-item.active {
      color: var(--text);
      background: var(--accent);
    }

    .nav-label,
    .nav-detail {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .nav-main {
      display: grid;
      gap: 1px;
      min-width: 0;
    }

    .nav-detail {
      color: #b6bbc5;
      font-size: 12px;
    }

    .badge {
      min-width: 24px;
      height: 20px;
      padding: 1px 7px;
      color: #dbe6ff;
      background: #263852;
      border: 1px solid #3b5680;
      border-radius: 10px;
      font-size: 12px;
      line-height: 16px;
      text-align: center;
    }

    .main {
      min-width: 0;
      overflow: auto;
      padding: 24px 30px;
    }

    .pane {
      display: none;
      max-width: 980px;
    }

    .pane.active {
      display: block;
    }

    .section {
      margin-bottom: 28px;
    }

    .section-title {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
      font-size: 16px;
    }

    .section-title::after {
      content: "";
      height: 1px;
      background: var(--line);
    }

    .form-row {
      display: grid;
      grid-template-columns: 230px minmax(260px, 1fr);
      align-items: center;
      gap: 14px;
      min-height: 36px;
      margin-bottom: 8px;
    }

    .label {
      color: var(--text);
      text-align: right;
      font-size: 15px;
    }

    .field,
    .select {
      min-height: 30px;
      padding: 5px 10px;
      color: var(--text);
      background: var(--field);
      border: 1px solid var(--field-line);
      border-radius: 3px;
      line-height: 20px;
    }

    .select {
      display: flex;
      justify-content: space-between;
      border-radius: 5px;
    }

    .select::after {
      content: "\\25BE";
      color: var(--muted);
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      color: var(--text);
      background: var(--field);
      border: 1px solid var(--field-line);
      border-radius: 5px;
      overflow: hidden;
    }

    .table th,
    .table td {
      padding: 8px 10px;
      border-bottom: 1px solid #333740;
      text-align: left;
      vertical-align: top;
    }

    .table th {
      color: #b8bdc8;
      background: #24272d;
      font-weight: 600;
    }

    .table tr:last-child td {
      border-bottom: 0;
    }

    .empty {
      padding: 8px 10px;
      color: var(--muted);
      background: var(--field);
      border: 1px solid var(--field-line);
      border-radius: 5px;
    }

    .footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 14px;
      padding: 14px 18px;
      border-top: 1px solid #282c32;
    }

    .footer button {
      min-width: 96px;
      min-height: 36px;
      color: var(--text);
      background: transparent;
      border: 1px solid var(--field-line);
      border-radius: 5px;
      font: inherit;
    }

    .footer .primary {
      color: white;
      background: var(--button);
      border-color: #6098ff;
      box-shadow: 0 0 0 2px #102f66;
    }
  </style>
</head>
<body>
  <div class="window">
    <header class="titlebar">
      <span class="title">Project Properties - ${escapeHtml(project.name)}</span>
      <span class="title-path">${escapeHtml(relativePath)}</span>
    </header>
    <div class="content">
      <aside class="sidebar">
        ${navGroup('Properties', [
          navItem('application', 'Application', targetFramework, '', true),
          navItem('nuget', 'NuGet', 'Package references', packageReferences.length),
          navItem('assembly', 'Assembly', 'References and metadata', projectReferences.length + assemblyReferences.length + frameworkReferences.length),
          navItem('signing', 'Signing', 'Strong name settings'),
          navItem('build-events', 'Build Events', 'Pre and post build')
        ])}
        ${navGroup('IDE', [
          navItem('inspections', 'Inspections', 'Analysis settings')
        ])}
        ${navGroup('Configurations', [
          navItem('debug', 'Debug | AnyCPU', outputType),
          navItem('release', 'Release | AnyCPU', outputType)
        ])}
        ${navGroup('Diagnostic', [
          navItem('imports', 'Imports', sdk, 2),
          navItem('diagnostic-properties', 'Properties', 'Evaluated values', targetFrameworks.length)
        ])}
      </aside>
      <main class="main">
        <section class="pane active" data-pane="application" role="tabpanel">
          <div class="section">
            <div class="section-title">General</div>
            ${fieldRow('Assembly name:', assemblyName)}
            ${fieldRow('Root namespace:', rootNamespace)}
            ${selectRow('Target framework:', targetFramework)}
            ${selectRow('Output type:', outputType)}
          </div>
          <div class="section">
            <div class="section-title">Language</div>
            ${selectRow('Language Version:', languageVersion)}
            ${selectRow('Nullable reference types (C# 8.0+):', nullable)}
          </div>
        </section>

        <section class="pane" data-pane="nuget" role="tabpanel">
          <div class="section">
            <div class="section-title">NuGet</div>
            ${fieldRow('Packages:', String(packageReferences.length))}
            ${referenceTable(['Package', 'Version'], packageReferences.map((reference) => [
              reference.name,
              reference.version || 'Not specified'
            ]), 'No package references.')}
          </div>
        </section>

        <section class="pane" data-pane="assembly" role="tabpanel">
          <div class="section">
            <div class="section-title">Assembly</div>
            ${fieldRow('Project file:', project.fileName || `${project.name}.csproj`)}
            ${fieldRow('Project path:', project.path)}
            ${fieldRow('SDK:', sdk)}
            ${fieldRow('Target frameworks:', targetFrameworks.length ? targetFrameworks.join(', ') : 'Not specified')}
          </div>
          <div class="section">
            <div class="section-title">References</div>
            ${referenceTable(['Type', 'Name'], [
              ...projectReferences.map((reference) => ['Project', reference.name]),
              ...assemblyReferences.map((reference) => ['Assembly', reference.name]),
              ...frameworkReferences.map((reference) => ['Framework', reference.name])
            ], 'No assembly or project references.')}
          </div>
        </section>

        <section class="pane" data-pane="signing" role="tabpanel">
          <div class="section">
            <div class="section-title">Signing</div>
            ${fieldRow('Sign assembly:', 'Not configured')}
            ${fieldRow('Key file:', 'None')}
            ${fieldRow('Delay sign:', 'Not configured')}
          </div>
        </section>

        <section class="pane" data-pane="build-events" role="tabpanel">
          <div class="section">
            <div class="section-title">Build Events</div>
            ${fieldRow('Pre-build event:', 'Not configured')}
            ${fieldRow('Post-build event:', 'Not configured')}
          </div>
        </section>

        <section class="pane" data-pane="inspections" role="tabpanel">
          <div class="section">
            <div class="section-title">Inspections</div>
            ${fieldRow('Analyzers:', String(analyzerReferences.length))}
            ${fieldRow('Source generators:', String(sourceGenerators.length))}
            ${referenceTable(['Analyzer'], analyzerReferences.map((reference) => [reference.name]), 'No analyzer references.')}
          </div>
        </section>

        <section class="pane" data-pane="debug" role="tabpanel">
          <div class="section">
            <div class="section-title">Debug | AnyCPU</div>
            ${fieldRow('Configuration:', 'Debug')}
            ${fieldRow('Platform:', 'AnyCPU')}
            ${fieldRow('Output type:', outputType)}
            ${fieldRow('Target framework:', targetFramework)}
          </div>
        </section>

        <section class="pane" data-pane="release" role="tabpanel">
          <div class="section">
            <div class="section-title">Release | AnyCPU</div>
            ${fieldRow('Configuration:', 'Release')}
            ${fieldRow('Platform:', 'AnyCPU')}
            ${fieldRow('Output type:', outputType)}
            ${fieldRow('Target framework:', targetFramework)}
          </div>
        </section>

        <section class="pane" data-pane="imports" role="tabpanel">
          <div class="section">
            <div class="section-title">Imports</div>
            ${referenceTable(['Import', 'Source'], [
              ['Sdk.props', sdk],
              ['Sdk.targets', sdk]
            ], 'No imports.')}
          </div>
        </section>

        <section class="pane" data-pane="diagnostic-properties" role="tabpanel">
          <div class="section">
            <div class="section-title">Properties</div>
            ${referenceTable(['Property', 'Value'], [
              ['AssemblyName', assemblyName],
              ['RootNamespace', rootNamespace],
              ['TargetFramework', targetFramework],
              ['TargetFrameworks', targetFrameworks.join('; ') || 'Not specified'],
              ['OutputType', metadata.outputType || 'Library'],
              ['Nullable', metadata.nullable || 'Not specified'],
              ['LangVersion', metadata.langVersion || 'Default'],
              ['Sdk', sdk]
            ], 'No project properties.')}
          </div>
        </section>
      </main>
    </div>
    <footer class="footer">
      <button type="button" data-close>Cancel</button>
      <button type="button" class="primary" data-close>OK</button>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tabs = document.querySelectorAll('[data-tab]');
    const panes = document.querySelectorAll('[data-pane]');

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;

        tabs.forEach((item) => {
          const selected = item === tab;
          item.classList.toggle('active', selected);
          item.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        panes.forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === target));
      });
    });

    document.querySelectorAll('[data-close]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: 'close' }));
    });
  </script>
</body>
</html>`;
}

function navGroup(label, items) {
  return `<div class="group-title">${escapeHtml(label)}</div><ul class="nav" role="tablist">${items.join('')}</ul>`;
}

function navItem(id, label, detail = '', count = '', active = false) {
  const countMarkup = count === '' || count === undefined
    ? ''
    : `<span class="badge">${escapeHtml(count)}</span>`;

  return `<li><button type="button" class="nav-item${active ? ' active' : ''}" data-tab="${escapeHtml(id)}" role="tab" aria-selected="${active ? 'true' : 'false'}">
    <span class="nav-main">
      <span class="nav-label">${escapeHtml(label)}</span>
      <span class="nav-detail">${escapeHtml(detail)}</span>
    </span>
    ${countMarkup}
  </button></li>`;
}

function fieldRow(label, value) {
  return `<div class="form-row"><div class="label">${escapeHtml(label)}</div><div class="field">${escapeHtml(value)}</div></div>`;
}

function selectRow(label, value) {
  return `<div class="form-row"><div class="label">${escapeHtml(label)}</div><div class="select">${escapeHtml(value)}</div></div>`;
}

function referenceTable(headers, rows, emptyMessage) {
  if (!rows.length) {
    return `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
  }

  const headerMarkup = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const bodyMarkup = rows
    .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`)
    .join('');

  return `<table class="table"><thead><tr>${headerMarkup}</tr></thead><tbody>${bodyMarkup}</tbody></table>`;
}

function formatOutputType(value) {
  if (!value) {
    return 'Class library';
  }

  if (/exe/i.test(value)) {
    return 'Console application';
  }

  if (/library/i.test(value)) {
    return 'Class library';
  }

  return value;
}

function formatNullable(value) {
  if (!value) {
    return 'Not specified';
  }

  if (/enable/i.test(value)) {
    return 'Enable';
  }

  if (/disable/i.test(value)) {
    return 'Disable';
  }

  return value;
}

function inferLanguageVersion(targetFramework) {
  const match = /^net(\d+)\./i.exec(targetFramework || '');

  if (!match) {
    return 'Default';
  }

  const major = Number(match[1]);

  if (major >= 10) {
    return 'C# 14.0';
  }

  if (major >= 9) {
    return 'C# 13.0';
  }

  if (major >= 8) {
    return 'C# 12.0';
  }

  return 'Default';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNonce() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';

  for (let i = 0; i < 32; i += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return text;
}

module.exports = {
  showProjectProperties
};
