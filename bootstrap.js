(function () {
  'use strict';

  var status = { phase: 'loading', error: null };
  window.__qkimiBootstrap = status;

  function runtimeFromBrowser() {
    return fetch('/env.json', { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('无法读取浏览器运行配置');
      return response.json();
    });
  }

  function validateRuntime(env) {
    if (!env || !env.base || !env.token || !env.cwd) {
      throw new Error('运行配置缺少 base、token 或 cwd');
    }
    return env;
  }

  function loadApplication(env) {
    window.KIMI_ENV = validateRuntime(env);
    var script = document.createElement('script');
    script.src = 'app.js';
    script.addEventListener('load', function () { status.phase = 'ready'; });
    script.addEventListener('error', function () { showFatal(new Error('app.js 加载失败')); });
    document.body.appendChild(script);
  }

  function showFatal(error) {
    status.phase = 'error';
    status.error = error && error.message ? error.message : String(error);
    var box = document.createElement('div');
    box.className = 'bootstrap-error';
    var title = document.createElement('strong');
    title.textContent = 'Kimi 2007 启动失败';
    var detail = document.createElement('span');
    detail.textContent = status.error;
    box.appendChild(title);
    box.appendChild(detail);
    document.body.appendChild(box);
  }

  var desktop = window.KimiDesktop;
  var runtimePromise = desktop && desktop.getRuntimeEnv ?
    desktop.getRuntimeEnv() : runtimeFromBrowser();
  Promise.resolve(runtimePromise).then(loadApplication).catch(showFatal);
})();
