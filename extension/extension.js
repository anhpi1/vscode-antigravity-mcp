'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');

const MD_PREVIEW_VIEW_TYPE = 'vscodeAntigravityMcp.markdownPreview';
const previewPanels = new Map();

const STATE_DIR = process.env.ANTIGRAVITY_VSCODE_BRIDGE_DIR || path.join(os.homedir(), '.antigravity-vscode-bridge');
const WINDOWS_DIR = path.join(STATE_DIR, 'windows');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WINDOW_FILE = path.join(WINDOWS_DIR, `bridge-window-${process.pid}.json`);

const MAX_READ_LINES = 800;
const MAX_READ_BYTES = 46080;

let server = null;
let boundPort = null;
let lastInteractionAt = new Date().toISOString();
let knownRemoteAuthority = null;

let taskCounter = 0;
const tasks = new Map();
let sharedAgentTerminal = null;

function detectRemoteAuthority() {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    if (f.uri.scheme === 'vscode-remote' && f.uri.authority) {
      knownRemoteAuthority = f.uri.authority;
      return knownRemoteAuthority;
    }
  }
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'vscode-remote' && ed.document.uri.authority) {
    knownRemoteAuthority = ed.document.uri.authority;
    return knownRemoteAuthority;
  }
  const activeTabResult = getActiveTabInfo();
  if (activeTabResult && activeTabResult.uri && activeTabResult.uri.scheme === 'vscode-remote' && activeTabResult.uri.authority) {
    knownRemoteAuthority = activeTabResult.uri.authority;
    return knownRemoteAuthority;
  }
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme === 'vscode-remote' && doc.uri.authority) {
      knownRemoteAuthority = doc.uri.authority;
      return knownRemoteAuthority;
    }
  }
  return knownRemoteAuthority;
}

function formatUriPath(uri) {
  if (!uri) return null;
  if (uri.scheme === 'file') return uri.fsPath;
  if (uri.scheme === 'vscode-remote') return uri.path;
  return uri.toString();
}

function resolveInputUri(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Path is required.');
  }
  const trimmed = inputPath.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || trimmed.startsWith('untitled:')) {
    return vscode.Uri.parse(trimmed);
  }
  const remoteAuth = detectRemoteAuthority();
  if (trimmed.startsWith('/') && (vscode.env.remoteName || remoteAuth)) {
    if (!remoteAuth) {
      throw new Error('Remote window authority not yet initialized.');
    }
    return vscode.Uri.from({
      scheme: 'vscode-remote',
      authority: remoteAuth,
      path: trimmed
    });
  }
  return vscode.Uri.file(trimmed);
}

function getParentUri(uri) {
  if (uri.scheme === 'file') {
    return vscode.Uri.file(path.dirname(uri.fsPath));
  }
  return uri.with({ path: path.posix.dirname(uri.path) });
}

function joinChildUri(dirUri, name) {
  if (dirUri.scheme === 'file') {
    return vscode.Uri.file(path.join(dirUri.fsPath, name));
  }
  return dirUri.with({ path: path.posix.join(dirUri.path, name) });
}

function resolvePreviewWebviewUri(tab) {
  const rawLabel = typeof tab.label === 'string' ? tab.label.trim() : '';
  const targetName = rawLabel.replace(/^Preview\s+/i, '').trim();
  if (!targetName) return null;

  const isWin = process.platform === 'win32';
  const norm = (s) => (isWin ? s.toLowerCase() : s);
  const want = norm(targetName);
  const candidates = new Map();

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-remote') continue;
    const p = formatUriPath(doc.uri);
    if (!p) continue;
    const base = doc.uri.scheme === 'file' ? path.basename(p) : path.posix.basename(p);
    if (norm(base) === want) {
      candidates.set(doc.uri.toString(), doc.uri);
    }
  }

  if (candidates.size === 1) {
    return Array.from(candidates.values())[0];
  }

  if (candidates.size === 0) {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (folder.uri.scheme !== 'file') continue;
      const direct = path.join(folder.uri.fsPath, targetName);
      if (fs.existsSync(direct)) {
        const uri = vscode.Uri.file(direct);
        candidates.set(uri.toString(), uri);
      }
    }
    if (candidates.size === 1) {
      return Array.from(candidates.values())[0];
    }
  }

  return null;
}

