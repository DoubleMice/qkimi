  /* ================= REST ================= */

  function refreshRuntimeEnv() {
    if (state.envRefreshPromise) return state.envRefreshPromise;
    var runtimeRequest = desktopApi && desktopApi.getRuntimeEnv ?
      desktopApi.getRuntimeEnv() :
      fetch('/env.json' + window.location.search, { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('无法刷新连接令牌');
        return res.json();
      });
    state.envRefreshPromise = Promise.resolve(runtimeRequest)
      .then(function (next) {
        if (!next || !next.token || !next.base) throw new Error('连接配置无效');
        ENV.base = next.base;
        ENV.token = next.token;
        if (next.model) ENV.model = next.model;
        if (next.cwd) ENV.cwd = next.cwd;
        return ENV;
      })
      .finally(function () { state.envRefreshPromise = null; });
    return state.envRefreshPromise;
  }

  function api(pathname, opts, retried) {
    opts = opts || {};
    var requestOpts = Object.assign({}, opts);
    var timeoutMs = requestOpts.timeoutMs == null ? 20000 : Math.max(1000, Number(requestOpts.timeoutMs) || 20000);
    delete requestOpts.timeoutMs;
    var timeoutController = null;
    var timeoutTimer = null;
    var timedOut = false;
    var callerSignal = requestOpts.signal || null;
    var callerAbortHandler = null;
    if (typeof AbortController !== 'undefined') {
      timeoutController = new AbortController();
      requestOpts.signal = timeoutController.signal;
      if (callerSignal) {
        callerAbortHandler = function () { timeoutController.abort(); };
        if (callerSignal.aborted) callerAbortHandler();
        else callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
      }
      timeoutTimer = setTimeout(function () {
        timedOut = true;
        timeoutController.abort();
      }, timeoutMs);
    }
    var baseHeaders = { Authorization: 'Bearer ' + ENV.token };
    if (opts.body != null && !(typeof FormData !== 'undefined' && opts.body instanceof FormData)) {
      baseHeaders['Content-Type'] = 'application/json';
    }
    requestOpts.headers = Object.assign(baseHeaders, opts.headers || {});
    return fetch(ENV.base + '/api/v1' + pathname, requestOpts).then(function (res) {
      if (res.status === 401 && !retried) {
        return refreshRuntimeEnv().then(function () { return api(pathname, opts, true); });
      }
      return res.json().then(function (j) {
        if (!res.ok || j.code !== 0) {
          var err = new Error(j.msg || ('HTTP ' + res.status));
          err.code = j.code;
          err.status = res.status;
          throw err;
        }
        return j.data;
      });
    }).catch(function (error) {
      if (timedOut) throw new Error('请求超时，请检查 Kimi 服务状态后重试');
      throw error;
    }).finally(function () {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (callerSignal && callerAbortHandler) callerSignal.removeEventListener('abort', callerAbortHandler);
    });
  }
