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
exports.__test = void 0;
exports.showSolutionProperties = showSolutionProperties;
// @ts-nocheck
const crypto = __importStar(require("crypto"));
const vscode = __importStar(require("vscode"));
const webviewUi_1 = require("#src/webviewUi");
function showSolutionProperties(context, solution, model, onChange) {
    const panel = vscode.window.createWebviewPanel('solutionManager.solutionProperties', `Solution Properties - ${solution.name}`, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
    });
    let currentModel = model;
    let selectedConfiguration = currentModel.solutionConfigurations[0] || '';
    const render = (notice = '') => {
        panel.webview.html = getSolutionPropertiesHtml(solution, currentModel, selectedConfiguration, getNonce(), notice);
    };
    const disposable = panel.webview.onDidReceiveMessage(async (message) => {
        if (!message) {
            return;
        }
        if (message.command === 'close') {
            panel.dispose();
            return;
        }
        if (message.command === 'selectConfiguration') {
            selectedConfiguration = message.solutionConfiguration || selectedConfiguration;
            render();
            return;
        }
        if (message.command === 'change') {
            if (currentModel.format === 'slnx') {
                return;
            }
            try {
                currentModel = await onChange({
                    projectGuid: message.projectGuid,
                    projectPath: message.projectPath,
                    solutionConfiguration: message.solutionConfiguration,
                    field: message.field,
                    value: message.value
                });
                selectedConfiguration = message.solutionConfiguration || selectedConfiguration;
                render('Solution configuration updated.');
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Solution Manager: ${errorMessage}`);
                render(errorMessage);
            }
        }
    });
    panel.onDidDispose(() => disposable.dispose(), undefined, context.subscriptions);
    render();
}
function getSolutionPropertiesHtml(solution, model, selectedConfiguration, nonce, notice) {
    const configurationOptions = model.solutionConfigurations
        .map((configuration) => `<option value="${escapeAttribute(configuration)}"${configuration === selectedConfiguration ? ' selected' : ''}>${escapeHtml(configuration)}</option>`)
        .join('');
    const rows = model.projects
        .map((project) => renderProjectRow(project, model, selectedConfiguration))
        .join('');
    const noticeMarkup = notice
        ? `<div class="notice">${escapeHtml(notice)}</div>`
        : '';
    const slnxNotice = model.format === 'slnx'
        ? '<div class="hint">This .slnx view is read-only. Project configurations are inferred because writing .slnx files is not supported yet; only .sln files can be edited.</div>'
        : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">
    ${(0, webviewUi_1.getWebviewUiStyles)()}
    html,
    body {
      min-height: 100%;
      margin: 0;
      color: var(--ui-text);
      background: var(--ui-bg);
    }
    body {
      overflow: auto;
    }
    .solution-shell {
      min-height: 100vh;
      background: var(--ui-bg);
    }
    .titlebar {
      display: flex;
      align-items: center;
      min-height: 44px;
      padding: 0 var(--ui-space-4);
      border-bottom: 1px solid var(--ui-border);
      background: var(--vscode-editorGroupHeader-tabsBackground, var(--ui-bg));
    }
    h1 {
      min-width: 0;
      margin: 0;
      overflow: hidden;
      font-size: 14px;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .solution-content {
      width: min(1120px, 100%);
      margin: 0 auto;
      padding: var(--ui-space-5);
    }
    .config-row {
      display: flex;
      align-items: center;
      gap: var(--ui-space-3);
      margin-bottom: var(--ui-space-4);
      padding-bottom: var(--ui-space-4);
      border-bottom: 1px solid var(--ui-border);
    }
    .config-row label {
      font-weight: 600;
    }
    select,
    .table select {
      min-height: var(--ui-control-height);
      padding: 3px 8px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, var(--ui-control-border));
      border-radius: var(--ui-radius);
    }
    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--ui-focus);
    }
    .table {
      overflow: hidden;
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius);
      background: var(--ui-surface);
    }
    .table-scroll {
      width: 100%;
      overflow-x: auto;
    }
    table {
      width: 100%;
      min-width: 760px;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--ui-border);
      text-align: left;
    }
    th {
      color: var(--ui-text-muted);
      background: var(--vscode-editorGroupHeader-tabsBackground, var(--ui-surface));
      font-weight: 600;
      white-space: nowrap;
    }
    tbody tr:hover {
      background: var(--ui-surface-hover);
    }
    tbody tr:last-child td {
      border-bottom: 0;
    }
    td.center,
    th.center {
      text-align: center;
    }
    td.deps {
      color: var(--vscode-textLink-foreground);
      text-align: right;
    }
    .notice,
    .hint {
      margin-bottom: var(--ui-space-3);
      padding: 8px 10px;
      border: 1px solid var(--ui-border);
      border-radius: var(--ui-radius);
    }
    .notice {
      color: var(--vscode-notificationsInfoIcon-foreground, var(--ui-text));
      background: var(--vscode-editorInfo-background, var(--ui-surface));
    }
    .hint {
      margin-top: var(--ui-space-3);
      margin-bottom: 0;
      color: var(--ui-text-muted);
      background: var(--ui-surface);
      font-size: 12px;
    }
    .empty {
      color: var(--ui-text-muted);
    }
    @media (max-width: 760px) {
      .solution-content {
        padding: var(--ui-space-4);
      }
      .config-row {
        align-items: stretch;
        flex-direction: column;
        gap: var(--ui-space-2);
      }
      .config-row select {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="solution-shell">
    <header class="titlebar">
      <h1>Solution Properties - ${escapeHtml(solution.name)}</h1>
    </header>
    <main class="solution-content">
      ${noticeMarkup}
      <div class="config-row">
        <label for="solutionConfiguration">Solution configuration:</label>
        <select id="solutionConfiguration">${configurationOptions}</select>
      </div>
      <div class="table">
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Configuration and Platform</th>
                <th class="center">Build</th>
                <th class="center">Deploy</th>
                <th>Dependencies</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="5" class="empty">No projects.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      ${slnxNotice}
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('solutionConfiguration').addEventListener('change', (event) => {
      vscode.postMessage({ command: 'selectConfiguration', solutionConfiguration: event.target.value });
    });
    for (const element of document.querySelectorAll('[data-field]')) {
      element.addEventListener('change', (event) => {
        const target = event.currentTarget;
        const value = target.type === 'checkbox' ? target.checked : target.value;
        vscode.postMessage({
          command: 'change',
          projectGuid: target.getAttribute('data-guid') || '',
          projectPath: target.getAttribute('data-path') || '',
          solutionConfiguration: target.getAttribute('data-solution-config'),
          field: target.getAttribute('data-field'),
          value
        });
      });
    }
  </script>
</body>
</html>`;
}
function renderProjectRow(project, model, selectedConfiguration) {
    const entry = project.configurations.find((item) => item.solutionConfiguration === selectedConfiguration)
        || project.configurations[0]
        || { solutionConfiguration: selectedConfiguration, configPlatform: selectedConfiguration, build: false, deploy: false };
    const dataAttributes = `data-guid="${escapeAttribute(project.guid || '')}" data-path="${escapeAttribute(project.relativePath || '')}" data-solution-config="${escapeAttribute(entry.solutionConfiguration)}"`;
    const readOnly = model.format === 'slnx' ? ' disabled' : '';
    const options = buildConfigPlatformOptions(model.configPlatformOptions, entry.configPlatform)
        .map((option) => `<option value="${escapeAttribute(option)}"${option === entry.configPlatform ? ' selected' : ''}>${escapeHtml(option)}</option>`)
        .join('');
    return `<tr>
    <td>${escapeHtml(project.name)}</td>
    <td><select ${dataAttributes} data-field="configPlatform"${readOnly}>${options}</select></td>
    <td class="center"><input type="checkbox" ${dataAttributes} data-field="build"${entry.build ? ' checked' : ''}${readOnly} /></td>
    <td class="center"><input type="checkbox" ${dataAttributes} data-field="deploy"${entry.deploy ? ' checked' : ''}${readOnly} /></td>
    <td class="deps">${Number(project.dependencyCount || 0)}</td>
  </tr>`;
}
function buildConfigPlatformOptions(options, currentValue) {
    const list = Array.isArray(options) ? [...options] : [];
    if (currentValue && !list.includes(currentValue)) {
        list.unshift(currentValue);
    }
    return list;
}
function getNonce() {
    return crypto.randomBytes(16).toString('hex');
}
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}
const __test = {
    getSolutionPropertiesHtml
};
exports.__test = __test;
//# sourceMappingURL=solutionPropertiesView.js.map