function inspectTab(tab, isActiveGroup = false) {
  const input = tab.input;
  let tabType = 'unknown';
  let viewType = null;
  let uri = null;
  let originalFilePath = null;
  let modifiedFilePath = null;

  if (input instanceof vscode.TabInputText) {
    tabType = 'text';
    uri = input.uri;
  } else if (input instanceof vscode.TabInputCustom) {
    tabType = 'custom';
    viewType = input.viewType || null;
    uri = input.uri;
  } else if (input instanceof vscode.TabInputTextDiff) {
    tabType = 'diff';
    originalFilePath = formatUriPath(input.original);
    modifiedFilePath = formatUriPath(input.modified);
    uri = input.modified || input.original;
  } else if (input instanceof vscode.TabInputNotebook) {
    tabType = 'notebook';
    viewType = input.notebookType || null;
    uri = input.uri;
  } else if (input instanceof vscode.TabInputNotebookDiff) {
    tabType = 'notebookDiff';
    viewType = input.notebookType || null;
    originalFilePath = formatUriPath(input.original);
    modifiedFilePath = formatUriPath(input.modified);
    uri = input.modified || input.original;
  } else if (input instanceof vscode.TabInputWebview) {
    tabType = 'webview';
    viewType = input.viewType || null;
    if (viewType && /markdown\.preview/i.test(viewType)) {
      uri = resolvePreviewWebviewUri(tab);
    }
  } else if (input instanceof vscode.TabInputTerminal) {
    tabType = 'terminal';
  } else if (input && input.uri) {
    uri = input.uri;
    viewType = input.viewType || null;
  }

  const filePath = formatUriPath(uri);
  const uriStr = uri ? uri.toString() : null;
  const info = {
    label: tab.label,
    isActive: tab.isActive,
    isActiveGroup: Boolean(isActiveGroup),
    isPreview: Boolean(tab.isPreview),
    isDirty: tab.isDirty,
    tabType,
    viewType,
    filePath,
    uri: uriStr
  };
  if (originalFilePath || modifiedFilePath) {
    info.originalFilePath = originalFilePath;
    info.modifiedFilePath = modifiedFilePath;
  }
  return { info, uri };
}

function getActiveTabInfo() {
  try {
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    if (activeGroup && activeGroup.activeTab) {
      return inspectTab(activeGroup.activeTab, true);
    }
  } catch (_) {}
  return null;
}

function collectOpenTabs() {
  const tabs = [];
  try {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        tabs.push(inspectTab(tab, group.isActive).info);
      }
    }
  } catch (_) {}
  return tabs;
}

function getActivePreviewEntry(activeTab) {
  for (const [panel, entry] of previewPanels.entries()) {
    if (panel.active) return entry;
  }
  if (activeTab && activeTab.viewType === MD_PREVIEW_VIEW_TYPE && activeTab.uri) {
    for (const entry of previewPanels.values()) {
      if (entry.uri && entry.uri.toString() === activeTab.uri) return entry;
    }
  }
  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildMarkdownPreviewHtml(webview, bodyHtml, nonce) {
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: http: data:`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--vscode-font-size, 14px);
      line-height: 1.65;
      padding: 20px 32px 60px;
      max-width: 960px;
      margin: 0 auto;
      word-wrap: break-word;
    }
    a { color: var(--vscode-textLink-foreground); }
    h1, h2, h3, h4 {
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      padding-bottom: 0.25em;
    }
    h3, h4 { border-bottom: none; }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      background-color: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 0.15em 0.35em;
      border-radius: 3px;
    }
    pre {
      background-color: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
      padding: 12px 14px;
      border-radius: 4px;
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; }
    blockquote {
      margin: 0.8em 0;
      padding: 0.4em 1em;
      background-color: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1));
      border-left: 4px solid var(--vscode-textBlockQuote-border, #007acc);
    }
    table { border-collapse: collapse; margin: 1em 0; width: 100%; }
    th, td {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      padding: 6px 10px;
      text-align: left;
    }
    th { background-color: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12)); }
    img { max-width: 100%; height: auto; }
    hr { border: 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
  </style>
</head>
<body>
  <div id="content">${bodyHtml}</div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      let timer = null;
      let lastText = '';
      function reportSelection() {
        const sel = window.getSelection();
        const text = sel ? sel.toString() : '';
        if (text === lastText) return;
        lastText = text;
        vscode.postMessage({ type: 'selection', text });
      }
      document.addEventListener('selectionchange', () => {
        clearTimeout(timer);
        timer = setTimeout(reportSelection, 80);
      });
      document.addEventListener('mouseup', reportSelection);
      document.addEventListener('keyup', reportSelection);
    })();
  </script>
</body>
</html>`;
}

function createMarkdownPreviewProvider() {
  return {
    async resolveCustomTextEditor(document, webviewPanel) {
      const localRoots = (vscode.workspace.workspaceFolders || []).map(f => f.uri);
      try {
        localRoots.push(getParentUri(document.uri));
      } catch (_) {}

      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: localRoots
      };

      const entry = {
        uri: document.uri,
        filePath: formatUriPath(document.uri),
        selectedText: ''
      };
      previewPanels.set(webviewPanel, entry);

      const render = async () => {
        let renderedHtml;
        try {
          const out = await vscode.commands.executeCommand('markdown.api.render', document.getText());
          renderedHtml = typeof out === 'string' ? out : `<pre>${escapeHtml(document.getText())}</pre>`;
        } catch (_) {
          renderedHtml = `<pre>${escapeHtml(document.getText())}</pre>`;
        }
        const nonce = crypto.randomBytes(16).toString('hex');
        webviewPanel.webview.html = buildMarkdownPreviewHtml(webviewPanel.webview, renderedHtml, nonce);
      };

      await render();
      saveState(webviewPanel.active);

      let renderTimer = null;
      const changeDisp = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => { render(); }, 150);
      });

      const msgDisp = webviewPanel.webview.onDidReceiveMessage((msg) => {
        if (msg && msg.type === 'selection') {
          entry.selectedText = typeof msg.text === 'string' ? msg.text : '';
          saveState(true);
        }
      });

      const viewDisp = webviewPanel.onDidChangeViewState(() => {
        saveState(webviewPanel.active);
      });

      webviewPanel.onDidDispose(() => {
        clearTimeout(renderTimer);
        changeDisp.dispose();
        msgDisp.dispose();
        viewDisp.dispose();
        previewPanels.delete(webviewPanel);
        saveState(false);
      });
    }
  };
}

