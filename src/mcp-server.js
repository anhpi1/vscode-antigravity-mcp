#!/usr/bin/env node
'use strict';

// Ensure nothing ever pollutes stdout except MCP JSON-RPC frames
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const cp = require('child_process');

const STATE_DIR = process.env.ANTIGRAVITY_VSCODE_BRIDGE_DIR || path.join(os.homedir(), '.antigravity-vscode-bridge');
const WINDOWS_DIR = path.join(STATE_DIR, 'windows');
const MAX_READ_LINES = 800;
const MAX_READ_BYTES = 46080;

let localTaskCounter = 0;
const localTasks = new Map();

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function httpGetJson(port, urlPath, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('HTTP timeout')); });
    req.on('error', reject);
  });
}

function httpPostRpc(port, method, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ method, args }), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': payload.byteLength
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            const err = new Error(`VS Code RPC HTTP ${res.statusCode}: ${bodyText}`);
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }
          try {
            const parsed = JSON.parse(bodyText);
            if (!parsed.ok) {
              reject(new Error(parsed.error || 'Unknown VS Code RPC error'));
            } else {
              resolve(parsed.result);
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('VS Code RPC timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function discoverWindows() {
  if (!fs.existsSync(WINDOWS_DIR)) return [];
  const entries = fs.readdirSync(WINDOWS_DIR).filter(f => f.startsWith('bridge-window-') && f.endsWith('.json'));
  const liveWindows = [];

  for (const file of entries) {
    const full = path.join(WINDOWS_DIR, file);
    try {
      const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!isPidAlive(meta.pid)) {
        try { fs.unlinkSync(full); } catch (_) {}
        continue;
      }
      if (meta.port) {
        try {
          const fresh = await httpGetJson(meta.port, '/state', 1500);
          liveWindows.push(fresh);
          continue;
        } catch (_) {}
      }
      liveWindows.push(meta);
    } catch (_) {}
  }

  liveWindows.sort((a, b) => {
    if (Boolean(a.windowFocused) !== Boolean(b.windowFocused)) {
      return a.windowFocused ? -1 : 1;
    }
    const ta = a.lastInteractionAt || a.updatedAt || '';
    const tb = b.lastInteractionAt || b.updatedAt || '';
    return tb.localeCompare(ta);
  });

  return liveWindows;
}

function isDefinitelyRemotePath(p) {
  if (!p || typeof p !== 'string') return false;
  const s = p.trim();
  if (s.startsWith('vscode-remote://')) return true;
  if (process.platform === 'win32' && s.startsWith('/')) return true;
  return false;
}

function pickWindowForPath(windows, inputPath) {
  if (!windows.length) return null;
  if (!inputPath) return windows.find(w => w.port) || null;

  const trimmed = inputPath.trim();

  if (trimmed.startsWith('vscode-remote://')) {
    const match = windows.find(w => {
      if (!w.port || !w.remoteAuthority) return false;
      const enc = encodeURIComponent(w.remoteAuthority);
      return trimmed.includes(w.remoteAuthority) || trimmed.includes(enc);
    });
    return match || windows.find(w => w.port && w.isRemote) || null;
  }

  if (process.platform === 'win32' && trimmed.startsWith('/')) {
    const remoteWins = windows.filter(w => w.port && w.isRemote);
    const byFolder = remoteWins.find(w =>
      Array.isArray(w.workspaceFolders) &&
      w.workspaceFolders.some(f => f.path && trimmed.startsWith(f.path))
    );
    return byFolder || remoteWins[0] || null;
  }

  const normLower = trimmed.replace(/\\/g, '/').toLowerCase();
  const localWins = windows.filter(w => w.port && !w.isRemote);
  const byFolder = localWins.find(w =>
    Array.isArray(w.workspaceFolders) &&
    w.workspaceFolders.some(f => f.path && normLower.startsWith(f.path.replace(/\\/g, '/').toLowerCase()))
  );
  if (byFolder) return byFolder;

  // On macOS/Linux, check if a remote window explicitly owns a POSIX path when not matched locally
  if (process.platform !== 'win32' && trimmed.startsWith('/') && !fs.existsSync(trimmed)) {
    const remoteByFolder = windows.find(w =>
      w.port && w.isRemote &&
      Array.isArray(w.workspaceFolders) &&
      w.workspaceFolders.some(f => f.path && trimmed.startsWith(f.path))
    );
    if (remoteByFolder) return remoteByFolder;
  }

  return localWins[0] || windows.find(w => w.port) || null;
}

function pickWindowForCommand(windows, targetHint, cwd) {
  if (!windows.length) return null;
  const hint = (targetHint || 'auto').toLowerCase();
  if (hint === 'remote') {
    return windows.find(w => w.port && w.isRemote) || null;
  }
  if (hint === 'local') {
    return windows.find(w => w.port && !w.isRemote) || null;
  }
  if (/^\d+$/.test(hint)) {
    return windows.find(w => w.port && String(w.pid) === hint) || null;
  }
  if (cwd) {
    const byPath = pickWindowForPath(windows, cwd);
    if (byPath) return byPath;
  }
  return windows.find(w => w.port) || null;
}

// --- Standalone Local Node.js Fallbacks (when VS Code is closed) ---

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

function localReadFile(args) {
  const filePath = args.Path;
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const buf = fs.readFileSync(filePath);
  if (buf.byteLength === 0) return 'File is empty';
  const rawText = buf.toString('utf8');
  const lines = rawText.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = Math.max(1, args.StartLine ? Number(args.StartLine) : 1);
  if (startLine > totalLines) {
    return `StartLine (${startLine}) exceeds total lines in file (${totalLines}).`;
  }
  const requestedEnd = args.EndLine ? Number(args.EndLine) : (startLine + MAX_READ_LINES - 1);
  const endLine = Math.min(totalLines, requestedEnd, startLine + MAX_READ_LINES - 1);

  const selected = [];
  for (let i = startLine; i <= endLine; i++) {
    selected.push(`${i}: ${lines[i - 1]}`);
  }
  const block = selected.join('\n');
  const fullBuf = Buffer.from(block, 'utf8');
  const byteOffset = Math.max(0, args.ByteOffset ? Number(args.ByteOffset) : 0);
  if (byteOffset > 0 || fullBuf.byteLength > MAX_READ_BYTES) {
    const slice = fullBuf.subarray(byteOffset, byteOffset + MAX_READ_BYTES).toString('utf8');
    const rem = Math.max(0, fullBuf.byteLength - (byteOffset + MAX_READ_BYTES));
    const note = rem > 0
      ? `\n... [Truncated at ${MAX_READ_BYTES} bytes. ${rem} bytes remaining; pass ByteOffset=${byteOffset + MAX_READ_BYTES}]`
      : '';
    return `Showing lines ${startLine}-${endLine} of ${totalLines} (byte offset ${byteOffset})\n${slice}${note}`;
  }
  return `Showing lines ${startLine}-${endLine} of ${totalLines}\n${block}`;
}

function localWriteFile(args) {
  const filePath = args.Path;
  const content = typeof args.Content === 'string' ? args.Content : '';
  const overwrite = Boolean(args.Overwrite);
  const append = Boolean(args.Append);
  if (overwrite && append) {
    throw new Error('Cannot combine Overwrite=true with Append=true.');
  }
  const exists = fs.existsSync(filePath);
  if (exists && !overwrite && !append) {
    throw new Error(`File already exists: ${filePath}. Set Overwrite=true or Append=true.`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (append) {
    fs.appendFileSync(filePath, content, 'utf8');
    return 'Appended to file.';
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return exists ? 'Overwrote file.' : 'Created file.';
}

function localEditFile(args) {
  const filePath = args.Path;
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let target = args.Target;
  let replacement = typeof args.Replacement === 'string' ? args.Replacement : '';
  if (!target) throw new Error('Target must be non-empty.');

  if (!text.includes(target)) {
    const norm = target.replace(/\r?\n/g, eol);
    if (text.includes(norm)) {
      target = norm;
      replacement = replacement.replace(/\r?\n/g, eol);
    } else {
      throw new Error(`Target string not found in ${filePath}.`);
    }
  }
  const parts = text.split(target);
  const count = parts.length - 1;
  fs.writeFileSync(filePath, parts.join(replacement), 'utf8');
  return `Edited ${filePath} (${count} occurrence${count > 1 ? 's' : ''} replaced).`;
}

function localListDir(args) {
  const dir = args.DirectoryPath;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name);
    else {
      let sz = 0;
      try { sz = fs.statSync(path.join(dir, e.name)).size; } catch (_) {}
      files.push({ name: e.name, size: sz });
    }
  }
  dirs.sort();
  files.sort((a, b) => a.name.localeCompare(b.name));
  const out = [`Directory: ${dir}`];
  for (const d of dirs) out.push(`[DIR]  ${d}/`);
  for (const f of files) out.push(`[FILE] ${f.name} (${f.size} bytes)`);
  if (dirs.length === 0 && files.length === 0) out.push('(empty directory)');
  return out.join('\n');
}

function localFindByName(args) {
  const rootDir = args.SearchDirectory;
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

  function walk(curr, rel, depth) {
    if (depth > maxDepth || matches.length >= MAX_RESULTS) return;
    let entries;
    try { entries = fs.readdirSync(curr, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (matches.length >= MAX_RESULTS) break;
      const isDir = e.isDirectory();
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isDir && DEFAULT_IGNORED_DIRS.has(e.name)) continue;
      if (excludeRes.some(r => r.test(childRel) || r.test(e.name))) continue;
      const full = path.join(curr, e.name);
      const typeOk = wantType === 'any' || (wantType === 'directory' && isDir) || (wantType === 'file' && !isDir);
      let extOk = true;
      if (extensions && extensions.length > 0) {
        extOk = !isDir && extensions.includes(path.extname(e.name).replace(/^\./, '').toLowerCase());
      }
      const patOk = patternRe ? patternRe.test(fullPathMatch ? childRel : e.name) : true;
      if (typeOk && extOk && patOk) {
        matches.push(`${isDir ? '[DIR] ' : ''}${full}`);
      }
      if (isDir && depth < maxDepth) walk(full, childRel, depth + 1);
    }
  }

  walk(rootDir, '', 1);
  return matches.length === 0
    ? `No matches found in ${rootDir}.`
    : `Found ${matches.length}${matches.length >= MAX_RESULTS ? '+' : ''} result(s):\n` + matches.join('\n');
}

function localGrepSearch(args) {
  const target = args.SearchPath;
  const query = args.Query;
  if (!query) throw new Error('Query is required.');
  const flags = args.CaseInsensitive ? 'i' : '';
  const regex = args.IsRegex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const matchPerLine = args.MatchPerLine !== false;
  const includeRes = Array.isArray(args.Includes) ? args.Includes.map(g => globToRegExp(g, true)) : null;
  const results = [];
  const MAX_MATCHES = 50;

  function checkFile(filePath, relName) {
    if (results.length >= MAX_MATCHES) return;
    if (includeRes && !includeRes.some(r => r.test(relName) || r.test(path.basename(relName)))) return;
    try {
      const st = fs.statSync(filePath);
      if (st.size > 2 * 1024 * 1024) return;
      const buf = fs.readFileSync(filePath);
      for (let i = 0; i < Math.min(buf.byteLength, 512); i++) {
        if (buf[i] === 0) return;
      }
      const text = buf.toString('utf8');
      if (!matchPerLine) {
        if (regex.test(text)) results.push(filePath);
        return;
      }
      const lines = text.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx++) {
        if (regex.test(lines[idx])) {
          results.push(`${filePath}:${idx + 1}: ${lines[idx].slice(0, 240)}`);
          if (results.length >= MAX_MATCHES) break;
        }
      }
    } catch (_) {}
  }

  function walk(dir, rel, depth) {
    if (depth > 12 || results.length >= MAX_MATCHES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (results.length >= MAX_MATCHES) break;
      if (e.isDirectory() && DEFAULT_IGNORED_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, childRel, depth + 1);
      else checkFile(full, childRel);
    }
  }

  const stat = fs.statSync(target);
  if (stat.isDirectory()) walk(target, '', 1);
  else checkFile(target, path.basename(target));

  return results.length === 0
    ? `No matches found for "${query}" in ${target}.`
    : `Found ${results.length}${results.length >= MAX_MATCHES ? '+' : ''} match(es):\n` + results.join('\n');
}

function localRunCommand(args) {
  const waitMs = Math.min(10000, Math.max(500, Number(args.WaitMsBeforeAsync || 5000)));
  const id = `local-task-${++localTaskCounter}`;
  const cwd = args.Cwd && fs.existsSync(args.Cwd) ? args.Cwd : os.homedir();
  const task = {
    id,
    summary: args.toolSummary || args.CommandLine.slice(0, 50),
    createdAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    exitCode: null,
    output: '',
    proc: null
  };
  localTasks.set(id, task);

  const shellBin = process.platform === 'win32'
    ? 'powershell.exe'
    : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  const shellArgs = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-Command', args.CommandLine]
    : (shellBin.endsWith('bash') ? ['-lc', args.CommandLine] : ['-c', args.CommandLine]);

  return new Promise((resolve) => {
    let settled = false;
    const child = cp.spawn(shellBin, shellArgs, { cwd, windowsHide: true });
    task.proc = child;
    const onData = (c) => {
      task.output += c.toString('utf8');
      if (task.output.length > 200000) task.output = task.output.slice(-200000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(`Task ID: ${task.id}\nStatus: running in background\n${task.output}`);
      }
    }, waitMs);

    child.on('close', (code) => {
      if (task.status === 'running') task.status = 'completed';
      task.exitCode = code ?? 0;
      task.completedAt = new Date().toISOString();
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(
          `Created At: ${task.createdAt}\nCompleted At: ${task.completedAt}\nCommand exited with code ${task.exitCode}.\n\n` +
          (task.output ? `Command output:\n${task.output}` : 'No output from the command.')
        );
      }
    });
  });
}

