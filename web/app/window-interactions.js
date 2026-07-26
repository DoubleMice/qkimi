  /* ================= 窗口交互 ================= */

  function finishWindowClose() {
    if (desktopApi && desktopApi.isDesktop) {
      desktopApi.close();
      return;
    }
    win.classList.add('closing');
    setTimeout(function () { $('#bye').classList.add('show'); }, 300);
  }

  function requestWindowClose() {
    var ui = currentUi();
    var session = findSession(state.sid) || {};
    var pendingFiles = ui && (ui.pendingFiles.length + ui.detachedUploads.length) || 0;
    var busy = !!(session.busy || state.busy || ui && (ui.submitting || ui.waiting));
    if (!pendingFiles && !busy) {
      finishWindowClose();
      return;
    }
    var body = openPanel('关闭 Kimi 2007');
    var gen = panelGen;
    var note = [];
    if (busy) note.push('当前任务仍在运行；关闭窗口不会自动停止本机 Kimi 服务。');
    if (pendingFiles) note.push('有 ' + pendingFiles + ' 个未发送附件或后台清理任务，会在关闭前处理完毕。');
    body.innerHTML = '<p class="p-note">' + note.map(esc).join('<br>') + '</p>' +
      '<div class="p-actions"><button class="ap-btn" id="closeCancel" type="button">继续编辑</button>' +
      '<button class="ap-btn no" id="closeConfirm" type="button">仍然关闭</button></div>';
    var cancel = body.querySelector('#closeCancel');
    var confirm = body.querySelector('#closeConfirm');
    cancel.addEventListener('click', closePanel);
    confirm.addEventListener('click', function () {
      cancel.disabled = confirm.disabled = true;
      confirm.textContent = '正在关闭…';
      discardPendingFiles(state.sid).finally(function () {
        if (panelIsCurrent(body, gen)) closePanel();
        finishWindowClose();
      });
    });
  }

  if (desktopApi && desktopApi.isDesktop) {
    $('#btnMin').addEventListener('click', function () { desktopApi.minimize(); });
    $('#btnMax').addEventListener('click', function () { desktopApi.toggleMaximize(); });
    $('#btnClose').addEventListener('click', requestWindowClose);
    $('#titlebar').addEventListener('dblclick', function (e) {
      if (!e.target.closest('.tbtn')) desktopApi.toggleMaximize();
    });
    desktopApi.onWindowState(function (windowState) {
      var maximized = !!(windowState && windowState.maximized);
      win.classList.toggle('native-maximized', maximized);
      $('#btnMax').title = maximized ? '还原' : '最大化';
      $('#btnMax').setAttribute('aria-pressed', maximized ? 'true' : 'false');
    });
  } else {
    var dragging = false, offX = 0, offY = 0;

    $('#titlebar').addEventListener('mousedown', function (e) {
      if (e.target.closest('.tbtn')) return;
      if (win.classList.contains('maximized')) return;
      dragging = true;
      var r = win.getBoundingClientRect();
      win.style.position = 'fixed';
      win.style.left = r.left + 'px';
      win.style.top = r.top + 'px';
      win.style.margin = '0';
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      win.style.left = (e.clientX - offX) + 'px';
      win.style.top = (e.clientY - offY) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });

    $('#btnMin').addEventListener('click', function () {
      win.classList.add('minimized');
      setTimeout(function () { win.classList.remove('minimized'); }, 1100);
    });

    $('#btnMax').addEventListener('click', function () {
      win.classList.toggle('maximized');
      if (win.classList.contains('maximized')) {
        win.style.position = '';
        win.style.left = '';
        win.style.top = '';
      }
    });

    $('#btnClose').addEventListener('click', requestWindowClose);
    $('#bye').addEventListener('click', function () {
      $('#bye').classList.remove('show');
      win.classList.remove('closing');
    });
  }
