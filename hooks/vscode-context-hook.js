#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const cp = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.gemini', 'config');
const MCP_CONFIG_PATH = path.join(CONFIG_DIR, 'mcp_config.json');
const BRIDGE_WINDOWS_DIR = process.env.ANTIGRAVITY_VSCODE_BRIDGE_DIR
  ? path.join(process.env.ANTIGRAVITY_VSCODE_BRIDGE_DIR, 'windows')
  : path.join(os.homedir(), '.antigravity-vscode-bridge', 'windows');
const LAST_TURN_FILE = path.join(__dirname, '.last-turn-state.json');
const DEBUG_LOG_FILE = path.join(__dirname, 'last-hook-run.json');
const MAX_SELECTED_CHARS = 16000;

let finished = false;
function finish(obj, debugMeta = {}) {
  if (finished) return;
  finished = true;
  try {
    fs.writeFileSync(
      DEBUG_LOG_FILE,
      JSON.stringify({ ranAt: new Date().toISOString(), ...debugMeta }, null, 2),
      'utf8'
    );
  } catch (_) {}
  process.stdout.write(JSON.stringify(obj || {}) + '\n');
  process.exit(0);
}

setTimeout(() => finish({}, { timedOut: true }), 4000).unref();

function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

function isNewUserTurn(payload) {
  const convId = payload.conversationId || '';
  const inv = typeof payload.invocationNum === 'number' ? payload.invocationNum : 1;
  const initSteps = payload.initialNumSteps;

  let prev = null;
  try {
    if (fs.existsSync(LAST_TURN_FILE)) {
      prev = JSON.parse(fs.readFileSync(LAST_TURN_FILE, 'utf8'));
    }
  } catch (_) {}

  const stateChanged =
    !prev ||
    prev.convId !== convId ||
    (initSteps !== undefined && initSteps !== prev.initSteps) ||
    (initSteps === undefined && payload.lastUserInput && payload.lastUserInput !== prev.lastUserInput);

  const shouldRun = inv <= 1 || stateChanged;

  if (shouldRun) {
    try {
      fs.writeFileSync(
        LAST_TURN_FILE,
        JSON.stringify({
          convId,
          initSteps,
          lastUserInput: payload.lastUserInput || '',
          updatedAt: new Date().toISOString()
        }),
        'utf8'
      );
    } catch (_) {}
  }
  return shouldRun;
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function httpGetJson(port, urlPath, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function queryLiveBridgeDirectly() {
  if (!fs.existsSync(BRIDGE_WINDOWS_DIR)) return null;
  const files = fs.readdirSync(BRIDGE_WINDOWS_DIR).filter((f) => f.startsWith('bridge-window-') && f.endsWith('.json'));
  if (files.length === 0) return null;

  const live = [];
  for (const f of files) {
    const full = path.join(BRIDGE_WINDOWS_DIR, f);
    try {
      const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!isPidAlive(meta.pid)) continue;
      if (meta.port) {
        try {
          const fresh = await httpGetJson(meta.port, '/state', 1200);
          live.push(fresh);
          continue;
        } catch (_) {}
      }
      live.push(meta);
    } catch (_) {}
  }

  if (live.length === 0) return null;
  live.sort((a, b) => {
    if (Boolean(a.windowFocused) !== Boolean(b.windowFocused)) {
      return a.windowFocused ? -1 : 1;
    }
    return String(b.lastInteractionAt || b.updatedAt || '').localeCompare(String(a.lastInteractionAt || a.updatedAt || ''));
  });
  return { activeOrLatestWindow: live[0], allWindows: live };
}

function callVscodeMcpFallback() {
  return new Promise((resolve) => {
    if (!fs.existsSync(MCP_CONFIG_PATH)) return resolve(null);
    let serverCfg;
    try {
      const cfg = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
      serverCfg = cfg && cfg.mcpServers && cfg.mcpServers.vscode;
    } catch (_) {
      return resolve(null);
    }
    if (!serverCfg || !serverCfg.command) return resolve(null);

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      resolve(val);
    };

    const child = cp.spawn(serverCfg.command, serverCfg.args || [], {
      env: { ...process.env, ...(serverCfg.env || {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    });

    const timer = setTimeout(() => done(null), 2000);
    timer.unref();

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) {
            clearTimeout(timer);
            const text = msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text;
            if (!text || msg.result.isError || text.startsWith('No running VS Code')) {
              done(null);
            } else {
              done(JSON.parse(text));
            }
          }
        } catch (_) {}
      }
    });

    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', () => { clearTimeout(timer); done(null); });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hook', version: '1.0.0' } }
      }) + '\n' +
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'vscode_get_editor_state', arguments: { AllWindows: true } }
      }) + '\n'
    );
  });
}

