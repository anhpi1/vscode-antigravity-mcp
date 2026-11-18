#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const serverPath = path.resolve(__dirname, '..', 'src', 'mcp-server.js');
const proc = cp.spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let reqId = 0;
const pending = new Map();

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function callRpc(method, params) {
  const id = ++reqId;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}

(async () => {
  try {
    const initRes = await callRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mcp-test', version: '1.0.0' }
    });
    assert.strictEqual(initRes.result.serverInfo.name, 'vscode-antigravity-mcp');
    console.log('✓ initialize passed');

    const listRes = await callRpc('tools/list', {});
    assert.strictEqual(listRes.result.tools.length, 12);
    console.log(`✓ tools/list passed (${listRes.result.tools.length} tools registered)`);

    const stateRes = await callRpc('tools/call', {
      name: 'vscode_get_editor_state',
      arguments: { AllWindows: true }
    });
    assert.strictEqual(stateRes.result.isError, false);
    console.log('✓ vscode_get_editor_state passed');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-mcp-test-'));
    const sampleFile = path.join(tmpDir, 'sample.txt');

    const writeRes = await callRpc('tools/call', {
      name: 'write_file',
      arguments: { Path: sampleFile, Content: 'Alpha\nBeta old\nGamma\n', Overwrite: true }
    });
    assert.strictEqual(writeRes.result.isError, false);

    const editRes = await callRpc('tools/call', {
      name: 'edit_file',
      arguments: { Path: sampleFile, Target: 'Beta old', Replacement: 'Beta updated' }
    });
    assert.strictEqual(editRes.result.isError, false);

    const readRes = await callRpc('tools/call', {
      name: 'read_file',
      arguments: { Path: sampleFile }
    });
    assert.strictEqual(readRes.result.isError, false);
    assert(readRes.result.content[0].text.includes('2: Beta updated'));
    console.log('✓ write_file + edit_file + read_file passed');

    const grepRes = await callRpc('tools/call', {
      name: 'grep_search',
      arguments: { SearchPath: tmpDir, Query: 'Beta updated' }
    });
    assert.strictEqual(grepRes.result.isError, false);
    assert(grepRes.result.content[0].text.includes('Beta updated'));
    console.log('✓ grep_search passed');

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('\nAll MCP server tests passed!');
    proc.stdin.end();
  } catch (err) {
    console.error('Test failed:', err);
    proc.kill();
    process.exit(1);
  }
})();
