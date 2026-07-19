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
exports.showSolutionProperties = showSolutionProperties;
// @ts-nocheck
const crypto = __importStar(require("crypto"));
const vscode = __importStar(require("vscode"));
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
        ? '<div class="hint">.slnx: bu görünüm salt-okunurdur. Proje yapılandırması çıkarımla gösterilir; .slnx yazma henüz desteklenmiyor (yalnızca .sln düzenlenebilir).</div>'
        : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    h1 { font-size: 1.2rem; margin: 0 0 16px; }
    .config-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .config-row label { font-weight: 600; }
    select, .table select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 4px 8px; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    td.center, th.center { text-align: center; }
    td.deps { text-align: right; color: var(--vscode-textLink-foreground); }
    .notice { margin-bottom: 12px; padding: 6px 10px; background: var(--vscode-editorInfo-background, rgba(0,120,215,0.1)); border-radius: 4px; }
    .hint { margin: 8px 0 0; color: var(--vscode-descriptionForeground); font-size: 0.85rem; }
    .empty { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h1>Solution Properties - ${escapeHtml(solution.name)}</h1>
  ${noticeMarkup}
  <div class="config-row">
    <label for="solutionConfiguration">Solution configuration:</label>
    <select id="solutionConfiguration">${configurationOptions}</select>
  </div>
  <div class="table">
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
  ${slnxNotice}
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
//# sourceMappingURL=solutionPropertiesView.js.map