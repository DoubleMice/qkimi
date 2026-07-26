  /* ================= WebSocket ================= */

  var wsIdCounter = 1;
  function nextWsId() { return wsIdCounter++; }

  function wsSend(obj) {
    if (state.ws && state.wsOpen) {
      try { state.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  function subscribe(sid) {
    var cursors = {};
    cursors[sid] = { seq: state.lastSeq[sid] || 0 };
    if (state.epochs[sid]) cursors[sid].epoch = state.epochs[sid];
    wsSend({ type: 'subscribe', id: nextWsId(), payload: { session_ids: [sid], cursors: cursors } });
  }

  function connectWS(manual) {
    if (!state.sid) return;
    if (manual) {
      state.reconnectAttempts = 0;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
    }

    var ws;
    try {
      ws = new WebSocket(ENV.base.replace(/^http/, 'ws') + '/api/v1/ws?client_id=qq2007_' + Date.now(),
        ['kimi-code.bearer.' + ENV.token]);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    var previous = state.ws;
    var generation = ++state.wsGeneration;
    state.ws = ws;
    state.wsOpen = false;
    setConn(false, '连接中');
    try { if (previous && previous !== ws) previous.close(); } catch (e2) { /* ignore */ }

    ws.onopen = function () {
      if (state.ws !== ws || state.wsGeneration !== generation) return;
      state.wsOpen = true;
      state.reconnectAttempts = 0;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      setConn(true, '已连接');
      subscribe(state.sid);
      if (state.wsReconnectPending) {
        state.wsReconnectPending = false;
        setPetMode('idle'); /* 重连成功：宠物醒来 */
        resyncSessionRuntime(state.sid);
      }
    };
    ws.onmessage = function (ev) {
      if (state.ws !== ws || state.wsGeneration !== generation) return;
      var f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      handleFrame(f);
    };
    ws.onclose = function () {
      if (state.ws !== ws || state.wsGeneration !== generation) return;
      state.wsOpen = false;
      state.ws = null;
      /* 标记经历过断线：断线期间服务端运行态可能已变（例如服务重启后权限回退为默认值），
         重连成功后需回读 /status 纠偏，否则 UI 会一直显示断线前的旧权限。 */
      state.wsReconnectPending = true;
      /* 断连期间宠物入睡；重连成功后在 onopen 里唤醒 */
      setPetMode('sleeping');
      showPetBubble('😴 连接断了…');
      setConn(false, '未连接');
      scheduleReconnect();
    };
    ws.onerror = function () { /* onclose 会跟上 */ };
  }

  /* 重连成功后回读 /status 同步运行态（权限、模型、上下文用量等）。
     applySessionStatus 仅在会话空闲时回写 sessionPermission，
     忙碌回合 /status.permission 仍是进行中回合的旧值，不会误覆盖用户刚写入的选择。 */
  function resyncSessionRuntime(sid) {
    if (!sid) return;
    var prevMode = currentPermissionMode(sid);
    api('/sessions/' + encodeURIComponent(sid) + '/status')
      .then(function (status) {
        applySessionStatus(sid, status);
        var nextMode = currentPermissionMode(sid);
        if (sid === state.sid && nextMode !== prevMode) {
          notifyUi('连接已恢复，当前会话权限模式为：' + permissionModeLabel(nextMode));
        }
      })
      .catch(function () { /* 忽略瞬时失败，后续 hydrate / 状态事件会补齐 */ });
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setConn(false, '网络离线');
      return;
    }
    var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(state.reconnectAttempts, 5)));
    state.reconnectAttempts++;
    setConn(false, '重连中 ' + Math.ceil(delay / 1000) + 's');
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      refreshRuntimeEnv().catch(function () { return ENV; }).then(function () { connectWS(false); });
    }, delay);
  }

  window.addEventListener('online', function () {
    if (!state.wsOpen) connectWS(true);
  });
  window.addEventListener('offline', function () {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    setConn(false, '网络离线');
  });