function collectEditorState() {
  const remoteAuth = detectRemoteAuthority();
  const editor = vscode.window.activeTextEditor;
  const activeTabResult = getActiveTabInfo();
  const activeTab = activeTabResult ? activeTabResult.info : null;
  const activeTabUri = activeTabResult ? activeTabResult.uri : null;
  const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => ({
    name: f.name,
    scheme: f.uri.scheme,
    authority: f.uri.authority || null,
    path: formatUriPath(f.uri),
    uri: f.uri.toString()
  }));

  const base = {
    bridgeVersion: '1.0.0',
    pid: process.pid,
    port: boundPort,
    updatedAt: new Date().toISOString(),
    lastInteractionAt,
    windowFocused: vscode.window.state.focused,
    isRemote: Boolean(vscode.env.remoteName),
    remoteName: vscode.env.remoteName || null,
    remoteAuthority: remoteAuth,
    workspaceFolders,
    openTabs: collectOpenTabs()
  };

  if (!editor) {
    const previewEntry = activeTab && activeTab.viewType === MD_PREVIEW_VIEW_TYPE
      ? getActivePreviewEntry(activeTab)
      : null;
    if (previewEntry) {
      const selText = previewEntry.selectedText || '';
      return {
        ...base,
        hasActiveEditor: false,
        editorKind: 'markdown-preview',
        activeTab,
        uriScheme: activeTabUri ? activeTabUri.scheme : null,
        remoteAuthority: (activeTabUri && activeTabUri.authority) || remoteAuth,
        languageId: 'markdown',
        filePath: activeTab ? activeTab.filePath : previewEntry.filePath,
        fullUri: activeTab ? activeTab.uri : (previewEntry.uri ? previewEntry.uri.toString() : null),
        cursor: null,
        selection: {
          isEmpty: selText.length === 0,
          start: null,
          end: null,
          selectedText: selText
        }
      };
    }
    return {
      ...base,
      hasActiveEditor: false,
      editorKind: activeTab ? activeTab.tabType : 'none',
      activeTab,
      uriScheme: activeTabUri ? activeTabUri.scheme : null,
      remoteAuthority: (activeTabUri && activeTabUri.authority) || remoteAuth,
      filePath: activeTab ? activeTab.filePath : null,
      fullUri: activeTab ? activeTab.uri : null,
      cursor: null,
      selection: null
    };
  }

  const doc = editor.document;
  const sel = editor.selection;
  const selectedText = doc.getText(sel);

  return {
    ...base,
    hasActiveEditor: true,
    editorKind: 'text',
    activeTab,
    uriScheme: doc.uri.scheme,
    remoteAuthority: doc.uri.authority || remoteAuth,
    filePath: formatUriPath(doc.uri),
    fullUri: doc.uri.toString(),
    languageId: doc.languageId,
    isDirty: doc.isDirty,
    lineCount: doc.lineCount,
    cursor: {
      line: sel.active.line + 1,
      column: sel.active.character + 1
    },
    selection: {
      isEmpty: sel.isEmpty,
      start: { line: sel.start.line + 1, column: sel.start.character + 1 },
      end: { line: sel.end.line + 1, column: sel.end.character + 1 },
      selectedText
    }
  };
}

function writeJsonAtomic(targetPath, data) {
  const tmpFile = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, targetPath);
}

function saveState(markInteraction = false) {
  try {
    if (markInteraction) {
      lastInteractionAt = new Date().toISOString();
    }
    fs.mkdirSync(WINDOWS_DIR, { recursive: true });
    const state = collectEditorState();
    writeJsonAtomic(WINDOW_FILE, state);
    if (state.windowFocused || markInteraction) {
      writeJsonAtomic(STATE_FILE, state);
    }
    return state;
  } catch (_) {
    return null;
  }
}

function findOpenDocument(uri) {
  const target = uri.toString();
  return vscode.workspace.textDocuments.find(d => d.uri.toString() === target) || null;
}

