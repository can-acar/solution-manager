const path = require('path');
const vscode = require('vscode');

function showProjectProperties(context, project, metadata) {
  const panel = vscode.window.createWebviewPanel(
    'solutionManager.projectProperties',
    `Project Properties - ${project.name}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: false,
      retainContextWhenHidden: true
    }
  );
  const nonce = getNonce();

  panel.webview.html = getProjectPropertiesHtml(project, metadata, nonce);
}

function getProjectPropertiesHtml(project, metadata, nonce) {
  const targetFramework = (metadata.targetFrameworks || [])[0] || 'Not specified';
  const assemblyName = metadata.assemblyName || project.name;
  const rootNamespace = metadata.rootNamespace || project.name;
  const outputType = formatOutputType(metadata.outputType);
  const languageVersion = metadata.langVersion || inferLanguageVersion(targetFramework);
  const nullable = formatNullable(metadata.nullable);
  const packageCount = (metadata.packageReferences || []).length;
  const projectReferenceCount = (metadata.projectReferences || []).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <title>Project Properties - ${escapeHtml(project.name)}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #18191c;
      --panel: #202327;
      --line: #34383e;
      --text: #d4d7dd;
      --muted: #9a9ca3;
      --field: #1f2227;
      --field-line: #454a52;
      --accent: #31518d;
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
      grid-template-rows: 44px minmax(0, 1fr) 72px;
      min-height: 100vh;
    }

    .titlebar {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 0 16px;
      border-bottom: 1px solid #25282d;
      color: var(--muted);
      font-size: 15px;
      font-weight: 700;
    }

    .traffic {
      display: inline-flex;
      gap: 14px;
      flex: 0 0 auto;
    }

    .traffic span {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #4a4d52;
    }

    .traffic span:first-child {
      background: #ff4b55;
    }

    .traffic span:nth-child(3) {
      background: #30d158;
    }

    .content {
      display: grid;
      grid-template-columns: 300px minmax(0, 1fr);
      min-height: 0;
    }

    .sidebar {
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
      margin: 0 0 18px;
      padding: 0;
      list-style: none;
    }

    .nav li {
      min-height: 30px;
      padding: 5px 48px;
      color: var(--muted);
      border-radius: 5px;
      line-height: 20px;
    }

    .nav li.active {
      color: var(--text);
      background: var(--accent);
    }

    .main {
      min-width: 0;
      padding: 24px 30px;
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
      content: "⌄";
      color: var(--muted);
    }

    .list {
      min-height: 32px;
      padding: 8px 10px;
      color: var(--muted);
      background: var(--field);
      border: 1px solid var(--field-line);
      border-radius: 5px;
    }

    .list div {
      margin: 2px 0;
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
      <span class="traffic"><span></span><span></span><span></span></span>
      <span>Project Properties - ${escapeHtml(project.name)}</span>
    </header>
    <div class="content">
      <aside class="sidebar">
        <div class="group-title">Properties</div>
        <ul class="nav">
          <li class="active">Application</li>
          <li>NuGet</li>
          <li>Assembly</li>
          <li>Signing</li>
          <li>Build Events</li>
        </ul>
        <div class="group-title">IDE</div>
        <ul class="nav">
          <li>Inspections</li>
        </ul>
        <div class="group-title">Configurations</div>
        <ul class="nav">
          <li>Debug | AnyCPU</li>
          <li>Release | AnyCPU</li>
        </ul>
        <div class="group-title">Diagnostic</div>
        <ul class="nav">
          <li>Imports</li>
          <li>Properties</li>
        </ul>
      </aside>
      <main class="main">
        <section class="section">
          <div class="section-title">General</div>
          ${fieldRow('Assembly name:', assemblyName)}
          ${fieldRow('Root namespace:', rootNamespace)}
          ${selectRow('Target framework:', targetFramework)}
          ${selectRow('Output type:', outputType)}
        </section>
        <section class="section">
          <div class="section-title">Language</div>
          ${selectRow('Language Version:', languageVersion)}
          ${selectRow('Nullable reference types (C# 8.0+):', nullable)}
        </section>
        <section class="section">
          <div class="section-title">NuGet</div>
          ${fieldRow('Packages:', `${packageCount}`)}
          <div class="form-row">
            <div class="label">Package References:</div>
            <div class="list">${formatReferenceList(metadata.packageReferences)}</div>
          </div>
        </section>
        <section class="section">
          <div class="section-title">References</div>
          ${fieldRow('Project references:', `${projectReferenceCount}`)}
          <div class="form-row">
            <div class="label">Projects:</div>
            <div class="list">${formatReferenceList(metadata.projectReferences)}</div>
          </div>
        </section>
      </main>
    </div>
    <footer class="footer">
      <button>Cancel</button>
      <button class="primary">OK</button>
    </footer>
  </div>
</body>
</html>`;
}

function fieldRow(label, value) {
  return `<div class="form-row"><div class="label">${escapeHtml(label)}</div><div class="field">${escapeHtml(value)}</div></div>`;
}

function selectRow(label, value) {
  return `<div class="form-row"><div class="label">${escapeHtml(label)}</div><div class="select">${escapeHtml(value)}</div></div>`;
}

function formatReferenceList(references = []) {
  if (!references.length) {
    return '<div>None</div>';
  }

  return references
    .map((reference) => {
      const version = reference.version ? ` ${reference.version}` : '';
      return `<div>${escapeHtml(reference.name)}${escapeHtml(version)}</div>`;
    })
    .join('');
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
