  /* ================= 启动 ================= */

  (function boot() {
    setConn(false, '连接中');
    updateComposerState();
    loadSessions()
      .then(function (items) {
        var stored = null;
        try {
          stored = (JSON.parse(localStorage.getItem('kimi2007.sidByWs') || '{}'))[ENV.cwd] || null;
        } catch (e) { stored = null; }
        if (!stored) stored = localStorage.getItem('kimi2007.sid');
        var pick = null;
        for (var i = 0; i < items.length; i++) {
          if (items[i].id === stored) { pick = items[i]; break; }
        }
        if (!pick) pick = items[0];
        if (pick) {
          state.sid = pick.id;
          localStorage.setItem('kimi2007.sid', pick.id);
          rememberSidForWorkspace(pick.id);
          applyTitle(pick.title);
        }
        return pick ? Promise.resolve(pick) : createSession().then(function (s) {
          state.sid = s.id;
          localStorage.setItem('kimi2007.sid', s.id);
          rememberSidForWorkspace(s.id);
          applyTitle(null);
          return loadSessions();
        });
      })
      .then(function () {
        renderSessionList();
        restoreComposer(state.sid);
        syncModelButton();
        return hydrateSession(state.sid, { replaceMessages: true }).catch(function (e) {
          queueSessionNotice(state.sid, '完整状态恢复失败，已回退到消息列表: ' + e.message);
          return refreshMessages();
        });
      })
      .then(function () {
        if (!Object.keys(state.rendered).length) showChatEmpty();
        connectWS(false);
      })
      .catch(function (e) {
        setConn(false, '连接失败');
        appendSys('⚠ 连不上 kimi server(' + ENV.base + '):' + e.message +
          (desktopApi ? ' —— 请确认 Kimi CLI 已安装并完成登录' : ' —— 请确认已运行 node serve.js'));
      });
  })();