async function rpcReadFile(args) {
  const uri = resolveInputUri(args.Path);
  const openDoc = findOpenDocument(uri);
  let rawText;
  if (openDoc) {
    rawText = openDoc.getText();
  } else {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength === 0) {
      return 'File is empty';
    }
    rawText = Buffer.from(bytes).toString('utf8');
  }

  if (rawText.length === 0) {
    return 'File is empty';
  }

  const lines = rawText.split(/\r?\n/);
  const totalLines = lines.length;

  const startLine = Math.max(1, args.StartLine ? Number(args.StartLine) : 1);
  if (startLine > totalLines) {
    return `StartLine (${startLine}) exceeds total lines in file (${totalLines}).`;
  }

  const requestedEnd = args.EndLine ? Number(args.EndLine) : (startLine + MAX_READ_LINES - 1);
  const endLine = Math.min(totalLines, requestedEnd, startLine + MAX_READ_LINES - 1);

  const selectedLines = [];
  for (let i = startLine; i <= endLine; i++) {
    selectedLines.push(`${i}: ${lines[i - 1]}`);
  }

  const fullBlock = selectedLines.join('\n');
  const fullBuf = Buffer.from(fullBlock, 'utf8');
  const byteOffset = Math.max(0, args.ByteOffset ? Number(args.ByteOffset) : 0);

  if (byteOffset > 0 || fullBuf.byteLength > MAX_READ_BYTES) {
    const slice = fullBuf.subarray(byteOffset, byteOffset + MAX_READ_BYTES).toString('utf8');
    const remaining = Math.max(0, fullBuf.byteLength - (byteOffset + MAX_READ_BYTES));
    const truncNote = remaining > 0
      ? `\n... [Truncated at ${MAX_READ_BYTES} bytes. ${remaining} bytes remaining in range; pass ByteOffset=${byteOffset + MAX_READ_BYTES} to continue]`
      : '';
    return `Showing lines ${startLine}-${endLine} of ${totalLines} (byte offset ${byteOffset})\n${slice}${truncNote}`;
  }

  return `Showing lines ${startLine}-${endLine} of ${totalLines}\n${fullBlock}`;
}

async function rpcWriteFile(args) {
  const uri = resolveInputUri(args.Path);
  const content = typeof args.Content === 'string' ? args.Content : '';
  const overwrite = Boolean(args.Overwrite);
  const append = Boolean(args.Append);

  if (overwrite && append) {
    throw new Error('Cannot combine Overwrite=true with Append=true.');
  }

  let exists = false;
  try {
    await vscode.workspace.fs.stat(uri);
    exists = true;
  } catch (_) {
    exists = false;
  }

  if (exists && !overwrite && !append) {
    throw new Error(`File already exists: ${formatUriPath(uri)}. Set Overwrite=true or Append=true.`);
  }

  const parentUri = getParentUri(uri);
  await vscode.workspace.fs.createDirectory(parentUri);

  const openDoc = findOpenDocument(uri);
  if (openDoc) {
    const edit = new vscode.WorkspaceEdit();
    if (append) {
      const lastLine = openDoc.lineCount - 1;
      const endPos = openDoc.lineAt(lastLine).range.end;
      edit.insert(uri, endPos, content);
    } else {
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        openDoc.lineAt(openDoc.lineCount - 1).range.end
      );
      edit.replace(uri, fullRange, content);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`Failed to apply WorkspaceEdit to ${formatUriPath(uri)}`);
    }
    await openDoc.save();
    return exists ? (append ? 'Appended to file and saved.' : 'Overwrote file and saved.') : 'Created file.';
  }

  if (append && exists) {
    const existingBytes = await vscode.workspace.fs.readFile(uri);
    const combined = Buffer.concat([Buffer.from(existingBytes), Buffer.from(content, 'utf8')]);
    await vscode.workspace.fs.writeFile(uri, combined);
    return 'Appended to file.';
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  return exists ? 'Overwrote file.' : 'Created file.';
}

async function rpcEditFile(args) {
  const uri = resolveInputUri(args.Path);
  const target = args.Target;
  const replacement = typeof args.Replacement === 'string' ? args.Replacement : '';

  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Target must be a non-empty string.');
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const docEol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

  let searchStr = target;
  let replaceStr = replacement;

  if (!text.includes(searchStr)) {
    const normTarget = target.replace(/\r?\n/g, docEol);
    if (text.includes(normTarget)) {
      searchStr = normTarget;
      replaceStr = replacement.replace(/\r?\n/g, docEol);
    } else {
      throw new Error(`Target string not found in ${formatUriPath(uri)}. Make sure Target matches exact file text including whitespace.`);
    }
  }

  const ranges = [];
  let idx = 0;
  while (true) {
    const found = text.indexOf(searchStr, idx);
    if (found === -1) break;
    ranges.push(new vscode.Range(doc.positionAt(found), doc.positionAt(found + searchStr.length)));
    idx = found + searchStr.length;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const r of ranges) {
    edit.replace(uri, r, replaceStr);
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    throw new Error(`Failed to apply edit to ${formatUriPath(uri)}.`);
  }
  await doc.save();
  return `Edited ${formatUriPath(uri)} (${ranges.length} occurrence${ranges.length > 1 ? 's' : ''} replaced and saved).`;
}

