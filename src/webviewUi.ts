type WebviewIconName = 'close' | 'refresh' | 'remove' | 'trash' | 'upgrade';

const iconPaths: Record<WebviewIconName, string> = {
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
  refresh: '<path d="M16.5 6.5V3m0 3.5H13M16.2 12a6.5 6.5 0 1 1-1.6-6.4"/>',
  remove: '<path d="M5 5l10 10M15 5 5 15"/>',
  trash: '<path d="M4.5 6.5h11M8 4h4m-6 2.5.8 10h6.4l.8-10M8.5 9v5m3-5v5"/>',
  upgrade: '<path d="M5 15 15 5m-6 0h6v6"/>'
};

function getWebviewUiStyles(): string {
  return `
    :root {
      color-scheme: light dark;
      --ui-bg: var(--vscode-editor-background);
      --ui-surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --ui-surface-raised: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      --ui-surface-hover: var(--vscode-list-hoverBackground);
      --ui-surface-selected: var(--vscode-list-activeSelectionBackground);
      --ui-text: var(--vscode-foreground);
      --ui-text-muted: var(--vscode-descriptionForeground);
      --ui-text-selected: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
      --ui-border: var(--vscode-panel-border, var(--vscode-contrastBorder, transparent));
      --ui-control-bg: var(--vscode-input-background);
      --ui-control-fg: var(--vscode-input-foreground);
      --ui-control-border: var(--vscode-input-border, var(--ui-border));
      --ui-focus: var(--vscode-focusBorder);
      --ui-radius: 3px;
      --ui-control-height: 28px;
      --ui-space-1: 4px;
      --ui-space-2: 8px;
      --ui-space-3: 12px;
      --ui-space-4: 16px;
      --ui-space-5: 24px;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--ui-text);
      background: var(--ui-bg);
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    button,
    input,
    select,
    textarea {
      font: inherit;
    }

    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible,
    [tabindex]:focus-visible {
      outline: 1px solid var(--ui-focus);
      outline-offset: 1px;
    }

    button:disabled,
    input:disabled,
    select:disabled,
    textarea:disabled {
      cursor: not-allowed;
      opacity: .5;
    }

    .ui-icon {
      display: block;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.5;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }

    @media (forced-colors: active) {
      button,
      input,
      select,
      textarea,
      [tabindex] {
        border-color: CanvasText;
      }

      button:focus-visible,
      input:focus-visible,
      select:focus-visible,
      textarea:focus-visible,
      [tabindex]:focus-visible {
        outline: 2px solid Highlight;
      }
    }
  `;
}

function getWebviewIcon(name: WebviewIconName): string {
  return `<svg class="ui-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${iconPaths[name]}</svg>`;
}

export {
  getWebviewIcon,
  getWebviewUiStyles
};
