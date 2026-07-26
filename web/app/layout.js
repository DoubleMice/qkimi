  /* ---------------- 导航功能 ---------------- */
  function activateNav(id) {
    $$('.sl-nav .sl-item').forEach(function (i) { i.classList.toggle('active', i.id === id); });
  }

  function focusChat() {
    activateNav(null);
    input.focus();
    scrollBottom();
  }

  /* 左栏导航高亮 */
  $$('.sl-nav .sl-item').forEach(function (item) {
    item.addEventListener('click', function () {
      activateNav(item.id);
    });
  });
  $('#slPlugins').addEventListener('click', showPlugins);
  $('#slSites').addEventListener('click', showSites);
  $('#slGit').addEventListener('click', showGit);
  $('#slSchedule').addEventListener('click', showSchedule);

  /* ---------------- 右栏控制 ---------------- */
  var sideRight = $('#activityPanel');
  var sideLeft = $('.side-left');
  var mobileBackdrop = $('#mobileBackdrop');
  var drawerReturnFocus = null;

  function compactLayout() {
    /* 用户可手动锁定为“全尺寸”(full) 或“紧凑/抽屉”(compact)。
       full 锁定优先于响应式：即便物理宽度≤840px 也保持三栏；
       compact 锁定同理，强制抽屉。auto 时跟随窗口宽度自动切换。 */
    var lock = state.layoutLock;
    if (lock === 'full') return false;
    if (lock === 'compact') return true;
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 840px)').matches;
  }

  function syncDrawerControls() {
    var compact = compactLayout();
    var leftOpen = compact ? sideLeft.classList.contains('mobile-open') : true;
    /* 三栏形态下右栏不是抽屉，展开态就是「没有被收起」。 */
    var rightOpen = !sideRight.classList.contains('is-hidden') &&
      (!compact || sideRight.classList.contains('mobile-open'));
    $('#sessionsToggle').setAttribute('aria-expanded', leftOpen ? 'true' : 'false');
    $('#activityToggle').setAttribute('aria-expanded', rightOpen ? 'true' : 'false');
  }

  function syncMobileBackdrop() {
    var leftOpen = compactLayout() && sideLeft.classList.contains('mobile-open');
    var rightOpen = compactLayout() && sideRight.classList.contains('mobile-open');
    var active = leftOpen || rightOpen;
    mobileBackdrop.hidden = !active;
    $('.chat').inert = active;
    sideLeft.inert = rightOpen;
    sideRight.inert = leftOpen;
    syncDrawerControls();
  }

  function closeMobileDrawers(restoreFocus) {
    sideLeft.classList.remove('mobile-open');
    sideRight.classList.remove('mobile-open');
    syncMobileBackdrop();
    if (restoreFocus && drawerReturnFocus && document.contains(drawerReturnFocus)) drawerReturnFocus.focus();
    drawerReturnFocus = null;
  }

  function setRightHidden(hidden) {
    sideRight.classList.toggle('is-hidden', hidden);
    if (hidden) sideRight.classList.remove('mobile-open');
    $('#srReopen').hidden = !hidden || compactLayout();
    /* 右栏收起后窗口右下角就是发送按钮组，宠物会压在上面；交给 CSS 按此标记隐藏。 */
    document.documentElement.setAttribute('data-activity', hidden ? 'hidden' : 'shown');
    localStorage.setItem('kimi2007.rightHidden', hidden ? 'on' : 'off');
    syncMobileBackdrop();
  }

  setRightHidden(localStorage.getItem('kimi2007.rightHidden') === 'on');

  $('#srHide').addEventListener('click', function () {
    setRightHidden(true);
    if (compactLayout()) $('#activityToggle').focus();
  });
  $('#srReopen').addEventListener('click', function () {
    setRightHidden(false);
    renderActivityCenter();
  });
  $('#activityRetry').addEventListener('click', function () {
    refreshActivity(state.sid).catch(function () { /* 面板会显示具体错误 */ });
  });
  $('#mobileBackdrop').addEventListener('click', function () { closeMobileDrawers(true); });
  $('#sessionsToggle').addEventListener('click', function (event) {
    if (!compactLayout()) {
      searchEl.focus();
      return;
    }
    sideRight.classList.remove('mobile-open');
    var open = !sideLeft.classList.contains('mobile-open');
    sideLeft.classList.toggle('mobile-open', open);
    drawerReturnFocus = open ? event.currentTarget : null;
    syncMobileBackdrop();
    if (open) requestAnimationFrame(function () { searchEl.focus(); });
  });
  /* 活动中心入口分两种语义：按钮/⌘⇧A 是开关，命令面板的「打开活动中心」「/tasks」是只开不关。 */
  function openActivityCenter(returnFocusFrom) {
    setRightHidden(false);
    if (!compactLayout()) {
      renderActivityCenter();
      sideRight.focus && sideRight.focus();
      return;
    }
    sideLeft.classList.remove('mobile-open');
    sideRight.classList.add('mobile-open');
    drawerReturnFocus = returnFocusFrom || null;
    syncMobileBackdrop();
    renderActivityCenter();
    requestAnimationFrame(function () {
      var first = sideRight.querySelector('button:not([hidden]):not([disabled])');
      (first || sideRight).focus();
    });
  }

  $('#activityToggle').addEventListener('click', function (event) {
    if (!compactLayout()) {
      /* 三栏形态下这是一个真开关：原先无条件 setRightHidden(false)，
         ⌘⇧A 与按钮都只能打开、关不掉。 */
      if (sideRight.classList.contains('is-hidden')) {
        openActivityCenter();
      } else {
        setRightHidden(true);
        $('#srReopen').focus();
      }
      return;
    }
    if (!sideRight.classList.contains('is-hidden') && sideRight.classList.contains('mobile-open')) {
      closeMobileDrawers(true);
      return;
    }
    openActivityCenter(event.currentTarget);
  });
  window.addEventListener('resize', function () {
    /* 宽度变化会改变换行，输入框高度需要随内容重新计算。 */
    resizeComposer();
    /* auto 锁定下，宽度跨越 840px 断点时形态变化；full/compact 锁定不随宽度变。 */
    if (state.layoutLock === 'auto') document.documentElement.setAttribute('data-layout', effectiveLayoutMode());
    if (!compactLayout()) {
      closeMobileDrawers();
      $('#srReopen').hidden = !sideRight.classList.contains('is-hidden');
    }
  });

  /* ---------------- 状态栏操作 ---------------- */
  function showAbout() {
    var body = openPanel('关于 Kimi 2007');
    var gen = panelGen;
    api('/meta').then(function (m) {
      if (!panelIsCurrent(body, gen)) return;
      body.innerHTML = '<div class="p-note">Kimi 2007 是使用 AppKit + WKWebView 的轻量 macOS 客户端。</div>' +
        '<div class="p-row"><span>客户端界面</span><span class="p-dim">复古 QQ 皮肤 v4</span></div>' +
        '<div class="p-row"><span>Kimi Server</span><span class="p-dim">v' + esc(m.server_version || '?') + '</span></div>' +
        '<div class="p-row"><span>Backend</span><span class="p-dim">' + esc(m.backend || '?') + '</span></div>';
    }).catch(function (error) {
      if (panelIsCurrent(body, gen)) body.innerHTML = '<div class="p-note p-health-error">无法获取服务器信息：' + esc(error.message) + '</div>';
    });
  }
  $('#stCopyCwd').addEventListener('click', function () {
    var cwd = currentCwd();
    writeClipboard(cwd).then(
      function () { notifyUi('工作目录已复制：' + cwd, 'ok'); },
      function () { notifyUi('复制失败，工作目录是：' + cwd, 'error'); }
    );
  });

  connStatus.title = '点击重新连接';
  connStatus.addEventListener('click', function () {
    notifyUi('正在重新连接…');
    connectWS(true);
  });

  $('#permissionInfo').addEventListener('click', showPermissionModes);
  $('#exportMdBtn').addEventListener('click', exportSessionMarkdown);

  /* ---------------- 左上角 Kimi 菜单 ---------------- */
  var slMenu = $('#slMenu');
  $('#slMenuBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    var open = togglePopup(slMenu, $('#slMenuBtn'));
    if (open) {
      var first = slMenu.querySelector('button');
      if (first) first.focus();
    }
  });

  function wirePopupKeyboard(container, trigger) {
    container.addEventListener('keydown', function (event) {
      var buttons = Array.prototype.slice.call(container.querySelectorAll('button:not([disabled])'));
      if (!buttons.length) return;
      var index = buttons.indexOf(document.activeElement);
      var next = -1;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePopup(container);
        trigger.focus();
        return;
      }
      if (next >= 0) {
        event.preventDefault();
        buttons[next].focus();
      }
    });
  }

  wirePopupKeyboard(emojiPop, $('#emojiBtn'));
  wirePopupKeyboard(modelMenu, $('#modelBtn'));
  wirePopupKeyboard(sendModeMenu, $('#sendMore'));
  wirePopupKeyboard(slMenu, $('#slMenuBtn'));

  function showShortcuts() {
    var body = openPanel('⌨ 快捷键');
    body.innerHTML = '<div class="p-note">常用操作不再占用额外按钮，可直接使用以下快捷键。</div>' +
      '<div class="p-row"><span>命令面板（命令 / 会话 / 模型）</span><span class="p-dim">⌘ / Ctrl + K</span></div>' +
      '<div class="p-row"><span>新建会话</span><span class="p-dim">⌘ / Ctrl + N</span></div>' +
      '<div class="p-row"><span>活动中心</span><span class="p-dim">⌘ / Ctrl + Shift + A</span></div>' +
      '<div class="p-row"><span>模型与工具</span><span class="p-dim">⌘ / Ctrl + Shift + M</span></div>' +
      '<div class="p-row"><span>停止当前回答</span><span class="p-dim">⌘ / Ctrl + .</span></div>' +
      '<div class="p-row"><span>导出会话 Markdown</span><span class="p-dim">聊天标题栏 📤 按钮</span></div>' +
      '<div class="p-row"><span>关闭弹层</span><span class="p-dim">Esc</span></div>';
  }
  $('#slShortcuts').addEventListener('click', function () {
    closePopup(slMenu);
    $('#slMenuBtn').focus();
    showShortcuts();
  });
  $('#slAbout').addEventListener('click', function () {
    closePopup(slMenu);
    $('#slMenuBtn').focus();
    showAbout();
  });

  /* ---------------- 界面布局：QQ 风格“尺寸模式”切换 ---------------- */
  var LAYOUT_LABELS = {
    auto: '跟随窗口',
    full: '全尺寸（三栏）',
    compact: '紧凑（抽屉）',
  };
  function effectiveLayoutMode() {
    /* 当前实际生效的形态：auto 锁定下取响应式判定。 */
    return compactLayout() ? 'compact' : 'full';
  }
  function applyLayoutLock() {
    /* full 锁定时即便物理窄屏也保留三栏；compact 锁定强制抽屉；auto 跟随 matchMedia。 */
    document.documentElement.setAttribute('data-layout-lock', state.layoutLock);
    document.documentElement.setAttribute('data-layout', effectiveLayoutMode());
    if (!compactLayout()) {
      closeMobileDrawers();
      $('#srReopen').hidden = !sideRight.classList.contains('is-hidden');
    }
    syncMobileBackdrop();
    resizeComposer();
  }
  function showLayout() {
    var body = openPanel('🖥️ 界面布局');
    var gen = panelGen;
    var modes = [
      { id: 'auto', title: '跟随窗口', note: '宽度 >840px 三栏，否则自动改用抽屉（默认）。' },
      { id: 'full', title: '全尺寸（三栏）', note: '锁定左·中·右三栏并排，即使窗口变窄也保持。' },
      { id: 'compact', title: '紧凑（抽屉）', note: '锁定为窄版：左右栏收成抽屉，聊天主区占满宽度。' },
    ];
    var html = '<p class="p-permission-intro">切换“复古 QQ 尺寸模式”。选择立即生效并记住，不影响其它会话或服务端设置。</p>';
    modes.forEach(function (mode) {
      var active = state.layoutLock === mode.id;
      html += '<button class="p-permission-option' + (active ? ' p-selected' : '') + '" type="button" data-layout="' + mode.id + '"' +
        (active ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        '<span class="p-permission-name">' + (active ? '✓ ' : '') + mode.title + '</span>' +
        '<span class="p-permission-note">' + mode.note + '</span></button>';
    });
    html += '<div class="p-row"><span>当前生效</span><span class="p-dim">' + esc(LAYOUT_LABELS[effectiveLayoutMode()]) + '</span></div>';
    body.innerHTML = html;
    $$('.p-permission-option', body).forEach(function (button) {
      button.addEventListener('click', function () {
        var mode = button.getAttribute('data-layout');
        if (!mode || mode === state.layoutLock) { closePanel(); return; }
        $$('.p-permission-option', body).forEach(function (item) { item.disabled = true; });
        button.disabled = true;
        state.layoutLock = mode;
        localStorage.setItem('kimi2007.layout', mode);
        applyLayoutLock();
        if (panelIsCurrent(body, gen)) closePanel();
        notifyUi('界面布局：' + LAYOUT_LABELS[mode]);
      });
    });
  }
  $('#slLayout').addEventListener('click', function () {
    closePopup(slMenu);
    $('#slMenuBtn').focus();
    showLayout();
  });
  applyLayoutLock();
