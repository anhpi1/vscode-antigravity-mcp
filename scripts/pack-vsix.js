#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Precompute standard IEEE 802.3 CRC32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const rawBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6);
    localHdr.writeUInt16LE(8, 8);
    localHdr.writeUInt16LE(0, 10);
    localHdr.writeUInt16LE(0x0021, 12);
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(compBuf.length, 18);
    localHdr.writeUInt32LE(rawBuf.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(8, 10);
    centralHdr.writeUInt16LE(0, 12);
    centralHdr.writeUInt16LE(0x0021, 14);
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(compBuf.length, 20);
    centralHdr.writeUInt32LE(rawBuf.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);

    localParts.push(localHdr, nameBuf, compBuf);
    centralParts.push(centralHdr, nameBuf);

    offset += localHdr.length + nameBuf.length + compBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function buildVsix() {
  const rootDir = path.resolve(__dirname, '..');
  const extDir = path.join(rootDir, 'extension');
  const distDir = path.join(rootDir, 'dist');
  const pkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));

  const contentTypes = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension=".json" ContentType="application/json"/>',
    '  <Default Extension=".js" ContentType="application/javascript"/>',
    '  <Default Extension=".md" ContentType="text/markdown"/>',
    '  <Default Extension=".txt" ContentType="text/plain"/>',
    '  <Default Extension=".vsixmanifest" ContentType="text/xml"/>',
    '</Types>'
  ].join('\n');

  const manifest = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />`,
    `    <DisplayName>${pkg.displayName}</DisplayName>`,
    `    <Description xml:space="preserve">${pkg.description}</Description>`,
    '    <Tags>mcp,antigravity,vscode,remote-ssh</Tags>',
    '    <Categories>Other</Categories>',
    '    <GalleryFlags>Public</GalleryFlags>',
    '    <Properties>',
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />`,
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />',
    '      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />',
    '    </Properties>',
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>',
    '  </Installation>',
    '  <Dependencies/>',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    '  </Assets>',
    '</PackageManifest>'
  ].join('\n');

  const entries = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: 'extension.vsixmanifest', data: manifest },
    { name: 'extension/package.json', data: fs.readFileSync(path.join(extDir, 'package.json')) },
    { name: 'extension/extension.js', data: fs.readFileSync(path.join(extDir, 'extension.js')) }
  ];

  const readmePath = path.join(rootDir, 'README.md');
  if (fs.existsSync(readmePath)) {
    entries.push({ name: 'extension/README.md', data: fs.readFileSync(readmePath) });
  }

  fs.mkdirSync(distDir, { recursive: true });
  const vsixPath = path.join(distDir, `${pkg.name}-${pkg.version}.vsix`);
  fs.writeFileSync(vsixPath, createZipBuffer(entries));
  return vsixPath;
}

if (require.main === module) {
  const out = buildVsix();
  console.log(`Built VSIX: ${out}`);
}

module.exports = { buildVsix };