async function rpcListDir(args) {
  const uri = resolveInputUri(args.DirectoryPath);
  const entries = await vscode.workspace.fs.readDirectory(uri);

  const dirs = [];
  const files = [];

  for (const [name, type] of entries) {
    const isDir = (type & vscode.FileType.Directory) !== 0;
    if (isDir) {
      dirs.push({ name });
    } else {
      let size = null;
      try {
        const st = await vscode.workspace.fs.stat(joinChildUri(uri, name));
        size = st.size;
      } catch (_) {}
      files.push({ name, size });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const lines = [`Directory: ${formatUriPath(uri)}`];
  for (const d of dirs) lines.push(`[DIR]  ${d.name}/`);
  for (const f of files) {
    const sz = f.size !== null ? ` (${f.size} bytes)` : '';
    lines.push(`[FILE] ${f.name}${sz}`);
  }
  if (dirs.length === 0 && files.length === 0) {
    lines.push('(empty directory)');
  }
  return lines.join('\n');
}

function globToRegExp(glob, caseInsensitive = true) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (glob[i] === '/' || glob[i] === '\\') i++;
        continue;
      }
      re += '[^/\\\\]*';
    } else if (c === '?') {
      re += '[^/\\\\]';
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i++;
  }
  re += '$';
  return new RegExp(re, caseInsensitive ? 'i' : '');
}

const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', '.vs', '__pycache__', '.venv', 'venv']);

async function rpcFindByName(args) {
  const rootUri = resolveInputUri(args.SearchDirectory);
  const maxDepth = args.MaxDepth ? Number(args.MaxDepth) : 10;
  const wantType = (args.Type || 'any').toLowerCase();
  const fullPathMatch = Boolean(args.FullPath);
  const extensions = Array.isArray(args.Extensions)
    ? args.Extensions.map(e => e.replace(/^\./, '').toLowerCase())
    : null;
  const patternRe = args.Pattern ? globToRegExp(args.Pattern, true) : null;
  const excludeRes = Array.isArray(args.Excludes) ? args.Excludes.map(p => globToRegExp(p, true)) : [];

  const matches = [];
  const MAX_RESULTS = 50;

  async function walk(currUri, relPosix, depth) {
    if (depth > maxDepth || matches.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = await vscode.workspace.fs.readDirectory(currUri);
    } catch (_) {
      return;
    }

    for (const [name, type] of entries) {
      if (matches.length >= MAX_RESULTS) break;
      const isDir = (type & vscode.FileType.Directory) !== 0;
      const childRel = relPosix ? `${relPosix}/${name}` : name;

      if (isDir && DEFAULT_IGNORED_DIRS.has(name)) continue;
      if (excludeRes.some(r => r.test(childRel) || r.test(name))) continue;

      const childUri = joinChildUri(currUri, name);
      const typeOk =
        wantType === 'any' ||
        (wantType === 'directory' && isDir) ||
        (wantType === 'file' && !isDir);

      let extOk = true;
      if (extensions && extensions.length > 0) {
        if (isDir) {
          extOk = false;
        } else {
          const ext = path.extname(name).replace(/^\./, '').toLowerCase();
          extOk = extensions.includes(ext);
        }
      }

      const targetToTest = fullPathMatch ? childRel : name;
      const patOk = patternRe ? patternRe.test(targetToTest) : true;

      if (typeOk && extOk && patOk) {
        matches.push(`${isDir ? '[DIR] ' : ''}${formatUriPath(childUri)}`);
      }

      if (isDir && depth < maxDepth) {
        await walk(childUri, childRel, depth + 1);
      }
    }
  }

  await walk(rootUri, '', 1);
  if (matches.length === 0) {
    return `No matches found in ${formatUriPath(rootUri)}.`;
  }
  return `Found ${matches.length}${matches.length >= MAX_RESULTS ? '+' : ''} result(s):\n` + matches.join('\n');
}

