  /* ================= 命令面板(⌘/Ctrl + K) ================= */
  var cmdk = $('#cmdk');
  var cmdkBackdrop = $('#cmdkBackdrop');
  var cmdkInput = $('#cmdkInput');
  var cmdkList = $('#cmdkList');
  var cmdkReturnFocus = null;
  var cmdkItems = [];      // 当前过滤后的可执行命令(扁平，供键盘导航)
  var cmdkActive = 0;

  function cmdkOpen() { return !cmdk.hidden; }

  /* 构建命令清单：静态动作 + 面板入口 + 权限模式 + 已加载模型 + 会话跳转。
     每条 { id, group, ico, title, hint, key, keywords, run }。run 执行后默认关闭面板。 */
  function buildCommands() {
    var cmds = [];
    cmds.push({ group: '操作', ico: '＋', title: '新建会话', key: '⌘N', keywords: 'new session xinjian huihua', run: function () { newSession(); } });
    if (state.busy) {
      cmds.push({ group: '操作', ico: '■', title: '停止当前回答', key: '⌘.', keywords: 'stop abort tingzhi', run: function () { abort(); } });
    }
    cmds.push({ group: '操作', ico: '📤', title: '导出会话 Markdown', keywords: 'export markdown daochu', run: function () { exportSessionMarkdown(); } });

    cmds.push({ group: '面板', ico: '🧩', title: '模型与工具', key: '⌘⇧M', keywords: 'model tools plugin moxing gongju', run: function () { showPlugins(); } });
    cmds.push({ group: '面板', ico: '🌐', title: '工作区', keywords: 'workspace sites gongzuoqu', run: function () { showSites(); } });
    cmds.push({ group: '面板', ico: '🔀', title: 'Git 检查', keywords: 'git pr jiancha', run: function () { showGit(); } });
    cmds.push({ group: '面板', ico: '🗓️', title: '临时提醒', keywords: 'schedule remind tixing', run: function () { showSchedule(); } });
    cmds.push({ group: '面板', ico: '🖥️', title: '界面布局', keywords: 'layout size buj1u chicun', run: function () { showLayout(); } });
    cmds.push({ group: '面板', ico: '🛡️', title: '会话权限模式', keywords: 'permission quanxian mode', run: function () { showPermissionModes(); } });
    cmds.push({ group: '面板', ico: '☷', title: '活动中心', key: '⌘⇧A', keywords: 'activity huodong', run: function () { openActivityCenter(); } });
    cmds.push({ group: '面板', ico: '⌨', title: '快捷键', keywords: 'shortcut kuaijiejian help', run: function () { showShortcuts(); } });
    cmds.push({ group: '面板', ico: '⭐', title: '搜索收藏', keywords: 'favorite shoucang zhishiku', run: function () { showFavorites(cmdkInput.value); } });
    if (state.sid) {
      cmds.push({ group: '面板', ico: '🏷', title: '会话标签', keywords: 'tag biaoqian huihua', run: function () { showSessionTags(state.sid); } });
    }

    [{ mode: 'time', title: '按时间排序' }, { mode: 'tag', title: '按标签分组' }, { mode: 'date', title: '按日期分组' }, { mode: 'workspace', title: '按工作区分组' }].forEach(function (g) {
      if (g.mode === state.sessGroup) return;   /* 当前分组方式不重复列出 */
      cmds.push({
        group: '会话', ico: '☷', title: g.title,
        keywords: 'group fenzu biaoqian riqi shijian',
        run: function () {
          setSessGroup(g.mode);
          notifyUi('会话列表：' + g.title);
        },
      });
    });

    if (state.sid) {
      var curPerm = currentPermissionMode(state.sid);
      [{ id: 'manual', label: '手动许可' }, { id: 'auto', label: '自动许可' }, { id: 'yolo', label: '全部允许' }].forEach(function (m) {
        if (m.id === curPerm) return;   /* 当前模式不重复列出 */
        cmds.push({
          group: '权限', ico: '🛡️', title: '切换权限：' + m.label,
          hint: m.id === 'yolo' ? '高风险，需二次确认' : '',
          keywords: 'permission quanxian ' + m.id + ' ' + m.label,
          run: function () { cmdkSetPermission(m.id); },
        });
      });
    }

    if (state.sid && state.models.length) {
      var curModel = sessionModel(state.sid);
      state.models.forEach(function (model) {
        var alias = modelAlias(model);
        if (!alias || alias === curModel) return;
        var label = model.display_name || model.model || alias;
        cmds.push({
          group: '模型', ico: '🤖', title: '切换模型：' + label,
          keywords: 'model moxing ' + alias + ' ' + label,
          run: function () { setSessionModel(alias, label).catch(function () {}); },
        });
      });
    }

    state.sessions.forEach(function (s) {
      if (s.id === state.sid) return;
      var title = s.title || '新会话';
      cmds.push({
        group: '会话', ico: '💬', title: title,
        hint: (s.busy ? '进行中 · ' : '') + '切换到此会话',
        keywords: 'session huihua ' + title,
        run: function () { switchSession(s.id); },
      });
    });
    return cmds;
  }

  /* “全部允许”保留二次确认：走权限面板而非直接切换；其余模式直接切。 */
  function cmdkSetPermission(mode) {
    if (!state.sid) { notifyUi('请先打开一个会话', 'error'); return; }
    if (mode === 'yolo') { showPermissionModes(); return; }
    updatePermissionMode(state.sid, mode).then(function (resolved) {
      if (resolved && state.sid) {
        syncPermissionControl(state.sid);
        notifyUi('权限模式已切换为“' + permissionModeLabel(resolved) + '”');
      }
    }).catch(function (err) { notifyUi('切换权限失败：' + err.message, 'error'); });
  }

  function cmdkFilter(all, q) {
    q = q.trim().toLowerCase();
    if (!q) return all;
    var terms = q.split(/\s+/);
    return all.filter(function (c) {
      var hay = (c.title + ' ' + (c.keywords || '')).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
  }

  function cmdkRender() {
    var q = cmdkInput.value;
    var matched = cmdkFilter(buildCommands(), q);
    cmdkItems = matched;
    if (cmdkActive >= matched.length) cmdkActive = matched.length ? matched.length - 1 : 0;
    cmdkList.innerHTML = '';
    if (!matched.length) {
      var empty = document.createElement('div');
      empty.className = 'cmdk-empty';
      empty.textContent = '没有匹配的命令';
      cmdkList.appendChild(empty);
      cmdkInput.setAttribute('aria-activedescendant', '');
      return;
    }
    var lastGroup = null;
    var flatIndex = 0;
    matched.forEach(function (c) {
      if (c.group !== lastGroup) {
        lastGroup = c.group;
        var g = document.createElement('div');
        g.className = 'cmdk-group';
        g.textContent = c.group;
        cmdkList.appendChild(g);
      }
      var idx = flatIndex++;
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'cmdk-item' + (idx === cmdkActive ? ' cmdk-active' : '');
      item.id = 'cmdkItem-' + idx;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', idx === cmdkActive ? 'true' : 'false');
      item.innerHTML =
        '<span class="cmdk-item-ico" aria-hidden="true">' + esc(c.ico || '•') + '</span>' +
        '<span class="cmdk-item-body"><span class="cmdk-item-title">' + esc(c.title) + '</span>' +
        (c.hint ? '<span class="cmdk-item-hint">' + esc(c.hint) + '</span>' : '') + '</span>' +
        (c.key ? '<span class="cmdk-item-key">' + esc(c.key) + '</span>' : '');
      item.addEventListener('click', function () { cmdkRun(idx); });
      item.addEventListener('mousemove', function () {
        if (cmdkActive === idx) return;
        cmdkActive = idx;
        cmdkSyncActive();
      });
      cmdkList.appendChild(item);
    });
    cmdkSyncActive();
  }

  function cmdkSyncActive() {
    var items = cmdkList.querySelectorAll('.cmdk-item');
    items.forEach(function (el, i) {
      var on = i === cmdkActive;
      el.classList.toggle('cmdk-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        cmdkInput.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function cmdkRun(idx) {
    var cmd = cmdkItems[idx];
    if (!cmd) return;
    cmdkClose(true);
    cmd.run();
  }

  function cmdkShow() {
    if (cmdkOpen()) { cmdkInput.focus(); cmdkInput.select(); return; }
    cmdkReturnFocus = document.activeElement;
    closeAllPopups();
    closeMobileDrawers();
    cmdkInput.value = '';
    cmdkActive = 0;
    cmdkBackdrop.hidden = false;
    cmdk.hidden = false;
    cmdkRender();
    /* 后台加载模型清单，就绪后若面板仍开着则重渲染以补上模型命令。 */
    loadModels().then(function () { if (cmdkOpen()) cmdkRender(); }).catch(function () {});
    cmdkInput.focus();
  }

  function cmdkClose(skipFocus) {
    if (!cmdkOpen()) return;
    cmdk.hidden = true;
    cmdkBackdrop.hidden = true;
    cmdkInput.setAttribute('aria-activedescendant', '');
    if (!skipFocus && cmdkReturnFocus && document.contains(cmdkReturnFocus)) cmdkReturnFocus.focus();
    cmdkReturnFocus = null;
  }

  cmdkInput.addEventListener('input', function () { cmdkActive = 0; cmdkRender(); });
  cmdkBackdrop.addEventListener('click', function () { cmdkClose(); });
  cmdkInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdkItems.length) { cmdkActive = (cmdkActive + 1) % cmdkItems.length; cmdkSyncActive(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdkItems.length) { cmdkActive = (cmdkActive - 1 + cmdkItems.length) % cmdkItems.length; cmdkSyncActive(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      cmdkRun(cmdkActive);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cmdkClose();
    }
  });

  function editableTarget(target) {
    return !!(target && (target.matches('input, textarea, select') || target.isContentEditable));
  }
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.isComposing) return;
    /* 命令面板打开时，其输入框自行处理导航键，其余全局快捷键让路(⌘K 除外，用于再次聚焦)。 */
    if (cmdkOpen()) {
      var cmdKey = e.metaKey || e.ctrlKey;
      if (cmdKey && String(e.key || '').toLowerCase() === 'k') { e.preventDefault(); cmdkShow(); }
      return;
    }
    if (!$('#panel').hidden) return;
    var key = String(e.key || '').toLowerCase();
    var command = e.metaKey || e.ctrlKey;
    var openDrawer = sideLeft.classList.contains('mobile-open') ? sideLeft :
      (sideRight.classList.contains('mobile-open') ? sideRight : null);
    if (openDrawer && e.key === 'Tab') {
      var drawerFocusables = Array.prototype.slice.call(openDrawer.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )).filter(function (el) { return !el.hidden && el.offsetParent !== null; });
      if (drawerFocusables.length) {
        var drawerFirst = drawerFocusables[0];
        var drawerLast = drawerFocusables[drawerFocusables.length - 1];
        if (e.shiftKey && document.activeElement === drawerFirst) {
          e.preventDefault();
          drawerLast.focus();
        } else if (!e.shiftKey && document.activeElement === drawerLast) {
          e.preventDefault();
          drawerFirst.focus();
        }
      }
      return;
    }
    /* 焦点不在可编辑控件时,Home/End 滚动聊天区到顶/到底 */
    if ((e.key === 'Home' || e.key === 'End') && !command && !editableTarget(e.target)) {
      e.preventDefault();
      if (e.key === 'Home') chatBody.scrollTop = 0;
      else scrollBottom();
      return;
    }
    if (e.key === 'Escape') {
      var hadDrawer = !!openDrawer;
      var popoverReturn = null;
      popupSpecs().forEach(function (p) {
        if (!popoverReturn && p.el && p.el.classList.contains('show')) popoverReturn = p.trigger;
      });
      closeAllPopups();
      closeMobileDrawers(hadDrawer);
      if (!hadDrawer && popoverReturn) popoverReturn.focus();
      return;
    }
    if (command && key === '.' && state.busy) {
      e.preventDefault();
      abort();
      return;
    }
    if (command && key === 'k') {
      e.preventDefault();
      cmdkShow();
      return;
    }
    if (command && key === 'n') {
      e.preventDefault();
      newSession();
      return;
    }
    if (command && e.shiftKey && key === 'a') {
      e.preventDefault();
      $('#activityToggle').click();
      return;
    }
    if (command && e.shiftKey && key === 'm') {
      e.preventDefault();
      showPlugins();
      return;
    }
    if (e.key === '?' && !editableTarget(e.target)) {
      e.preventDefault();
      showShortcuts();
    }
  });
