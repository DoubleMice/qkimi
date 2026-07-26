  /* 标题栏的工作区归属小标：只在当前会话的 cwd 与本窗口工作区不同时出现
     （多窗口/「全部工作区」视图下才有歧义，同工作区时显示只是噪音）。 */
  function syncChatWs() {
    var chip = $('#chatWs');
    if (!chip) return;
    var s = findSession(state.sid);
    var cwd = (s && s.metadata && s.metadata.cwd) || '';
    if (!cwd || cwd === ENV.cwd) {
      chip.hidden = true;
      chip.textContent = '';
      return;
    }
    chip.hidden = false;
    chip.textContent = '📁 ' + (cwd.split('/').pop() || cwd);
    chip.title = '该会话属于工作区：' + cwd;
  }

  function permissionModeLabel(mode) {
    var labels = { manual: '手动许可', auto: '自动许可', yolo: '全部允许' };
    return labels[mode] || mode || '未知';
  }

  function permissionModeFrom(value) {
    if (!value) return '';
    return value.permission || value.permission_mode ||
      (value.agent_config && value.agent_config.permission_mode) ||
      (value.agent_config && value.agent_config.permission) || '';
  }

  function currentPermissionMode(sid) {
    var ui = uiFor(sid);
    if (ui && ui.permissionUpdating) return ui.permissionUpdating;
    /* 客户端已成功写入的权限优先：忙碌时 /status.permission 会落后，不能据此显示旧值。 */
    if (state.sessionPermission[sid]) return state.sessionPermission[sid];
    var fromStatus = permissionModeFrom(state.sessionStatus[sid]);
    if (fromStatus) return fromStatus;
    var fromSession = permissionModeFrom(findSession(sid));
    if (fromSession) return fromSession;
    return 'manual';
  }

  function syncPermissionControl(sid) {
    if (sid !== state.sid) return;
    var button = $('#permissionInfo');
    if (!button) return;
    var label = permissionModeLabel(currentPermissionMode(sid));
    button.textContent = '🛡️ ' + label + ' ▾';
    button.title = '选择当前会话权限模式（当前：' + label + '）';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('data-mode', currentPermissionMode(sid));
  }

  function updatePermissionMode(sid, mode) {
    var ui = uiFor(sid);
    if (!ui) return Promise.reject(new Error('会话不存在'));
    var requestGen = (state.permissionUpdateGen[sid] || 0) + 1;
    state.permissionUpdateGen[sid] = requestGen;
    ui.permissionUpdating = mode;
    /* 先给出可见反馈；仅在 /profile 写入失败时回滚。 */
    if (sid === state.sid) syncPermissionControl(sid);
    return api('/sessions/' + encodeURIComponent(sid) + '/profile', {
      method: 'POST',
      body: JSON.stringify({ agent_config: { permission_mode: mode } }),
    }).then(function (profile) {
      if (state.permissionUpdateGen[sid] !== requestGen) return null;
      mergeSessionSnapshot(profile);
      /* /profile 写入成功即代表权限已持久化到会话（下一轮生效）。
         注意：profile 响应的 agent_config 不回显 permission_mode，且 /status.permission
         是运行时值——会话忙碌时它仍是进行中回合的旧权限，落后属正常，不能据此判定切换失败
         （否则运行中切换会误报“服务端未应用”并把界面回退成旧值）。因此以本次写入的 mode 为准，
         /status 仅用于刷新模型、token 等其它运行时字段。若 profile 明确回显了不同值则以回显为准。 */
      var profileMode = permissionModeFrom(profile);
      var resolved = (profileMode && profileMode !== mode) ? profileMode : mode;
      /* 记为客户端权威值，忙碌时的 /status 旧值不再回退它。 */
      state.sessionPermission[sid] = resolved;
      return api('/sessions/' + encodeURIComponent(sid) + '/status').catch(function () {
        return null;
      }).then(function (status) {
        if (state.permissionUpdateGen[sid] !== requestGen) return null;
        ui.permissionUpdating = '';
        applySessionStatus(sid, Object.assign({}, status || {}, { permission: resolved }));
        return resolved;
      });
    }).catch(function (error) {
      if (state.permissionUpdateGen[sid] === requestGen) {
        ui.permissionUpdating = '';
        if (sid === state.sid) syncPermissionControl(sid);
      }
      throw error;
    });
  }
