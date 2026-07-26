#!/usr/bin/env node
/** 验证受控静态清单，并检查实际交付给 WebView 的两个 bundle。 */
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildBundle, loadWebManifest } = require('./web-assets');

const projectRoot = path.resolve(__dirname, '..');
const webRoot = path.join(projectRoot, 'web');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qkimi-web-check-'));

function checkJavaScript(name, source) {
  const file = path.join(tempRoot, name);
  fs.writeFileSync(file, source);
  const result = childProcess.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${name} 语法检查失败\n`);
    process.exitCode = 1;
  }
}

try {
  const manifest = loadWebManifest(webRoot);
  checkJavaScript('app.js', buildBundle(webRoot, '/app.js'));
  for (const [route, resource] of manifest.resources) {
    if (resource.contentType.startsWith('text/javascript') && resource.type === 'file') {
      checkJavaScript(path.basename(route), fs.readFileSync(path.join(webRoot, resource.source), 'utf8'));
    }
  }
  if (!process.exitCode) console.log('[qkimi] 前端资源清单与 JavaScript bundle 检查通过');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