async function rpcGrepSearch(args) {
  const targetUri = resolveInputUri(args.SearchPath);
  const query = args.Query;
  if (!query || typeof query !== 'string') {
    throw new Error('Query is required.');
  }
  const isRegex = Boolean(args.IsRegex);
  const caseInsensitive = Boolean(args.CaseInsensitive);
  const matchPerLine = args.MatchPerLine !== false;
  const includeRes = Array.isArray(args.Includes) ? args.Includes.map(g => globToRegExp(g, true)) : null;

  const flags = caseInsensitive ? 'i' : '';
  const regex = isRegex
    ? new RegExp(query, flags)
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

  const results = [];
  const MAX_MATCHES = 50;

  async function searchSingleFile(fileUri, relName) {
    if (results.length >= MAX_MATCHES) return;
    if (includeRes && !includeRes.some(r => r.test(relName) || r.test(path.posix.basename(relName)))) {
      return;
    }
    try {
      const st = await vscode.workspace.fs.stat(fileUri);
      if (st.size > 2 * 1024 * 1024) return;
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const checkLen = Math.min(bytes.byteLength, 512);
      for (let i = 0; i < checkLen; i++) {
        if (bytes[i] === 0) return;
      }
      const text = Buffer.from(bytes).toString('utf8');
      if (!matchPerLine) {
        if (regex.test(text)) results.push(formatUriPath(fileUri));
        return;
      }
      const lines = text.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx++) {
        if (regex.test(lines[idx])) {
          const snippet = lines[idx].length > 240 ? lines[idx].slice(0, 240) + '...' : lines[idx];
          results.push(`${formatUriPath(fileUri)}:${idx + 1}: ${snippet}`);
          if (results.length >= MAX_MATCHES) break;
        }
      }
    } catch (_) {}
  }

  async function walkDir(dirUri, relPrefix, depth) {
    if (depth > 12 || results.length >= MAX_MATCHES) return;
    let entries;
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch (_) {
      return;
    }
    for (const [name, type] of entries) {
      if (results.length >= MAX_MATCHES) break;
      const isDir = (type & vscode.FileType.Directory) !== 0;
      if (isDir && DEFAULT_IGNORED_DIRS.has(name)) continue;
      const childRel = relPrefix ? `${relPrefix}/${name}` : name;
      const childUri = joinChildUri(dirUri, name);
      if (isDir) {
        await walkDir(childUri, childRel, depth + 1);
      } else {
        await searchSingleFile(childUri, childRel);
      }
    }
  }

  const stat = await vscode.workspace.fs.stat(targetUri);
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    await walkDir(targetUri, '', 1);
  } else {
    await searchSingleFile(targetUri, path.basename(formatUriPath(targetUri) || ''));
  }

  if (results.length === 0) {
    return `No matches found for "${query}" in ${formatUriPath(targetUri)}.`;
  }
  return `Found ${results.length}${results.length >= MAX_MATCHES ? '+' : ''} match(es):\n` + results.join('\n');
}

async function rpcOpenFile(args) {
  const uri = resolveInputUri(args.Path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: args.Preview !== undefined ? Boolean(args.Preview) : false,
    preserveFocus: false
  });

  if (args.StartLine) {
    const sLine = Math.max(0, Number(args.StartLine) - 1);
    const sCol = Math.max(0, (args.StartColumn ? Number(args.StartColumn) : 1) - 1);
    const eLine = args.EndLine ? Math.max(0, Number(args.EndLine) - 1) : sLine;
    const eCol = args.EndColumn ? Math.max(0, Number(args.EndColumn) - 1) : sCol;
    const sel = new vscode.Selection(sLine, sCol, eLine, eCol);
    editor.selection = sel;
    editor.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  saveState(true);
  return `Opened ${formatUriPath(uri)} in VS Code (${editor.selection.active.line + 1}:${editor.selection.active.character + 1}).`;
}

async function rpcGetDiagnostics(args) {
  const sevMap = {
    [vscode.DiagnosticSeverity.Error]: 'Error',
    [vscode.DiagnosticSeverity.Warning]: 'Warning',
    [vscode.DiagnosticSeverity.Information]: 'Information',
    [vscode.DiagnosticSeverity.Hint]: 'Hint'
  };
  const filterSev = args && args.Severity ? String(args.Severity).toLowerCase() : null;

  let tuples;
  if (args && args.Path) {
    const uri = resolveInputUri(args.Path);
    tuples = [[uri, vscode.languages.getDiagnostics(uri)]];
  } else {
    tuples = vscode.languages.getDiagnostics();
  }

  const out = [];
  for (const [uri, diags] of tuples) {
    for (const d of diags) {
      const sName = sevMap[d.severity] || 'Unknown';
      if (filterSev && sName.toLowerCase() !== filterSev) continue;
      out.push({
        filePath: formatUriPath(uri),
        severity: sName,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        source: d.source || null,
        code: typeof d.code === 'object' && d.code !== null ? d.code.value : (d.code ?? null),
        message: d.message
      });
    }
  }
  return JSON.stringify({ count: out.length, diagnostics: out }, null, 2);
}

async function rpcExecuteCommand(args) {
  if (!args || !args.Command) {
    throw new Error('Command is required.');
  }
  const cmdArgs = Array.isArray(args.Args) ? args.Args : [];
  const res = await vscode.commands.executeCommand(args.Command, ...cmdArgs);
  return JSON.stringify({ executed: args.Command, result: res ?? null }, null, 2);
}

function cleanTerminalOutput(raw) {
  return raw
    .replace(/\x1b\]633;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n/g, '\n');
}

async function getOrCreateShellIntegratedTerminal() {
  if (sharedAgentTerminal && sharedAgentTerminal.exitStatus === undefined) {
    return sharedAgentTerminal;
  }
  sharedAgentTerminal = vscode.window.createTerminal({ name: 'Antigravity MCP' });
  if (sharedAgentTerminal.shellIntegration) {
    return sharedAgentTerminal;
  }
  return await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        disp.dispose();
        resolve(sharedAgentTerminal);
      }
    }, 3000);
    const disp = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === sharedAgentTerminal && !settled) {
        settled = true;
        clearTimeout(timer);
        disp.dispose();
        resolve(sharedAgentTerminal);
      }
    });
  });
}

