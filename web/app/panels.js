  /* ================= 通用面板 ================= */

  var panelGen = 0;
  var panelReturnFocus = null;

  function openPanel(title) {
    panelGen++;
    if ($('#panel').hidden) panelReturnFocus = document.activeElement;
    $('#panel').classList.remove('favorites-panel');
    $('#panelTitle').textContent = title;
    var body = $('#panelBody');
    body.setAttribute('data-panel-gen', String(panelGen));
    body.innerHTML = '<div class="panel-loading">加载中…</div>';
    closeAllPopups();
    $('#panelBackdrop').hidden = false;
    $('#panel').hidden = false;
    requestAnimationFrame(function () { $('#panelClose').focus(); });
    return body;
  }

  function panelIsCurrent(body, expectedGen) {
    return !$('#panel').hidden && expectedGen === panelGen &&
      body.getAttribute('data-panel-gen') === String(expectedGen);
  }

  function closePanel() {
    panelGen++;
    $('#panel').hidden = true;
    $('#panelBackdrop').hidden = true;
    $('#permissionInfo').setAttribute('aria-expanded', 'false');
    activateNav(null);
    if (panelReturnFocus && document.contains(panelReturnFocus)) panelReturnFocus.focus();
    panelReturnFocus = null;
  }

  $('#panelClose').addEventListener('click', closePanel);
  $('#panelBackdrop').addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) {
    var panel = $('#panel');
    if (panel.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
      return;
    }
    if (e.key === 'Tab') {
      var focusable = Array.prototype.slice.call(panel.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(function (el) { return !el.hidden && el.offsetParent !== null; });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  /* ---------------- 权限模式：仅更新当前会话的 agent_config ---------------- */
  function showPermissionModes() {
    var sid = state.sid;
    if (!sid) {
      notifyUi('请先打开一个会话', 'error');
      return;
    }
    var body = openPanel('🛡️ 会话权限模式');
    $('#permissionInfo').setAttribute('aria-expanded', 'true');
    var gen = panelGen;
    var selected = currentPermissionMode(sid);
    var modes = [
      { id: 'manual', title: '手动许可', note: '每次需要授权的操作都由你确认。' },
      { id: 'auto', title: '自动许可', note: '按服务端的自动许可策略执行。' },
      { id: 'yolo', title: '全部允许', note: '高风险：跳过操作前的逐次确认。' },
    ];
    var html = '<p class="p-permission-intro">此设置只作用于当前会话，不会改变其他会话或默认设置。</p>';
    modes.forEach(function (mode) {
      var active = selected === mode.id;
      html += '<button class="p-permission-option' + (active ? ' p-selected' : '') +
        (mode.id === 'yolo' ? ' p-permission-risk' : '') + '" type="button" data-mode="' + mode.id + '"' +
        (active ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        '<span class="p-permission-name">' + (active ? '✓ ' : '') + mode.title + '</span>' +
        '<span class="p-permission-note">' + mode.note + '</span></button>';
    });
    body.innerHTML = html;
    function saveMode(mode, trigger) {
      $$('.p-permission-option', body).forEach(function (item) { item.disabled = true; });
      trigger.disabled = true;
      var note = trigger.querySelector('.p-permission-note');
      var name = trigger.querySelector('.p-permission-name');
      if (note) note.textContent = '正在保存…';
      updatePermissionMode(sid, mode).then(function (resolved) {
        if (!resolved) return;
        /* selected 是面板打开时读取的快照；切换成功后更新它，避免后续按“同模式”误判。 */
        selected = resolved;
        if (sid === state.sid) {
          syncPermissionControl(sid);
          notifyUi('权限模式已切换为“' + permissionModeLabel(resolved) + '”');
        }
        if (panelIsCurrent(body, gen)) closePanel();
      }).catch(function (err) {
        if (!panelIsCurrent(body, gen)) return;
        $$('.p-permission-option', body).forEach(function (item) { item.disabled = false; });
        trigger.disabled = false;
        /* 恢复按钮原貌：名字去掉“保存失败”前缀，恢复对应模式的描述。 */
        if (name) name.textContent = mode === 'manual' ? '手动许可' : mode === 'auto' ? '自动许可' : '全部允许';
        if (note) note.textContent = '保存失败：' + err.message;
        else body.insertAdjacentHTML('beforeend', '<div class="p-error">' + esc(err.message) + '</div>');
      });
    }

    function confirmYolo() {
      body.innerHTML = '<div class="p-empty">“全部允许”会跳过当前会话中每一次工具操作的逐次确认。仅在完全信任当前任务时使用。</div>' +
        '<div class="p-actions"><button class="ap-btn" id="yoloBack" type="button">返回</button>' +
        '<button class="ap-btn no" id="yoloConfirm" type="button">确认全部允许</button></div>';
      body.querySelector('#yoloBack').addEventListener('click', showPermissionModes);
      body.querySelector('#yoloConfirm').addEventListener('click', function () { saveMode('yolo', this); });
    }

    $$('.p-permission-option', body).forEach(function (button) {
      button.addEventListener('click', function () {
        var mode = button.getAttribute('data-mode');
        if (!mode) return;
        /* 同模式只关闭面板；不同模式（含再次点击当前项）都走切换流程，
           保证按钮文字一定会更新到所选模式。 */
        if (mode === 'yolo') return confirmYolo();
        saveMode(mode, button);
      });
    });
  }

  /* ---------------- 模型与工具：以服务端状态为准，不再伪装成插件面板 ---------------- */
  function showPlugins() {
    var body = openPanel('🧩 模型与工具');
    var gen = panelGen;
    function observe(promise) {
      return promise.then(function (data) { return { data: data, error: null }; })
        .catch(function (error) { return { data: null, error: error }; });
    }
    Promise.all([
      observe(api('/providers')),
      observe(loadModels(true)),
      observe(api('/mcp/servers')),
      observe(api('/tools')),
    ]).then(function (rs) {
      if (!panelIsCurrent(body, gen)) return;
      var providers = rs[0].data && rs[0].data.items || [];
      var models = Array.isArray(rs[1].data) ? rs[1].data : state.models;
      var mcpServers = rs[2].data && rs[2].data.servers || [];
      var tools = rs[3].data && rs[3].data.tools || [];
      var current = sessionModel(state.sid);
      var sourceCount = { builtin: 0, skill: 0, mcp: 0 };
      tools.forEach(function (tool) {
        var source = tool.source || 'builtin';
        sourceCount[source] = (sourceCount[source] || 0) + 1;
      });

      function badge(status) {
        status = String(status || '未知');
        var cls = /^(connected|ready|available|ok|healthy)$/i.test(status) ? 'ok' :
          /^(error|failed|unavailable)$/i.test(status) ? 'error' : 'muted';
        return '<span class="p-badge ' + cls + '">' + esc(status) + '</span>';
      }

      function unavailable(error) {
        return '<div class="p-note p-health-error">无法读取：' + esc(error && error.message || '服务不可用') + '</div>';
      }

      var html = '<div class="p-note">模型请在输入区切换；这里只展示服务商、MCP 和工具的真实健康状态。</div>';
      html += '<div class="p-group">当前会话模型</div>';
      html += '<div class="p-row"><span>' + esc(modelLabel(current)) + '</span><span class="p-dim">' + esc(current) + '</span></div>';

      html += '<div class="p-group">可用模型</div>';
      if (rs[1].error) html += unavailable(rs[1].error);
      models.forEach(function (model) {
        var alias = modelAlias(model);
        if (!alias) return;
        var label = model.display_name || model.model || alias;
        html += '<div class="p-row' + (alias === current ? ' p-selected' : '') + '"><span>' + esc(label) +
          '</span><span class="p-dim">' + (model.max_context_size ? fmtTok(model.max_context_size) : '') + '</span></div>';
      });
      if (!models.length && !rs[1].error) html += '<div class="p-dim">未返回可用模型</div>';

      html += '<div class="p-group">服务商状态</div>';
      if (rs[0].error) html += unavailable(rs[0].error);
      providers.forEach(function (provider) {
        var providerStatus = provider.status || (provider.has_api_key ? '已配置' : '未配置');
        html += '<div class="p-row"><span>' + esc(provider.name || provider.id || provider.type) +
          '</span>' + badge(providerStatus) + '</div>';
      });
      if (!providers.length && !rs[0].error) html += '<div class="p-dim">未返回服务商信息</div>';

      html += '<div class="p-group">MCP 连接</div>';
      if (rs[2].error) html += unavailable(rs[2].error);
      mcpServers.forEach(function (server) {
        html += '<div class="p-row"><span>' + esc(server.name || server.id) +
          '</span>' + badge(server.status) + '</div>';
        if (server.last_error) html += '<div class="p-note">' + esc(server.last_error) + '</div>';
      });
      if (!mcpServers.length && !rs[2].error) html += '<div class="p-dim">没有配置 MCP 服务</div>';

      html += '<div class="p-group">工具</div>';
      if (rs[3].error) html += unavailable(rs[3].error);
      else html += '<div class="p-row"><span>内置 ' + sourceCount.builtin + ' · 技能 ' + sourceCount.skill +
        ' · MCP ' + sourceCount.mcp + '</span><span class="p-dim">共 ' + tools.length + ' 个</span></div>';
      body.innerHTML = html;
    });
  }

  /* ---------------- 工作区切换 ---------------- */
  function activateWorkspace(root, options) {
    options = options || {};
    var gen = ++state.workspaceUpdateGen;
    saveComposer(state.sid);
    state.cwdFilter = root || null;
    if (root) ENV.cwd = root;
    return loadSessions().then(function (loaded) {
      if (gen !== state.workspaceUpdateGen) return null;
      if (loaded.length) return loaded;
      if (options.noCreate) return loaded;
      return createSession(root || ENV.cwd).then(loadSessions);
    }).then(function (loaded) {
      if (gen !== state.workspaceUpdateGen || !loaded) return null;
      var active = loaded.some(function (s) { return s.id === state.sid; });
      if (!active && loaded[0]) return switchSession(loaded[0].id);
      syncModelButton();
      return null;
    }).then(function () {
      if (gen === state.workspaceUpdateGen && !options.silent) {
        notifyUi(root ? '已切换到工作区 ' + root.split('/').pop() : '正在显示全部工作区的会话');
      }
    });
  }

  function showSites() {
    var body = openPanel('🌐 工作区');
    var gen = panelGen;
    api('/workspaces').then(function (data) {
      if (!panelIsCurrent(body, gen)) return;
      var items = data.items || [];
      var selectedRoot = state.cwdFilter === undefined ? ENV.cwd : state.cwdFilter;
      var html = '';
      if (desktopApi && desktopApi.chooseWorkspace) {
        html += '<div class="p-native-workspace"><div><strong>客户端工作区</strong>' +
          '<div class="p-path">' + esc(selectedRoot || ENV.cwd) + '</div></div>' +
          '<button class="ap-btn yes" id="nativeWorkspacePick" type="button">选择目录…</button></div>';
      }
      html += '<button class="p-row p-ws' + (selectedRoot === null ? ' p-selected' : '') +
        '" type="button" data-root="" aria-pressed="' + (selectedRoot === null ? 'true' : 'false') +
        '"><span>全部工作区</span><span class="p-dim">不过滤</span></button>';
      /* 新窗口打开：原生走 openWorkspaceWindow 桥，浏览器模式用 ?cwd= 新标签页。 */
      var canOpenWindow = (desktopApi && typeof desktopApi.openWorkspaceWindow === 'function') || !desktopApi;
      items.forEach(function (w) {
        var root = w.root || w.cwd || w.path || '';
        var name = w.name || root.split('/').pop() || root;
        html += '<div class="p-ws-row"><button class="p-row p-ws' + (selectedRoot === root ? ' p-selected' : '') +
          '" type="button" data-root="' + esc(root) + '" aria-pressed="' + (selectedRoot === root ? 'true' : 'false') + '">' +
          '<span>' + esc(name) + '</span><span class="p-dim">' + esc(root) + '</span></button>' +
          (canOpenWindow ? '<button class="p-ws-open" type="button" data-root="' + esc(root) +
            '" title="在新窗口打开" aria-label="在新窗口打开工作区 ' + esc(name) + '">↗</button>' : '') +
          '</div>';
      });
      body.innerHTML = html;
      Array.prototype.forEach.call(body.querySelectorAll('.p-ws-open'), function (openBtn) {
        openBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var root = openBtn.getAttribute('data-root');
          var name = root.split('/').pop() || root;
          if (desktopApi && typeof desktopApi.openWorkspaceWindow === 'function') {
            desktopApi.openWorkspaceWindow(root).then(function () {
              notifyUi('已在新窗口打开工作区 ' + name);
            }).catch(function (e) {
              notifyUi('打开新窗口失败：' + e.message, 'error');
            });
          } else {
            window.open(location.pathname + '?cwd=' + encodeURIComponent(root), '_blank', 'noopener');
          }
        });
      });
      var nativePicker = body.querySelector('#nativeWorkspacePick');
      if (nativePicker) nativePicker.addEventListener('click', function () {
        nativePicker.disabled = true;
        nativePicker.textContent = '选择中…';
        desktopApi.chooseWorkspace().then(function (result) {
          if (!result || result.canceled) {
            nativePicker.disabled = false;
            nativePicker.textContent = '选择目录…';
            return null;
          }
          return activateWorkspace(result.cwd).then(closePanel);
        }).catch(function (e) {
          if (panelIsCurrent(body, gen)) {
            nativePicker.disabled = false;
            nativePicker.textContent = '选择目录…';
          }
          notifyUi('选择工作区失败：' + e.message, 'error');
        });
      });
      Array.prototype.forEach.call(body.querySelectorAll('.p-ws'), function (row) {
        row.addEventListener('click', function () {
          Array.prototype.forEach.call(body.querySelectorAll('.p-ws, #nativeWorkspacePick'), function (button) {
            button.disabled = true;
          });
          var root = row.getAttribute('data-root');
          activateWorkspace(root).then(closePanel).catch(function (e) {
            if (panelIsCurrent(body, gen)) {
              Array.prototype.forEach.call(body.querySelectorAll('.p-ws, #nativeWorkspacePick'), function (button) {
                button.disabled = false;
              });
            }
            notifyUi('切换工作区失败: ' + e.message, 'error');
          });
        });
      });
    }).catch(function (e) {
      if (!panelIsCurrent(body, gen)) return;
      body.innerHTML = '<div class="p-dim">获取失败: ' + esc(e.message) + '</div>';
    });
  }

  /* ---------------- Git 工作区检查 ---------------- */
  function showGit() {
    var body = openPanel('🔀 Git 检查');
    var gen = panelGen;
    var cwd = currentCwd();
    api('/workspaces')
      .then(function (d) {
        if (!panelIsCurrent(body, gen)) return;
        var workspace = (d.items || []).filter(function (w) { return w.root === cwd; })[0];
        var isGit = !!(workspace && workspace.is_git_repo);
        var html = '<div class="p-group">当前工作区</div>' +
          '<div class="p-row"><span>' + esc((workspace && workspace.name) || cwd.split('/').pop() || cwd) +
          '</span><span class="p-badge ' + (isGit ? 'ok' : 'muted') + '">' +
          (isGit ? 'Git 仓库' : '非 Git 仓库') + '</span></div>' +
          '<div class="p-path">' + esc(cwd) + '</div>';
        if (isGit) {
          html += '<div class="p-row"><span>当前分支</span><span class="p-dim">' +
            esc(workspace.branch || '未知') + '</span></div>' +
            '<div class="p-note">本地服务暂未提供远程拉取请求列表；可以让 Kimi 在当前工作区检查分支、改动和 PR 准备情况。</div>' +
            '<div class="p-actions"><button class="ap-btn yes" id="gitAsk" type="button">在聊天中检查</button></div>';
        } else {
          html += '<div class="p-empty">当前目录不是 Git 仓库，暂无可检查的拉取请求。</div>';
        }
        body.innerHTML = html;
        var ask = body.querySelector('#gitAsk');
        if (ask) ask.addEventListener('click', function () {
          input.value = '请检查当前工作区的 Git 状态、分支差异和创建拉取请求前还需要处理的事项。';
          input.dispatchEvent(new Event('input'));
          closePanel();
          focusChat();
        });
      })
      .catch(function (e) {
        if (!panelIsCurrent(body, gen)) return;
        body.innerHTML = '<div class="p-empty">获取工作区信息失败: ' + esc(e.message) + '</div>';
      });
  }

  /* ---------------- 本地提醒 ---------------- */
  var REMINDER_KEY = 'kimi2007.reminders';

  function saveReminders() {
    var plain = state.reminders.map(function (r) { return { id: r.id, text: r.text, at: r.at }; });
    localStorage.setItem(REMINDER_KEY, JSON.stringify(plain));
  }

  function fireReminder(r) {
    state.reminders = state.reminders.filter(function (x) { return x !== r; });
    saveReminders();
    notifyUi('⏰ 提醒：' + r.text);
    playDiDi();
    flashTitle();
  }

  function armReminder(r) {
    var delay = r.at - Date.now();
    if (delay <= 0) {
      fireReminder(r);
      return;
    }
    r.timer = setTimeout(function () { armReminder(r); }, Math.min(delay, 2147483647));
  }

  function restoreReminders() {
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem(REMINDER_KEY) || '[]'); } catch (e) { saved = []; }
    state.reminders = saved.filter(function (r) {
      return r && r.text && Number.isFinite(r.at) && r.at > Date.now();
    }).map(function (r) {
      return { id: r.id || ('rm_' + r.at), text: String(r.text), at: r.at, timer: null };
    });
    state.reminders.forEach(armReminder);
    saveReminders();
  }

  restoreReminders();

  function showSchedule() {
    var body = openPanel('🗓️ 临时提醒');
    renderReminders(body);
  }
  function renderReminders(body) {
    var html =
      '<div class="p-note">仅在 Kimi 2007 打开期间提醒；关闭客户端后不会作为后台计划任务投递。</div>' +
      '<div class="p-form">' +
      '<input id="rmMin" type="number" min="1" max="43200" step="1" value="5" title="分钟"> 分钟后提醒我 ' +
      '<input id="rmText" type="text" maxlength="100" placeholder="要做的事..." value="起来活动一下">' +
      '<button class="ap-btn yes" id="rmAdd" type="button">设定</button></div>' +
      '<div class="p-error" id="rmError" aria-live="polite"></div>' +
      '<div class="p-group">进行中的提醒</div><div id="rmList"></div>';
    body.innerHTML = html;
    function renderList() {
      var list = body.querySelector('#rmList');
      list.innerHTML = state.reminders.length ? '' : '<div class="p-dim">暂无</div>';
      state.reminders.forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'p-row';
        row.innerHTML = '<span>⏰ ' + esc(r.text) + '</span><span class="p-dim">' +
          Math.max(1, Math.ceil((r.at - Date.now()) / 60000)) + ' 分钟后</span>' +
          '<button class="p-delete" type="button" title="取消提醒" aria-label="取消提醒">✕</button>';
        row.querySelector('.p-delete').addEventListener('click', function () {
          clearTimeout(r.timer);
          state.reminders = state.reminders.filter(function (x) { return x !== r; });
          saveReminders();
          renderList();
        });
        list.appendChild(row);
      });
    }
    renderList();
    function addReminder() {
      var min = parseFloat(body.querySelector('#rmMin').value);
      var text = body.querySelector('#rmText').value.trim() || '提醒';
      if (!Number.isFinite(min) || min < 1 || min > 43200) {
        body.querySelector('#rmError').textContent = '请输入 1 到 43200 之间的分钟数';
        return;
      }
      body.querySelector('#rmError').textContent = '';
      var r = { id: 'rm_' + Date.now(), text: text, at: Date.now() + min * 60000, timer: null };
      state.reminders.push(r);
      armReminder(r);
      saveReminders();
      renderList();
      notifyUi('已设定 ' + min + ' 分钟后的提醒：' + text);
    }
    body.querySelector('#rmAdd').addEventListener('click', addReminder);
    body.querySelector('#rmText').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addReminder();
    });
  }
