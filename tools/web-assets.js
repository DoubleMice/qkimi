/**
 * 受控的前端静态资源清单。
 *
 * 浏览器兼容模式与原生 LoopbackServer 都只暴露 manifest 中定义的路由；
 * `app.js` 和 `style.css` 则在读取时按顺序拼接源片段，避免源码重新变成巨型文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = 'static-manifest.json';
const SCRIPT_PREFIX = [
  '/* 此文件由 static-manifest.json 按顺序组装；请编辑 web/app/ 下的职责片段。 */',
  '(function () {',
  "  'use strict';",
  '',
].join('\n');
const SCRIPT_SUFFIX = '\n})();\n';
const STYLE_PREFIX = '/* 此文件由 static-manifest.json 按顺序组装；请编辑 web/styles/ 下的职责片段。 */\n';

function safeRoute(route) {
  return typeof route === 'string' && route.startsWith('/') && route !== '/' &&
    !route.includes('\\') && !route.split('/').includes('..');
}

function safeSource(source) {
  if (typeof source !== 'string' || !source || path.isAbsolute(source) || source.includes('\\')) return false;
  return source.split('/').every((part) => part && part !== '.' && part !== '..');
}

function assertContentType(contentType, label) {
  if (typeof contentType !== 'string' || !contentType.includes('/')) {
    throw new Error(`${label} 缺少有效 contentType`);
  }
}

function sourcePath(webRoot, source) {
  if (!safeSource(source)) throw new Error(`不安全的前端资源路径: ${String(source)}`);
  return path.join(webRoot, ...source.split('/'));
}

function loadWebManifest(webRoot) {
  const manifestPath = path.join(webRoot, MANIFEST_NAME);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取前端资源清单 ${manifestPath}: ${error.message}`);
  }
  if (!raw || !Array.isArray(raw.files) || !Array.isArray(raw.bundles)) {
    throw new Error('前端资源清单必须包含 files 与 bundles 数组');
  }

  const resources = new Map();
  function add(route, resource) {
    if (!safeRoute(route)) throw new Error(`不安全的前端路由: ${String(route)}`);
    if (resources.has(route)) throw new Error(`前端资源路由重复: ${route}`);
    resources.set(route, resource);
  }

  raw.files.forEach((file) => {
    if (!file || !safeSource(file.source)) throw new Error(`不安全的前端文件路径: ${file && file.source}`);
    assertContentType(file.contentType, `文件 ${file.source}`);
    const absolutePath = sourcePath(webRoot, file.source);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`前端文件不存在: ${file.source}`);
    }
    add(file.route, { type: 'file', source: file.source, contentType: file.contentType });
  });

  raw.bundles.forEach((bundle) => {
    if (!bundle || !['script', 'style'].includes(bundle.kind) || !Array.isArray(bundle.sources) || !bundle.sources.length) {
      throw new Error(`无效的前端 bundle: ${bundle && bundle.route}`);
    }
    assertContentType(bundle.contentType, `Bundle ${bundle.route}`);
    bundle.sources.forEach((source) => {
      if (!safeSource(source)) throw new Error(`不安全的 bundle 片段路径: ${source}`);
      const absolutePath = sourcePath(webRoot, source);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        throw new Error(`前端 bundle 片段不存在: ${source}`);
      }
    });
    add(bundle.route, {
      type: 'bundle',
      kind: bundle.kind,
      sources: bundle.sources.slice(),
      contentType: bundle.contentType,
    });
  });

  return { raw, resources };
}

function renderBundle(webRoot, resource) {
  const content = resource.sources.map((source) => fs.readFileSync(sourcePath(webRoot, source), 'utf8')).join('\n');
  if (resource.kind === 'script') return Buffer.from(SCRIPT_PREFIX + content + SCRIPT_SUFFIX);
  return Buffer.from(STYLE_PREFIX + content);
}

function readStaticResource(webRoot, route) {
  const manifest = loadWebManifest(webRoot);
  const resource = manifest.resources.get(route);
  if (!resource) return null;
  if (resource.type === 'file') {
    return { data: fs.readFileSync(sourcePath(webRoot, resource.source)), contentType: resource.contentType };
  }
  return { data: renderBundle(webRoot, resource), contentType: resource.contentType };
}

function buildBundle(webRoot, route) {
  const manifest = loadWebManifest(webRoot);
  const resource = manifest.resources.get(route);
  if (!resource || resource.type !== 'bundle') throw new Error(`不是 bundle 路由: ${route}`);
  return renderBundle(webRoot, resource).toString('utf8');
}

module.exports = {
  MANIFEST_NAME,
  buildBundle,
  loadWebManifest,
  readStaticResource,
  safeRoute,
  safeSource,
};
