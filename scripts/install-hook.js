#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_NAME = 'vscode-live-cursor-and-selection';
const CONFIG_DIR = path.join(os.homedir(), '.gemini', 'config');
const HOOKS_JSON_PATH = path.join(CONFIG_DIR, 'hooks.json');
const TARGET_HOOK_DIR = path.join(CONFIG_DIR, 'hooks', 'vscode-context-hook');
const TARGET_HOOK_FILE = path.join(TARGET_HOOK_DIR, 'vscode-context-hook.js');

function readHooksJson() {
  if (!fs.existsSync(HOOKS_JSON_PATH)) return {};
  try {
    const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeHooksJson(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(HOOKS_JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function installHook() {
  const srcHook = path.resolve(__dirname, '..', 'hooks', 'vscode-context-hook.js');
  if (!fs.existsSync(srcHook)) {
    throw new Error(`Hook source not found: ${srcHook}`);
  }

  fs.mkdirSync(TARGET_HOOK_DIR, { recursive: true });
  fs.copyFileSync(srcHook, TARGET_HOOK_FILE);

  const hooksCfg = readHooksJson();
  const cmd = `"${process.execPath}" "${TARGET_HOOK_FILE}"`;
  hooksCfg[HOOK_NAME] = {
    enabled: true,
    PreInvocation: [
      {
        type: 'command',
        command: cmd,
        timeout: 10
      }
    ]
  };
  writeHooksJson(hooksCfg);

  console.log(`Installed hook script: ${TARGET_HOOK_FILE}`);
  console.log(`Registered "${HOOK_NAME}" in: ${HOOKS_JSON_PATH}`);
}

function uninstallHook() {
  const hooksCfg = readHooksJson();
  if (hooksCfg[HOOK_NAME]) {
    delete hooksCfg[HOOK_NAME];
    writeHooksJson(hooksCfg);
    console.log(`Removed "${HOOK_NAME}" from: ${HOOKS_JSON_PATH}`);
  }
  if (fs.existsSync(TARGET_HOOK_DIR)) {
    fs.rmSync(TARGET_HOOK_DIR, { recursive: true, force: true });
    console.log(`Removed hook directory: ${TARGET_HOOK_DIR}`);
  }
  console.log('Hook uninstall complete.');
}

if (process.argv.includes('--uninstall')) {
  uninstallHook();
} else {
  installHook();
}