function formatWindowContext(win, indexLabel) {
  const mode = win.isRemote ? `Remote (${win.remoteAuthority || win.remoteName})` : 'Local';
  const focusTag = win.windowFocused ? ' [FOCUSED]' : '';
  const folders = Array.isArray(win.workspaceFolders) && win.workspaceFolders.length > 0
    ? win.workspaceFolders.map((f) => f.path).join(', ')
    : '(no workspace folder)';

  const lines = [
    `### ${indexLabel} — ${mode}${focusTag}`,
    `- Workspace: ${folders}`
  ];

  if (!win.hasActiveEditor || !win.filePath) {
    if (win.activeTab || win.filePath) {
      const tab = win.activeTab || {};
      const kind = tab.viewType || tab.tabType || win.editorKind || 'preview';
      lines.push(`- Active File Path: ${win.filePath || '(unresolved URI)'}`);
      if (tab.label) {
        lines.push(`- Active Tab: ${tab.label} (${kind})`);
      }
      if (win.selection && !win.selection.isEmpty && win.selection.selectedText) {
        let selText = win.selection.selectedText;
        let truncNote = '';
        if (selText.length > MAX_SELECTED_CHARS) {
          selText = selText.slice(0, MAX_SELECTED_CHARS);
          truncNote = `\n... [truncated, total ${win.selection.selectedText.length} chars]`;
        }
        lines.push(`- Selected Content:\n\`\`\`${win.languageId || ''}\n${selText}${truncNote}\n\`\`\``);
      } else if (win.selection) {
        lines.push('- Selected Content: (empty - nothing currently highlighted)');
      } else {
        lines.push('- Cursor/Selection: (not available in preview/non-text view)');
      }
      return lines.join('\n');
    }
    lines.push('- Cursor File Path: (no active text editor)');
    lines.push('- Selected Content: (none)');
    return lines.join('\n');
  }

  lines.push(`- Cursor File Path: ${win.filePath}`);
  if (win.cursor) {
    lines.push(`- Cursor Position: Line ${win.cursor.line}, Column ${win.cursor.column}`);
  }

  if (win.selection && !win.selection.isEmpty && win.selection.selectedText) {
    const s = win.selection.start;
    const e = win.selection.end;
    let selText = win.selection.selectedText;
    let truncNote = '';
    if (selText.length > MAX_SELECTED_CHARS) {
      selText = selText.slice(0, MAX_SELECTED_CHARS);
      truncNote = `\n... [truncated, total ${win.selection.selectedText.length} chars]`;
    }
    lines.push(`- Selection Range: Line ${s.line}, Col ${s.column} -> Line ${e.line}, Col ${e.column}`);
    lines.push(`- Selected Content:\n\`\`\`${win.languageId || ''}\n${selText}${truncNote}\n\`\`\``);
  } else {
    lines.push('- Selected Content: (empty - nothing currently highlighted)');
  }

  return lines.join('\n');
}

(async () => {
  try {
    const payload = await readStdinJson();
    if (!isNewUserTurn(payload)) {
      finish({}, { skippedReason: 'same_turn_tool_loop', invocationNum: payload.invocationNum });
      return;
    }

    const data = (await queryLiveBridgeDirectly()) || (await callVscodeMcpFallback());
    if (!data) {
      finish({}, { skippedReason: 'no_vscode_windows', invocationNum: payload.invocationNum });
      return;
    }

    const allWindows = Array.isArray(data.allWindows)
      ? data.allWindows
      : (data.activeOrLatestWindow ? [data.activeOrLatestWindow] : [data]);

    if (allWindows.length === 0) {
      finish({}, { skippedReason: 'empty_windows_list' });
      return;
    }

    const sections = allWindows.map((w, idx) =>
      formatWindowContext(w, idx === 0 ? 'Primary Active VS Code Window' : `VS Code Window #${idx + 1}`)
    );

    const sysText = [
      '<vscode_live_context>',
      '[Auto-injected by PreInvocation Hook right as the user sent this message. You ALREADY have the live cursor position and highlighted content below — no need to call vscode_get_editor_state manually.]',
      '',
      sections.join('\n\n'),
      '</vscode_live_context>'
    ].join('\n');

    finish(
      {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: sysText
            }
          }
        ]
      },
      {
        injected: true,
        windowCount: allWindows.length,
        primaryFile: allWindows[0].filePath || null,
        invocationNum: payload.invocationNum ?? null,
        initialNumSteps: payload.initialNumSteps ?? null
      }
    );
  } catch (err) {
    finish({}, { error: err && err.message ? err.message : String(err) });
  }
})();
