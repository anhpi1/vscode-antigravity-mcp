#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

function getVsCodeStorageJsonPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', 'storage.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'storage.json');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'storage.json');
}

function detectVsCodeProfiles() {
  const storagePath = getVsCodeStorageJsonPath();
  if (!fs.existsSync(storagePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    if (Array.isArray(data.userDataProfiles)) {
      return data.userDataProfiles.map(p => p.name).filter(Boolean);
    }
  } catch (_) {}
  return [];
}

function runCodeCli(args) {
  if (process.platform === 'win32') {
    const quoted = args.map(a => `"${String(a).replace(/"/g, '""')}"`).join(' ');
    return cp.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `code.cmd ${quoted}`], { stdio: 'inherit' });
  }
  return cp.spawnSync('code', args, { stdio: 'inherit' });
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const extPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'extension', 'package.json'), 'utf8'));
  const extId = `${extPkg.publisher}.${extPkg.name}`;

  for (const prof of detectVsCodeProfiles()) {
    console.log(`Uninstalling ${extId} from profile "${prof}"...`);
    runCodeCli(['--profile', prof, '--uninstall-extension', extId]);
  }
  console.log(`Uninstalling ${extId} from Default profile...`);
  runCodeCli(['--uninstall-extension', extId]);

  const cfgFile = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      if (cfg.mcpServers && cfg.mcpServers.vscode) {
        delete cfg.mcpServers.vscode;
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        console.log(`Removed "vscode" entry from ${cfgFile}`);
      }
    } catch (_) {}
  }

  console.log('Uninstall complete.');
}

main();
