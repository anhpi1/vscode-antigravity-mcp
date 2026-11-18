#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { buildVsix } = require('./pack-vsix');

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

function registerAntigravityMcp(mcpServerPath) {
  const cfgDir = path.join(os.homedir(), '.gemini', 'config');
  const cfgFile = path.join(cfgDir, 'mcp_config.json');
  fs.mkdirSync(cfgDir, { recursive: true });

  let cfg = { mcpServers: {} };
  if (fs.existsSync(cfgFile)) {
    try {
      const raw = fs.readFileSync(cfgFile, 'utf8').trim();
      if (raw) cfg = JSON.parse(raw);
    } catch (_) {}
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') {
    cfg.mcpServers = {};
  }

  cfg.mcpServers.vscode = {
    command: process.execPath,
    args: [mcpServerPath]
  };

  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`Registered MCP server "vscode" in: ${cfgFile}`);
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const vsixPath = buildVsix();
  console.log(`Built VSIX package: ${vsixPath}`);

  console.log('\nInstalling VS Code extension into Default profile...');
  runCodeCli(['--install-extension', vsixPath, '--force']);

  const profiles = detectVsCodeProfiles();
  for (const prof of profiles) {
    console.log(`\nInstalling VS Code extension into profile "${prof}"...`);
    runCodeCli(['--profile', prof, '--install-extension', vsixPath, '--force']);
  }

  const mcpServerPath = path.join(rootDir, 'src', 'mcp-server.js');
  registerAntigravityMcp(mcpServerPath);

  console.log('\nSetup complete! Refresh MCP Servers in Antigravity (or restart your MCP client) to start using the 12 VS Code tools.');
}

main();