// --- Tool Definitions ---

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a text file (supports both Local paths and Remote-SSH/WSL/Container paths in VS Code). Each read returns at most 800 lines or 46080 bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        Path: { type: 'string', description: 'The absolute path of the file to read.' },
        StartLine: { type: 'integer', description: 'Start line to read (1-indexed, inclusive). Omit to read from the beginning.' },
        EndLine: { type: 'integer', description: 'End line to read (1-indexed, inclusive). Omit to read up to 800 lines.' },
        ByteOffset: { type: 'integer', description: 'Byte offset into the line range when truncated by the byte limit.' }
      },
      required: ['Path']
    }
  },
  {
    name: 'write_file',
    description: 'Create a new file with the given contents, overwrite an existing file, or append when Append is true. Automatically saves to disk in VS Code while preserving Undo history on open tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        Path: { type: 'string', description: 'The absolute path of the file to create or write.' },
        Content: { type: 'string', description: 'The full contents to write to the file.' },
        Overwrite: { type: 'boolean', description: 'Whether to overwrite an existing file, replacing its entire contents.' },
        Append: { type: 'boolean', description: 'Whether to append Content to the end of the file. Cannot be combined with Overwrite=true.' }
      },
      required: ['Path', 'Content']
    }
  },
  {
    name: 'edit_file',
    description: 'Edit an existing file by replacing exact occurrences of Target with Replacement. Updates open VS Code tabs cleanly with Undo support and saves immediately to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        Path: { type: 'string', description: 'The absolute path of the file to modify.' },
        Target: { type: 'string', description: 'The exact character-sequence to be replaced, including whitespace. Every occurrence is replaced.' },
        Replacement: { type: 'string', description: 'The content to replace Target with. Leave empty to delete Target.' }
      },
      required: ['Path', 'Target', 'Replacement']
    }
  },
  {
    name: 'list_dir',
    description: 'List the subdirectories and files inside a directory (works across Local and Remote-SSH/WSL workspaces).',
    inputSchema: {
      type: 'object',
      properties: {
        DirectoryPath: { type: 'string', description: 'The absolute path of the directory to list.' }
      },
      required: ['DirectoryPath']
    }
  },
  {
    name: 'find_by_name',
    description: 'Search for files and subdirectories within a directory by glob pattern, extension, and type (works across Local and Remote-SSH/WSL).',
    inputSchema: {
      type: 'object',
      properties: {
        SearchDirectory: { type: 'string', description: 'The root directory to search within.' },
        Pattern: { type: 'string', description: 'Optional glob pattern to match file/folder names.' },
        Extensions: { type: 'array', items: { type: 'string' }, description: 'Optional file extensions to include (without leading dot).' },
        Excludes: { type: 'array', items: { type: 'string' }, description: 'Optional glob patterns to exclude.' },
        Type: { type: 'string', enum: ['file', 'directory', 'any'], description: 'Filter by entry type.' },
        MaxDepth: { type: 'integer', description: 'Maximum directory depth to traverse.' },
        FullPath: { type: 'boolean', description: 'Match Pattern against relative path rather than basename.' }
      },
      required: ['SearchDirectory']
    }
  },
  {
    name: 'grep_search',
    description: 'Search for exact text or regular expression matches inside files or directories (works across Local and Remote-SSH/WSL).',
    inputSchema: {
      type: 'object',
      properties: {
        SearchPath: { type: 'string', description: 'The file or directory path to search.' },
        Query: { type: 'string', description: 'The search string or regular expression pattern.' },
        IsRegex: { type: 'boolean', description: 'Treat Query as a regular expression.' },
        CaseInsensitive: { type: 'boolean', description: 'Perform case-insensitive matching.' },
        MatchPerLine: { type: 'boolean', description: 'Return matching line numbers and snippets (default true).' },
        Includes: { type: 'array', items: { type: 'string' }, description: 'Optional glob filters for filenames.' }
      },
      required: ['SearchPath', 'Query']
    }
  },
  {
    name: 'run_command',
    description: 'Execute a shell command in the active VS Code workspace (Local shell or Remote Shell Integration / SSH on Remote-SSH/WSL windows). Commands exceeding WaitMsBeforeAsync continue as background tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        CommandLine: { type: 'string', description: 'The exact command line string to execute.' },
        WaitMsBeforeAsync: { type: 'integer', description: 'Milliseconds to wait before backgrounding (500 to 10000).' },
        IsDaemon: { type: 'boolean', description: 'Set to true for long-running background servers or watchers.' },
        toolSummary: { type: 'string', description: 'Brief 2-5 word noun phrase describing the command task.' },
        Cwd: { type: 'string', description: 'Optional working directory (defaults to active VS Code workspace folder).' },
        TargetWindow: { type: 'string', description: 'Optional routing target: "auto" (default), "local", "remote", or VS Code window PID.' }
      },
      required: ['CommandLine', 'toolSummary', 'WaitMsBeforeAsync']
    }
  },
  {
    name: 'manage_task',
    description: 'Manage background command tasks: list running/completed tasks, check status and recent output, send_input to stdin, or kill a task.',
    inputSchema: {
      type: 'object',
      properties: {
        Action: { type: 'string', enum: ['list', 'status', 'send_input', 'kill'], description: 'Management action to perform.' },
        TaskId: { type: 'string', description: 'Task ID reported by run_command or list.' },
        Input: { type: 'string', description: 'Input text to deliver when Action is send_input.' }
      },
      required: ['Action']
    }
  },
  {
    name: 'vscode_get_editor_state',
    description: 'Get live VS Code state: active file path (Local or Remote-SSH), cursor line/column, currently highlighted/selected text, open tabs, and workspace folders.',
    inputSchema: {
      type: 'object',
      properties: {
        AllWindows: { type: 'boolean', description: 'If true, returns all open VS Code windows in addition to the active/latest window.' }
      }
    }
  },
  {
    name: 'vscode_open_file',
    description: 'Open a file in VS Code, bring it into view, and optionally jump to a line/column or highlight a selection range.',
    inputSchema: {
      type: 'object',
      properties: {
        Path: { type: 'string', description: 'Absolute file path (Local or Remote-SSH POSIX path).' },
        StartLine: { type: 'integer', description: '1-indexed start line.' },
        StartColumn: { type: 'integer', description: '1-indexed start column.' },
        EndLine: { type: 'integer', description: '1-indexed end line for selection.' },
        EndColumn: { type: 'integer', description: '1-indexed end column for selection.' },
        Preview: { type: 'boolean', description: 'Open as preview tab (default false).' }
      },
      required: ['Path']
    }
  },
  {
    name: 'vscode_get_diagnostics',
    description: 'Read compiler, linter, and language-server errors/warnings (e.g. Clangd, C/C++, Pylance, ESLint) from VS Code Problems panel.',
    inputSchema: {
      type: 'object',
      properties: {
        Path: { type: 'string', description: 'Optional file path to filter diagnostics; omit to fetch all workspace diagnostics.' },
        Severity: { type: 'string', enum: ['Error', 'Warning', 'Information', 'Hint'], description: 'Optional severity filter.' }
      }
    }
  },
  {
    name: 'vscode_execute_command',
    description: 'Execute any built-in or extension VS Code command ID (e.g., "editor.action.formatDocument", "cmake.build", "workbench.action.files.saveAll").',
    inputSchema: {
      type: 'object',
      properties: {
        Command: { type: 'string', description: 'VS Code command identifier.' },
        Args: { type: 'array', description: 'Optional array of arguments passed to the command.' }
      },
      required: ['Command']
    }
  }
];