function formatTaskResult(task, timedOut) {
  if (timedOut && task.status === 'running') {
    return [
      `Task ID: ${task.id}`,
      `Created At: ${task.createdAt}`,
      `Status: running in background (use manage_task with TaskId="${task.id}" to check status, send_input, or kill)`,
      task.output ? `\nOutput so far:\n${task.output}` : '\nNo output yet.'
    ].join('\n');
  }
  return [
    `Created At: ${task.createdAt}`,
    `Completed At: ${task.completedAt || new Date().toISOString()}`,
    `Command exited with code ${task.exitCode ?? 0}.`,
    '',
    task.output ? `Command output:\n${task.output}` : 'No output from the command.'
  ].join('\n');
}

async function rpcRunCommand(args) {
  const commandLine = args.CommandLine;
  if (!commandLine || typeof commandLine !== 'string') {
    throw new Error('CommandLine is required.');
  }
  const waitMs = Math.min(10000, Math.max(500, Number(args.WaitMsBeforeAsync || 5000)));
  const id = `vscode-task-${++taskCounter}`;
  const remoteAuth = detectRemoteAuthority();
  const folders = vscode.workspace.workspaceFolders || [];
  const defaultCwd = folders.length > 0 ? formatUriPath(folders[0].uri) : null;
  const cwd = args.Cwd || defaultCwd;

  const task = {
    id,
    summary: args.toolSummary || commandLine.slice(0, 50),
    commandLine,
    isDaemon: Boolean(args.IsDaemon),
    createdAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    exitCode: null,
    output: '',
    proc: null,
    terminal: null
  };
  tasks.set(id, task);

  if (vscode.env.remoteName || remoteAuth) {
    const term = await getOrCreateShellIntegratedTerminal();
    if (term && term.shellIntegration) {
      task.terminal = term;
      const fullCmd = cwd ? `cd "${cwd.replace(/"/g, '\\"')}" && ${commandLine}` : commandLine;
      const execution = term.shellIntegration.executeCommand(fullCmd);

      const donePromise = new Promise((resolve) => {
        const endDisp = vscode.window.onDidEndTerminalShellExecution((ev) => {
          if (ev.execution === execution) {
            endDisp.dispose();
            task.status = 'completed';
            task.exitCode = ev.exitCode ?? 0;
            task.completedAt = new Date().toISOString();
            resolve(false);
          }
        });

        (async () => {
          try {
            for await (const chunk of execution.read()) {
              task.output += cleanTerminalOutput(chunk);
              if (task.output.length > 200000) {
                task.output = task.output.slice(-200000);
              }
            }
          } catch (_) {}
        })();
      });

      const timedOut = await Promise.race([
        donePromise,
        new Promise(r => setTimeout(() => r(true), waitMs))
      ]);
      return formatTaskResult(task, timedOut);
    }

    if (remoteAuth && remoteAuth.startsWith('ssh-remote+')) {
      const sshHost = decodeURIComponent(remoteAuth.slice('ssh-remote+'.length));
      const remoteCmd = cwd ? `cd "${cwd.replace(/"/g, '\\"')}" && ${commandLine}` : commandLine;
      const sshBin = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
      return await spawnChildTask(task, sshBin, ['-T', sshHost, remoteCmd], undefined, waitMs);
    }
    if (remoteAuth && remoteAuth.startsWith('wsl+')) {
      const distro = decodeURIComponent(remoteAuth.slice('wsl+'.length));
      const remoteCmd = cwd ? `cd "${cwd.replace(/"/g, '\\"')}" && ${commandLine}` : commandLine;
      return await spawnChildTask(task, 'wsl.exe', ['-d', distro, '--', 'bash', '-lc', remoteCmd], undefined, waitMs);
    }
  }

  const localCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  if (process.platform === 'win32') {
    return await spawnChildTask(
      task,
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-Command', commandLine],
      localCwd,
      waitMs
    );
  }
  const shBin = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const shArgs = shBin.endsWith('bash') ? ['-lc', commandLine] : ['-c', commandLine];
  return await spawnChildTask(task, shBin, shArgs, localCwd, waitMs);
}

function spawnChildTask(task, file, cmdArgs, cwd, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    const child = cp.spawn(file, cmdArgs, {
      cwd,
      windowsHide: true
    });
    task.proc = child;

    const appendOut = (chunk) => {
      task.output += chunk.toString('utf8');
      if (task.output.length > 200000) {
        task.output = task.output.slice(-200000);
      }
    };

    child.stdout.on('data', appendOut);
    child.stderr.on('data', appendOut);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(formatTaskResult(task, true));
      }
    }, waitMs);

    child.on('error', (err) => {
      task.status = 'error';
      task.exitCode = -1;
      task.completedAt = new Date().toISOString();
      task.output += `\nSpawn error: ${err.message}`;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(formatTaskResult(task, false));
      }
    });

    child.on('close', (code) => {
      if (task.status === 'running') {
        task.status = 'completed';
      }
      task.exitCode = code ?? 0;
      task.completedAt = new Date().toISOString();
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(formatTaskResult(task, false));
      }
    });
  });
}

