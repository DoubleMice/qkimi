  /* ================= 会话管理 ================= */

  function currentCwd() {
    var s = findSession(state.sid);
    return (s && s.metadata && s.metadata.cwd) || state.cwdFilter || ENV.cwd;
  }

  function resizeComposer() {
    input.style.height = 'auto';
    input.style.height = Math.max(56, Math.min(input.scrollHeight, 130)) + 'px';
  }

  function persistDraft(sid, value) {
    if (!sid) return;
    value = String(value || '');
    if (value) state.drafts[sid] = value;
    else delete state.drafts[sid];
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(state.drafts)); } catch (e) { /* 本轮仍保留内存草稿 */ }
  }

  /* ================= 会话标签 ================= */

  var PRESET_TAGS = ['工作', '学习', '个人', '临时'];

  function persistTags() {
    try { localStorage.setItem(TAGS_KEY, JSON.stringify(state.sessionTags)); } catch (e) { /* 本轮仍保留内存标签 */ }
  }

  function sessionTagsOf(sid) {
    return state.sessionTags[sid] || [];
  }

  /* 规范化后写入；空数组则移除该会话的标签记录。 */
  function setSessionTags(sid, tags) {
    if (!sid) return;
    var clean = [];
    (tags || []).forEach(function (t) {
      t = String(t || '').trim();
      if (t && clean.indexOf(t) === -1) clean.push(t);
    });
    if (clean.length) state.sessionTags[sid] = clean;
    else delete state.sessionTags[sid];
    persistTags();
    renderSessionList();
  }

  function setSessGroup(mode) {
    if (SESS_GROUPS.indexOf(mode) === -1) mode = 'time';
    state.sessGroup = mode;
    try { localStorage.setItem('kimi2007.sessgroup', mode); } catch (e) { /* 分组偏好仅保存在内存 */ }
    var sel = $('#sessGroupSel');
    if (sel) sel.value = mode;
    renderSessionList();
  }

  function setTagFilter(tag) {
    state.tagFilter = tag || null;
    renderSessionList();
  }

  /* 归档前的标题关键词 → 建议标签小词典。 */
  var TAG_HINTS = [
    { tag: '工作', words: ['代码', 'bug', 'pr', 'review', '部署', '接口', 'api', '报错', '修复', '重构', '测试', '上线', '需求'] },
    { tag: '学习', words: ['学习', '教程', '论文', '原理', '入门', '笔记', '课程', '读书'] },
    { tag: '个人', words: ['旅行', '购物', '菜谱', '健身', '电影', '音乐', '日记'] }
  ];

  function suggestTagFor(title) {
    var text = String(title || '').toLowerCase();
    for (var i = 0; i < TAG_HINTS.length; i++) {
      var words = TAG_HINTS[i].words;
      for (var j = 0; j < words.length; j++) {
        if (text.indexOf(words[j]) !== -1) return TAG_HINTS[i].tag;
      }
    }
    return null;
  }

  /* 通用标签编辑面板：预置标签 checkbox + 自定义输入，onSave 收到去重后的数组。 */
  function showTagEditor(title, currentTags, onSave) {
    var body = openPanel(title);
    var known = PRESET_TAGS.slice();
    (currentTags || []).forEach(function (t) { if (known.indexOf(t) === -1) known.push(t); });
    var html = '<div class="tag-editor">';
    known.forEach(function (t) {
      var checked = (currentTags || []).indexOf(t) !== -1;
      html += '<label class="tag-opt"><input type="checkbox" value="' + esc(t) + '"' +
        (checked ? ' checked' : '') + '> ' + esc(t) + '</label>';
    });
    html += '</div>' +
      '<input type="text" class="fav-search tag-custom" placeholder="自定义标签，逗号分隔" aria-label="自定义标签">' +
      '<div class="p-actions">' +
      '<button class="ap-btn" id="tagCancel" type="button">取消</button>' +
      '<button class="ap-btn yes" id="tagSave" type="button">保存</button></div>';
    body.innerHTML = html;
    body.querySelector('#tagCancel').addEventListener('click', closePanel);
    body.querySelector('#tagSave').addEventListener('click', function () {
      var tags = [];
      $$('input[type="checkbox"]', body.querySelector('.tag-editor')).forEach(function (box) {
        if (box.checked) tags.push(box.value);
      });
      var custom = body.querySelector('.tag-custom').value;
      custom.split(/[,，]/).forEach(function (t) {
        t = t.trim();
        if (t && tags.indexOf(t) === -1) tags.push(t);
      });
      closePanel();
      onSave(tags);
    });
  }

  function showSessionTags(sid) {
    if (!sid) {
      notifyUi('请先打开一个会话', 'error');
      return;
    }
    showTagEditor('🏷 会话标签', sessionTagsOf(sid), function (tags) {
      setSessionTags(sid, tags);
      notifyUi(tags.length ? '会话标签已保存' : '已清除会话标签', 'ok');
    });
  }

  function setDraft(sid, value) {
    var ui = uiFor(sid);
    if (!ui) return;
    ui.draft = String(value || '');
    persistDraft(sid, ui.draft);
  }

  function saveComposer(sid) {
    var ui = uiFor(sid);
    if (ui) setDraft(sid, input.value);
  }

  function restoreComposer(sid) {
    var ui = uiFor(sid);
    input.value = ui ? ui.draft : '';
    compClose();
    resizeComposer();
    renderAttachRow();
    updateComposerState();
  }

  function queueSessionNotice(sid, text) {
    var ui = uiFor(sid);
    if (!ui) return;
    if (sid === state.sid) notifyUi(text, /失败|错误|⚠|无法/.test(text) ? 'error' : '');
    else ui.notices.push(text);
  }

  function flushSessionNotices(sid) {
    var ui = uiFor(sid);
    if (!ui || sid !== state.sid || !ui.notices.length) return;
    ui.notices.splice(0).forEach(function (text) {
      notifyUi(text, /失败|错误|⚠|无法/.test(text) ? 'error' : '');
    });
  }

  function mergeSessionSnapshot(snapSession) {
    if (!snapSession || !snapSession.id) return;
    var local = findSession(snapSession.id);
    if (!local) return;
    var prevConfig = local.agent_config;
    Object.assign(local, snapSession);
    if (snapSession.agent_config && prevConfig) {
      local.agent_config = Object.assign({}, prevConfig, snapSession.agent_config);
    }
  }

  function normalizeModelAlias(model) {
    return String(model || '').replace(/^managed:/, '');
  }

  function modelAlias(model) {
    if (!model) return '';
    return normalizeModelAlias(model.alias || model.id || model.model ||
      (model.provider && model.model ? model.provider + '/' + model.model : ''));
  }

  function sessionModel(sid) {
    var status = state.sessionStatus[sid] || {};
    var session = findSession(sid) || {};
    return normalizeModelAlias(status.model || (session.agent_config && session.agent_config.model) || state.model || ENV.model);
  }

  function modelLabel(alias) {
    alias = normalizeModelAlias(alias);
    for (var i = 0; i < state.models.length; i++) {
      if (modelAlias(state.models[i]) === alias) return state.models[i].display_name || state.models[i].model || alias;
    }
    return alias || '默认模型';
  }

  function syncModelButton() {
    var name = $('#modelName');
    var button = $('#modelBtn');
    if (!name || !button) return;
    var alias = sessionModel(state.sid);
    name.textContent = modelLabel(alias);
    button.title = '当前会话模型：' + modelLabel(alias);
    button.setAttribute('aria-label', button.title);
    renderModelMenu();
  }

  function renderModelMenu() {
    var menu = $('#modelMenu');
    if (!menu) return;
    var selected = sessionModel(state.sid);
    menu.innerHTML = '';
    if (!state.models.length) {
      var loading = document.createElement('div');
      loading.className = 'model-opt p-dim';
      loading.textContent = '正在读取可用模型…';
      menu.appendChild(loading);
      return;
    }
    state.models.forEach(function (model) {
      var alias = modelAlias(model);
      if (!alias) return;
      var opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'model-opt' + (alias === selected ? ' active-mode' : '');
      opt.setAttribute('role', 'menuitemradio');
      opt.setAttribute('aria-checked', alias === selected ? 'true' : 'false');
      opt.dataset.model = alias;
      opt.textContent = (model.display_name || model.model || alias) +
        (model.max_context_size ? ' · ' + fmtTok(model.max_context_size) : '');
      opt.addEventListener('click', function () {
        setSessionModel(alias, model.display_name || model.model || alias).catch(function () { /* 已在界面反馈 */ });
      });
      menu.appendChild(opt);
    });
  }

  function loadModels(force) {
    if (!force && state.models.length) return Promise.resolve(state.models);
    if (state.modelsPromise) return state.modelsPromise;
    state.modelsPromise = api('/models').then(function (data) {
      state.models = (data.items || []).filter(function (model) { return !!modelAlias(model); });
      syncModelButton();
      return state.models;
    }).catch(function (err) {
      if (!state.models.length) renderModelMenu();
      throw err;
    }).finally(function () {
      state.modelsPromise = null;
    });
    return state.modelsPromise;
  }

  function setSessionModel(alias, label) {
    var sid = state.sid;
    alias = normalizeModelAlias(alias);
    if (!sid || !alias || alias === sessionModel(sid)) {
      closePopup(modelMenu);
      if (sid && document.activeElement && document.activeElement.closest('#modelMenu')) $('#modelBtn').focus();
      return Promise.resolve();
    }
    var menu = $('#modelMenu');
    Array.prototype.forEach.call(menu.querySelectorAll('button'), function (button) { button.disabled = true; });
    return api('/sessions/' + encodeURIComponent(sid) + '/profile', {
      method: 'POST',
      body: JSON.stringify({ agent_config: { model: alias } }),
    }).then(function (profile) {
      mergeSessionSnapshot(profile);
      var returned = normalizeModelAlias(profile && profile.agent_config && profile.agent_config.model) || alias;
      applySessionStatus(sid, { model: returned });
      return api('/sessions/' + encodeURIComponent(sid) + '/status').catch(function () { return { model: returned }; });
    }).then(function (status) {
      applySessionStatus(sid, status);
      if (sid === state.sid) {
        syncModelButton();
        var returnFocus = $('#modelMenu').classList.contains('show');
        closePopup(modelMenu);
        if (returnFocus) $('#modelBtn').focus();
        notifyUi('当前会话已切换到模型 ' + (label || modelLabel(sessionModel(sid))));
      }
    }).catch(function (err) {
      if (sid === state.sid) {
        renderModelMenu();
        queueSessionNotice(sid, '切换模型失败: ' + err.message);
      }
      throw err;
    });
  }

  function applySessionStatus(sid, status) {
    if (!status) return;
    Object.keys(status).forEach(function (key) {
      if (status[key] === undefined) delete status[key];
    });
    status = Object.assign({}, state.sessionStatus[sid] || {}, status);
    state.sessionStatus[sid] = status;
    /* permission 是“下一轮”生效的会话设置：仅当会话空闲时 /status.permission 才等于持久化值，
       忙碌时它反映进行中回合的旧值，不能用来回退用户刚写入的权限。只在空闲状态回读同步。 */
    if (status.permission && status.busy !== true) {
      state.sessionPermission[sid] = status.permission;
    }
    if (sid !== state.sid) return;
    var context = status.context_tokens == null ? '-' : fmtTok(status.context_tokens) +
      (status.max_context_tokens ? '/' + fmtTok(status.max_context_tokens) : '');
    var ctxBtn = $('#ctxInfo');
    var ctxBarEl = $('#ctxBar');
    var ctxTextEl = $('#ctxBarText');
    if (ctxTextEl) ctxTextEl.textContent = '📊 ' + context;
    if (ctxBtn && ctxBarEl && status.context_tokens != null && status.max_context_tokens) {
      var usedPct = Math.min(100, Math.round(status.context_tokens / status.max_context_tokens * 100));
      /* 色条=已用量：用得越多条越长，颜色从绿到黄到红 */
      ctxBarEl.style.width = usedPct + '%';
      var prevClass = ctxBtn.dataset.ctxClass || '';
      /* context_tokens = 0 是新会话初始状态，不触发告警 */
      var nextClass = (status.context_tokens === 0) ? '' : usedPct >= 80 ? 'ctx-danger' : usedPct >= 50 ? 'ctx-warn' : '';
      if (prevClass !== nextClass) {
        if (prevClass) ctxBtn.classList.remove(prevClass);
        if (nextClass) ctxBtn.classList.add(nextClass);
        ctxBtn.dataset.ctxClass = nextClass;
        if (nextClass === 'ctx-danger') {
          playLowCtxAlert();
          setPetMode('alert');
        }
      }
      ctxBtn.title = status.context_tokens === 0
        ? '上下文用量：新会话（' + fmtTok(status.max_context_tokens) + ' 可用）'
        : '上下文用量：' + usedPct + '%（' + fmtTok(status.context_tokens) + ' / ' + fmtTok(status.max_context_tokens) + '）';
    }
    syncPermissionControl(sid);
    syncModelButton();
  }

  function hasUnsettledPrompt(ui) {
    return !!(ui && (ui.submitting || ui.submittedPrompts.some(function (record) { return !record.settled; })));
  }

  function settleIdleSession(sid, restoreCancelled) {
    var ui = uiFor(sid);
    if (!ui) return;
    var records = ui.submittedPrompts.filter(function (record) { return !record.settled; });
    if (ui.abortTarget && records.indexOf(ui.abortTarget) < 0 && !ui.abortTarget.settled) records.unshift(ui.abortTarget);
    records.forEach(function (record) { record.settled = true; });
    if (restoreCancelled) {
      /* 逆序回填，保持 A、B、原草稿的发送顺序。 */
      records.slice().reverse().forEach(function (record) {
        restoreAbortedPrompt(sid, record);
        if (record.outgoing) discardPendingOutgoing(sid, record.outgoing);
      });
    }
    ui.abortTarget = null;
    ui.abortAccepted = false;
    ui.restoreQueueOnIdle = false;
    ui.aborting = false;
    ui.submittedPrompts = [];
  }

  function hydrateSession(sid, opts) {
    if (!sid) return Promise.resolve(null);
    opts = opts || {};
    var gen = (state.hydrateGen[sid] || 0) + 1;
    state.hydrateGen[sid] = gen;
    return Promise.all([
      api('/sessions/' + encodeURIComponent(sid) + '/snapshot'),
      api('/sessions/' + encodeURIComponent(sid) + '/status').catch(function () { return null; }),
    ]).then(function (rs) {
      if (state.hydrateGen[sid] !== gen) return null;
      var snap = rs[0];
      var status = rs[1];
      if (!snap) return null;
      /* snapshot 生成后如果已收到更新 WS 序号，它不得再覆盖新状态；短暂等待服务端追平。 */
      if (typeof snap.as_of_seq === 'number' && snap.as_of_seq < (state.lastSeq[sid] || 0)) {
        var staleAttempts = opts.staleAttempts || 0;
        if (staleAttempts < 2) {
          return new Promise(function (resolve) { setTimeout(resolve, 160 * (staleAttempts + 1)); })
            .then(function () {
              if (state.hydrateGen[sid] !== gen) return null;
              return hydrateSession(sid, Object.assign({}, opts, { staleAttempts: staleAttempts + 1 }));
            });
        }
        if (sid === state.sid) return refreshMessages().then(function () { return null; });
        return null;
      }

      if (typeof snap.as_of_seq === 'number') {
        state.lastSeq[sid] = Math.max(state.lastSeq[sid] || 0, snap.as_of_seq);
      }
      if (snap.epoch) state.epochs[sid] = snap.epoch;
      mergeSessionSnapshot(snap.session);
      applySessionStatus(sid, status);
      syncInteractionState(sid, snap.pending_approvals || [], snap.pending_questions || []);
      var session = snap.session || findSession(sid);
      var sessionUi = uiFor(sid);
      var authoritativeBusy = !!(session && session.busy);
      if (authoritativeBusy && sessionUi.restoreQueueOnIdle && !sessionUi.aborting) {
        sessionUi.restoreQueueOnIdle = false;
      }
      if (!authoritativeBusy && (sessionUi.abortAccepted || sessionUi.restoreQueueOnIdle) && !sessionUi.submitting) {
        settleIdleSession(sid, true);
      } else if (!authoritativeBusy && !hasUnsettledPrompt(sessionUi)) {
        settleIdleSession(sid, false);
      }
      var effectiveBusy = authoritativeBusy || hasUnsettledPrompt(sessionUi);
      var localSession = findSession(sid);
      if (localSession) localSession.busy = effectiveBusy;

      if (sid !== state.sid) {
        renderSessionList();
        return snap;
      }

      /* 本地发送尚未被服务端接收时，旧 snapshot 只能增量合并，不能清空乐观消息。 */
      var replaceMessages = !!opts.replaceMessages && !hasUnsettledPrompt(sessionUi);
      var followAfterReplace = replaceMessages && nearBottom();
      var preservedScrollTop = chatBody.scrollTop;
      if (replaceMessages) {
        clearLivePresentation();
        state.rendered = {};
        chatBody.innerHTML = '';
      }
      applyMessageItems(snap.messages && snap.messages.items, false); /* snapshot 是时间正序 */
      renderInteractionCards(sid);

      if (session) {
        setBusy(effectiveBusy);
        applyTitle(session.title);
      }
      if (replaceMessages && snap.in_flight_turn) {
        if (snap.in_flight_turn.thinking_text) appendThink(snap.in_flight_turn.thinking_text);
        if (snap.in_flight_turn.assistant_text) appendDelta(snap.in_flight_turn.assistant_text);
        (snap.in_flight_turn.running_tools || []).forEach(function (tool) { showActivity(tool, sid); });
      } else if (session && effectiveBusy && session.pending_interaction === 'none' &&
                 !Object.keys(uiFor(sid).approvals).length && !Object.keys(uiFor(sid).questions).length) {
        showTyping();
      }
      if (session && effectiveBusy && !opts.skipWaitStart) startWaitLoop(sid);
      else stopWaitLoop(sid);
      scheduleActivityRefresh(sid, 0);
      renderSessionList();
      syncModelButton();
      flushSessionNotices(sid);
      if (replaceMessages && followAfterReplace) scrollBottom();
      else if (replaceMessages) {
        chatBody.scrollTop = preservedScrollTop;
        requestAnimationFrame(function () { chatBody.scrollTop = preservedScrollTop; });
        showJumpLatest();
      }
      return snap;
    });
  }

  function createSession(cwd) {
    return api('/sessions', {
      method: 'POST',
      body: JSON.stringify({ metadata: { cwd: cwd || state.cwdFilter || ENV.cwd } }),
    }).then(function (s) {
      return s;
    });
  }

  function loadSessions() {
    var gen = ++state.sessionLoadGen;
    return api('/sessions').then(function (data) {
      var items = (data.items || []).filter(function (s) { return !s.archived; });
      /* 工作区过滤:默认当前目录,"站点"面板可切换 */
      var filter = state.cwdFilter === undefined ? ENV.cwd : state.cwdFilter;
      if (filter) {
        items = items.filter(function (s) {
          return s.metadata && s.metadata.cwd === filter;
        });
      }
      items.sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
      if (gen !== state.sessionLoadGen) return state.sessions;
      state.sessions = items;
      refreshFavoriteContext();
      renderSessionList();
      return items;
    });
  }

  /* 日期分组标签：今天/昨天/最近 7 天/更早（按 updated_at）。 */
  function sessDateGroup(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '更早';
    var dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    var days = Math.floor((dayStart.getTime() - d.getTime()) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return '最近 7 天';
    return '更早';
  }

  function renderSessionList() {
    if (!sessList) return;
    var q = ($('#sessSearch') && $('#sessSearch').value || '').trim().toLowerCase();
    sessList.innerHTML = '';
    /* 标签筛选态：列表顶部给出当前筛选 chip，点 ✕ 清除。 */
    if (state.tagFilter) {
      var filterBar = document.createElement('div');
      filterBar.className = 'sess-filter';
      var filterChip = document.createElement('span');
      filterChip.className = 'tag-chip on';
      filterChip.textContent = '🏷 ' + state.tagFilter;
      var filterClear = document.createElement('button');
      filterClear.type = 'button';
      filterClear.className = 'sess-filter-clear';
      filterClear.title = '清除标签筛选';
      filterClear.setAttribute('aria-label', '清除标签筛选：' + state.tagFilter);
      filterClear.textContent = '✕';
      filterClear.addEventListener('click', function () { setTagFilter(null); });
      filterBar.appendChild(filterChip);
      filterBar.appendChild(filterClear);
      sessList.appendChild(filterBar);
    }
    var visible = state.sessions.filter(function (s) {
      var title = s.title || '新会话';
      if (q && title.toLowerCase().indexOf(q) === -1) return false;
      if (state.tagFilter && sessionTagsOf(s.id).indexOf(state.tagFilter) === -1) return false;
      return true;
    });
    /* 分组：time 保持扁平；tag 按第一个标签归类（无标签归「未标记」并排在最后）；date 按 updated_at 分桶；workspace 按会话 cwd 分桶。 */
    var groups = [];
    if (state.sessGroup === 'time') {
      groups.push({ label: null, items: visible });
    } else if (state.sessGroup === 'workspace') {
      var wsBuckets = {};
      visible.forEach(function (s) {
        var root = (s.metadata && s.metadata.cwd) || '';
        if (!wsBuckets[root]) {
          wsBuckets[root] = { label: root.split('/').pop() || root || '未知工作区', root: root, items: [], latest: '' };
          groups.push(wsBuckets[root]);
        }
        wsBuckets[root].items.push(s);
        if (String(s.updated_at) > String(wsBuckets[root].latest)) wsBuckets[root].latest = s.updated_at;
      });
      groups.sort(function (a, b) { return String(b.latest).localeCompare(String(a.latest)); });
    } else {
      var buckets = {};
      visible.forEach(function (s) {
        var label = state.sessGroup === 'tag' ? (sessionTagsOf(s.id)[0] || '未标记') : sessDateGroup(s.updated_at);
        if (!buckets[label]) {
          buckets[label] = { label: label, items: [] };
          groups.push(buckets[label]);
        }
        buckets[label].items.push(s);
      });
      if (state.sessGroup === 'tag') {
        groups.sort(function (a, b) {
          if (a.label === '未标记') return 1;
          if (b.label === '未标记') return -1;
          return a.label.localeCompare(b.label);
        });
      }
    }
    groups.forEach(function (group) {
      if (group.label != null) {
        var head = document.createElement('div');
        head.className = 'sess-group';
        if (state.sessGroup === 'tag') {
          /* 标签分组头可点：切换标签筛选态。 */
          var headChip = document.createElement('button');
          headChip.type = 'button';
          headChip.className = 'tag-chip' + (state.tagFilter === group.label ? ' on' : '');
          headChip.textContent = '🏷 ' + group.label;
          headChip.title = '只看「' + group.label + '」标签的会话';
          headChip.addEventListener('click', function () {
            setTagFilter(state.tagFilter === group.label ? null : group.label);
          });
          head.appendChild(headChip);
        } else if (state.sessGroup === 'workspace') {
          /* 工作区分组头可点：切换到该工作区过滤（同工作区面板）。 */
          var wsChip = document.createElement('button');
          wsChip.type = 'button';
          wsChip.className = 'tag-chip sess-ws-chip';
          wsChip.textContent = '📁 ' + group.label;
          wsChip.title = (group.root || '全部工作区') + '\n点击只看这个工作区的会话';
          wsChip.addEventListener('click', function () {
            activateWorkspace(group.root || null);
          });
          head.appendChild(wsChip);
        } else {
          head.textContent = group.label;
        }
        sessList.appendChild(head);
      }
      group.items.forEach(function (s) {
        var title = s.title || '新会话';
        var item = document.createElement('div');
        item.className = 'sess-item' + (s.id === state.sid ? ' active' : '');
        item.setAttribute('role', 'listitem');
        var ui = uiFor(s.id);
        var pendingCount = Object.keys(ui.approvals).length + Object.keys(ui.questions).length;
        if (!pendingCount && s.pending_interaction && s.pending_interaction !== 'none') pendingCount = 1;
        var open = document.createElement('button');
        open.type = 'button';
        open.className = 'sess-open';
        open.title = title;
        var accessibleState = [s.busy ? '进行中' : '', pendingCount ? '待处理 ' + pendingCount + ' 项' : ''].filter(Boolean).join('，');
        open.setAttribute('aria-label', (s.id === state.sid ? '当前会话：' : '打开会话：') + title +
          (accessibleState ? '，' + accessibleState : ''));
        if (s.id === state.sid) open.setAttribute('aria-current', 'page');
        var tagsHtml = sessionTagsOf(s.id).map(function (t) {
          return '<span class="tag-chip">' + esc(t) + '</span>';
        }).join('');
        /* 「全部工作区」视图（且未按工作区分组）下标注会话所属工作区。 */
        var wsName = (state.cwdFilter === null && state.sessGroup !== 'workspace' &&
          s.metadata && s.metadata.cwd) ? s.metadata.cwd.split('/').pop() : '';
        open.innerHTML =
          '<span class="sess-ico">💬</span>' +
          '<span class="sess-name">' + esc(title) + '</span>' +
          (tagsHtml ? '<span class="sess-tags">' + tagsHtml + '</span>' : '') +
          (wsName ? '<span class="sess-ws" title="' + esc(s.metadata.cwd) + '">' + esc(wsName) + '</span>' : '') +
          (s.busy ? '<span class="sess-busy" title="进行中">●</span>' : '') +
          (pendingCount ? '<span class="sess-pending" title="待处理 ' + pendingCount + ' 项">' + pendingCount + '</span>' : '') +
          '<span class="sess-time" title="最近活动：' + esc(fullLocalTime(s.updated_at)) +
          '">' + esc(sessTimeLabel(s.updated_at)) + '</span>';
        open.addEventListener('click', function () { switchSession(s.id); });
        var tagBtn = document.createElement('button');
        tagBtn.type = 'button';
        tagBtn.className = 'sess-tagbtn';
        tagBtn.title = '编辑会话标签';
        tagBtn.setAttribute('aria-label', '编辑会话标签：' + title);
        tagBtn.textContent = '🏷';
        tagBtn.addEventListener('click', function () {
          showSessionTags(s.id);
        });
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'sess-del';
        del.title = '归档会话';
        del.setAttribute('aria-label', '归档会话：' + title);
        del.textContent = '✕';
        del.addEventListener('click', function () {
          confirmArchiveSession(s.id);
        });
        item.appendChild(open);
        item.appendChild(tagBtn);
        item.appendChild(del);
        sessList.appendChild(item);
      });
    });
    if (!sessList.querySelector('.sess-item')) {
      var empty = document.createElement('div');
      empty.className = 'sess-empty';
      empty.textContent = q ? '没有匹配的会话' : (state.tagFilter ? '没有该标签的会话' : '暂无会话，点击「＋ 新建」开始');
      sessList.appendChild(empty);
    }
    /* 会话元数据(cwd)随列表刷新到位，标题栏的工作区小标跟着纠偏。 */
    syncChatWs();
  }