async function executeToolCall(name, args = {}) {
  const windows = await discoverWindows();

  if (name === 'vscode_get_editor_state') {
    if (windows.length === 0) {
      return 'No running VS Code windows detected (or extension not yet activated).';
    }
    const payload = args.AllWindows
      ? { activeOrLatestWindow: windows[0], allWindows: windows }
      : windows[0];
    return JSON.stringify(payload, null, 2);
  }

  if (['read_file', 'write_file', 'edit_file'].includes(name)) {
    const win = pickWindowForPath(windows, args.Path);
    if (win && win.port) {
      return await httpPostRpc(win.port, name, args);
    }
    if (isDefinitelyRemotePath(args.Path)) {
      throw new Error(`No active Remote VS Code window found to access remote path: ${args.Path}`);
    }
    if (name === 'read_file') return localReadFile(args);
    if (name === 'write_file') return localWriteFile(args);
    if (name === 'edit_file') return localEditFile(args);
  }

  if (name === 'list_dir') {
    const win = pickWindowForPath(windows, args.DirectoryPath);
    if (win && win.port) {
      return await httpPostRpc(win.port, 'list_dir', args);
    }
    if (isDefinitelyRemotePath(args.DirectoryPath)) {
      throw new Error(`No active Remote VS Code window found for: ${args.DirectoryPath}`);
    }
    return localListDir(args);
  }

  if (name === 'find_by_name') {
    const win = pickWindowForPath(windows, args.SearchDirectory);
    if (win && win.port) {
      return await httpPostRpc(win.port, 'find_by_name', args, 60000);
    }
    if (isDefinitelyRemotePath(args.SearchDirectory)) {
      throw new Error(`No active Remote VS Code window found for: ${args.SearchDirectory}`);
    }
    return localFindByName(args);
  }

  if (name === 'grep_search') {
    const win = pickWindowForPath(windows, args.SearchPath);
    if (win && win.port) {
      return await httpPostRpc(win.port, 'grep_search', args, 60000);
    }
    if (isDefinitelyRemotePath(args.SearchPath)) {
      throw new Error(`No active Remote VS Code window found for: ${args.SearchPath}`);
    }
    return localGrepSearch(args);
  }

  if (['vscode_open_file', 'vscode_get_diagnostics', 'vscode_execute_command'].includes(name)) {
    const targetPath = args.Path || null;
    const win = pickWindowForPath(windows, targetPath);
    if (!win || !win.port) {
      throw new Error('No active VS Code window available.');
    }
    return await httpPostRpc(win.port, name, args);
  }

  if (name === 'run_command') {
    const win = pickWindowForCommand(windows, args.TargetWindow, args.Cwd);
    if (win && win.port) {
      return await httpPostRpc(win.port, 'run_command', args, 20000);
    }
    return await localRunCommand(args);
  }

  if (name === 'manage_task') {
    if (args.Action === 'list') {
      const combined = [];
      for (const w of windows) {
        if (!w.port) continue;
        try {
          const listStr = await httpPostRpc(w.port, 'manage_task', { Action: 'list' }, 5000);
          const arr = JSON.parse(listStr);
          for (const item of arr) {
            combined.push({ ...item, WindowPid: w.pid, IsRemote: w.isRemote, RemoteAuthority: w.remoteAuthority });
          }
        } catch (_) {}
      }
      for (const t of localTasks.values()) {
        combined.push({
          TaskId: t.id,
          Summary: t.summary,
          Status: t.status,
          CreatedAt: t.createdAt,
          CompletedAt: t.completedAt,
          ExitCode: t.exitCode,
          WindowPid: null,
          IsRemote: false
        });
      }
      return JSON.stringify(combined, null, 2);
    }

    if (args.TaskId && args.TaskId.startsWith('local-task-')) {
      const t = localTasks.get(args.TaskId);
      if (!t) throw new Error(`Task not found: ${args.TaskId}`);
      if (args.Action === 'status') {
        return JSON.stringify({
          TaskId: t.id,
          Status: t.status,
          ExitCode: t.exitCode,
          RecentOutput: t.output.slice(-8000)
        }, null, 2);
      }
      if (args.Action === 'send_input' && t.proc && t.proc.stdin) {
        t.proc.stdin.write(args.Input || '');
        return `Sent input to ${t.id}.`;
      }
      if (args.Action === 'kill' && t.proc) {
        t.status = 'killed';
        if (process.platform === 'win32') {
          try { cp.execSync(`taskkill /PID ${t.proc.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
        } else {
          try { t.proc.kill('SIGTERM'); } catch (_) {}
        }
        return `Killed ${t.id}.`;
      }
    }

    for (const w of windows) {
      if (!w.port) continue;
      try {
        return await httpPostRpc(w.port, 'manage_task', args, 5000);
      } catch (_) {}
    }
    throw new Error(`Task not found across open VS Code windows: ${args.TaskId}`);
  }

  throw new Error(`Unknown tool: ${name}`);
}

// --- MCP JSON-RPC 2.0 Stdio Transport ---

let useContentLengthFraming = false;

function sendJsonRpc(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

async function handleJsonRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined || msg.id === null) return;

  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  try {
    if (method === 'initialize') {
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
      const clientVer = params.protocolVersion;
      const negotiated = supported.includes(clientVer) ? clientVer : '2025-03-26';
      sendJsonRpc({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'vscode-antigravity-mcp', version: '1.0.0' }
        }
      });
      return;
    }

    if (method === 'ping') {
      sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendJsonRpc({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'resources/list') {
      sendJsonRpc({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;
    }

    if (method === 'prompts/list') {
      sendJsonRpc({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params.name;
      const toolArgs = params.arguments || {};
      try {
        const textResult = await executeToolCall(toolName, toolArgs);
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: String(textResult) }], isError: false }
        });
      } catch (toolErr) {
        sendJsonRpc({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${toolErr && toolErr.message ? toolErr.message : String(toolErr)}` }],
            isError: true
          }
        });
      }
      return;
    }

    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  } catch (err) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err && err.message ? err.message : String(err) }
    });
  }
}

let rawBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  rawBuffer = Buffer.concat([rawBuffer, chunk]);

  while (rawBuffer.length > 0) {
    const asciiStart = rawBuffer.subarray(0, Math.min(rawBuffer.length, 32)).toString('ascii');
    if (asciiStart.startsWith('Content-Length:')) {
      useContentLengthFraming = true;
      const headerEnd = rawBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const headerStr = rawBuffer.subarray(0, headerEnd).toString('ascii');
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        rawBuffer = rawBuffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const totalNeeded = headerEnd + 4 + len;
      if (rawBuffer.length < totalNeeded) break;
      const bodyStr = rawBuffer.subarray(headerEnd + 4, totalNeeded).toString('utf8');
      rawBuffer = rawBuffer.subarray(totalNeeded);
      try { handleJsonRpcMessage(JSON.parse(bodyStr)); } catch (_) {}
      continue;
    }

    const nlIdx = rawBuffer.indexOf(0x0a);
    if (nlIdx === -1) break;
    const lineStr = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
    rawBuffer = rawBuffer.subarray(nlIdx + 1);
    if (!lineStr) continue;
    try { handleJsonRpcMessage(JSON.parse(lineStr)); } catch (_) {}
  }
});

process.stdin.on('end', () => process.exit(0));