function killProcessCrossPlatform(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32') {
    try {
      cp.execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
      return;
    } catch (_) {}
  }
  try {
    proc.kill('SIGTERM');
  } catch (_) {}
}

async function rpcManageTask(args) {
  const action = args.Action;
  if (action === 'list') {
    const arr = Array.from(tasks.values()).map(t => ({
      TaskId: t.id,
      Summary: t.summary,
      Status: t.status,
      CreatedAt: t.createdAt,
      CompletedAt: t.completedAt,
      ExitCode: t.exitCode
    }));
    return JSON.stringify(arr, null, 2);
  }

  const task = tasks.get(args.TaskId);
  if (!task) {
    throw new Error(`Task not found in this window: ${args.TaskId}`);
  }

  if (action === 'status') {
    return JSON.stringify({
      TaskId: task.id,
      Summary: task.summary,
      Status: task.status,
      CreatedAt: task.createdAt,
      CompletedAt: task.completedAt,
      ExitCode: task.exitCode,
      RecentOutput: task.output.slice(-8000)
    }, null, 2);
  }

  if (action === 'send_input') {
    const input = args.Input ?? '';
    if (task.proc && task.proc.stdin && !task.proc.killed) {
      task.proc.stdin.write(input);
      return `Sent input to ${task.id}.`;
    }
    if (task.terminal) {
      task.terminal.sendText(input, false);
      return `Sent input to terminal task ${task.id}.`;
    }
    throw new Error(`Task ${task.id} cannot accept stdin.`);
  }

  if (action === 'kill') {
    task.status = 'killed';
    task.completedAt = new Date().toISOString();
    killProcessCrossPlatform(task.proc);
    if (task.terminal) {
      task.terminal.sendText('\x03', false);
    }
    return `Killed task ${task.id}.`;
  }

  throw new Error(`Unsupported Action: ${action}`);
}

async function dispatchRpc(method, args = {}) {
  switch (method) {
    case 'get_editor_state':
      return JSON.stringify(saveState(false) || collectEditorState(), null, 2);
    case 'read_file':
      return await rpcReadFile(args);
    case 'write_file':
      return await rpcWriteFile(args);
    case 'edit_file':
      return await rpcEditFile(args);
    case 'list_dir':
      return await rpcListDir(args);
    case 'find_by_name':
      return await rpcFindByName(args);
    case 'grep_search':
      return await rpcGrepSearch(args);
    case 'vscode_open_file':
      return await rpcOpenFile(args);
    case 'vscode_get_diagnostics':
      return await rpcGetDiagnostics(args);
    case 'vscode_execute_command':
      return await rpcExecuteCommand(args);
    case 'run_command':
      return await rpcRunCommand(args);
    case 'manage_task':
      return await rpcManageTask(args);
    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
}

function activate(context) {
  detectRemoteAuthority();

  server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/state')) {
      const state = saveState(false) || collectEditorState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state, null, 2));
      return;
    }

    if (req.method === 'POST' && req.url === '/rpc') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const result = await dispatchRpc(body.method, body.args || {});
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.on('error', () => {});

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      boundPort = addr.port;
    }
    saveState(vscode.window.state.focused);
  });

  saveState(vscode.window.state.focused);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MD_PREVIEW_VIEW_TYPE,
      createMarkdownPreviewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('vscodeAntigravityMcp.openMarkdownPreview', async (resourceUri) => {
      const activeTabInfo = getActiveTabInfo();
      const uri = resourceUri
        || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri)
        || (activeTabInfo && activeTabInfo.uri);
      if (!uri) {
        vscode.window.showWarningMessage('No active Markdown file to preview.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, MD_PREVIEW_VIEW_TYPE);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => saveState(true)),
    vscode.window.onDidChangeTextEditorSelection(() => saveState(true)),
    vscode.window.tabGroups.onDidChangeTabs(() => saveState(true)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => saveState(true)),
    vscode.window.onDidChangeWindowState((e) => saveState(e.focused)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      detectRemoteAuthority();
      saveState(false);
    }),
    vscode.commands.registerCommand('vscodeAntigravityMcp.dumpState', () => {
      const s = saveState(true);
      let msg = 'No active text editor';
      if (s && s.hasActiveEditor) {
        msg = `File: ${s.filePath} | Ln ${s.cursor.line}, Col ${s.cursor.column} | Selected: ${s.selection.selectedText.length} chars`;
      } else if (s && s.activeTab) {
        const target = s.filePath || s.activeTab.label;
        const kind = s.activeTab.viewType || s.activeTab.tabType;
        const selNote = s.selection ? ` | Selected: ${s.selection.selectedText.length} chars` : '';
        msg = `Active Tab (${kind}): ${target}${selNote}`;
      }
      vscode.window.showInformationMessage(msg);
    })
  );
}

function deactivate() {
  if (server) {
    try { server.close(); } catch (_) {}
    server = null;
  }
  try {
    if (fs.existsSync(WINDOW_FILE)) {
      fs.unlinkSync(WINDOW_FILE);
    }
  } catch (_) {}
}

module.exports = { activate, deactivate };
