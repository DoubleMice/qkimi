  /* ================= 真实活动中心 =================
   * 数据来自 Kimi server 的 tasks / children / terminals；实时工具事件作为补充，
   * 因而右栏不会把装饰性在线状态误当作工作状态。
   */

  function activityStatusText(status) {
    var labels = {
      running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消',
      connected: '已连接', connecting: '连接中', disconnected: '未连接', error: '异常', exited: '已退出',
    };
    return labels[status] || status || '未知';
  }

  function activityKindText(kind) {
    var labels = { subagent: '子代理', bash: '命令', tool: '工具' };
    return labels[kind] || kind || '活动';
  }

  function activityTime(value) {
    if (!value) return '';
    return hmOf(value).slice(0, 5);
  }

  function makeActivityItem(options) {
    var item = document.createElement('div');
    item.className = 'activity-item';
    var main = document.createElement('div');
    main.className = 'activity-item-main';
    var title;
    if (options.onOpen) {
      title = document.createElement('button');
      title.type = 'button';
      title.className = 'activity-item-title activity-jump';
      title.textContent = options.title;
      title.title = options.title;
      title.addEventListener('click', options.onOpen);
    } else {
      title = document.createElement('div');
      title.className = 'activity-item-title';
      title.textContent = options.title;
      title.title = options.title;
    }
    main.appendChild(title);
    if (options.detail) {
      var detail = document.createElement('div');
      detail.className = 'activity-item-detail';
      detail.textContent = options.detail;
      detail.title = options.detail;
      main.appendChild(detail);
    }
    item.appendChild(main);

    var controls = document.createElement('div');
    controls.className = 'activity-item-controls';
    if (options.status) {
      var status = document.createElement('span');
      status.className = 'activity-status ' + String(options.status).replace(/[^a-z0-9_-]/gi, '');
      status.textContent = activityStatusText(options.status);
      controls.appendChild(status);
    }
    if (options.action) {
      var action = document.createElement('button');
      action.type = 'button';
      action.className = 'activity-action';
      action.textContent = options.action.label;
      action.title = options.action.title || options.action.label;
      action.addEventListener('click', options.action.onClick);
      controls.appendChild(action);
    }
    if (controls.childNodes.length) item.appendChild(controls);
    if (options.meta) {
      var meta = document.createElement('div');
      meta.className = 'activity-item-meta';
      meta.textContent = options.meta;
      item.appendChild(meta);
    }
    return item;
  }

  function renderActivityRows(container, items, create) {
    if (!container) return false;
    container.innerHTML = '';
    items.forEach(function (item) { container.appendChild(create(item)); });
    var section = container.closest('.activity-section');
    if (section) section.hidden = !items.length;
    return !!items.length;
  }

  function focusInteraction(id) {
    var target = $$('.interaction-card').filter(function (card) {
      return card.getAttribute('data-interaction-id') === String(id);
    })[0];
    if (!target) {
      notifyUi('该交互已不在当前消息区，请重新同步会话。', 'error');
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var focus = target.querySelector('button, input, textarea');
    if (focus) focus.focus();
  }

  function cancelActivityTask(sid, taskId) {
    if (!sid || !taskId) return;
    api('/sessions/' + encodeURIComponent(sid) + '/tasks/' + encodeURIComponent(taskId) + ':cancel', {
      method: 'POST', body: '{}',
    }).then(function () {
      queueSessionNotice(sid, '已请求取消任务');
      return refreshActivity(sid);
    }).catch(function (err) {
      queueSessionNotice(sid, '取消任务失败: ' + err.message);
      scheduleActivityRefresh(sid, 500);
    });
  }

  function openChildSession(child) {
    if (!child || !child.id) return;
    if (!findSession(child.id)) state.sessions.unshift(child);
    switchSession(child.id);
  }

  function renderActivityCenter() {
    var sid = state.sid;
    var ui = uiFor(sid);
    var panel = $('#activityPanel');
    if (!sid || !ui || !panel) return;
    var session = findSession(sid) || {};
    var pendingApprovals = Object.keys(ui.approvals).map(function (id) { return ui.approvals[id]; });
    var pendingQuestions = Object.keys(ui.questions).map(function (id) { return ui.questions[id]; });
    var pendingCount = pendingApprovals.length + pendingQuestions.length;
    var queuedPrompts = Math.max(0, ui.submittedPrompts.length - 1);
    var busy = !!(session.busy || state.busy || ui.submitting || ui.waiting);
    var activityState = $('#activityState');
    if (activityState) {
      if (pendingCount) activityState.textContent = '等待你处理 ' + pendingCount + ' 项';
      else if (busy && queuedPrompts) activityState.textContent = '当前回答进行中 · 排队 ' + queuedPrompts + ' 条';
      else if (busy && ui.waitEscalated) activityState.textContent = 'Kimi 仍在执行，正在低频同步';
      else if (busy) activityState.textContent = '当前会话正在运行';
      else if (ui.activityLoading) activityState.textContent = '正在同步活动…';
      else if (ui.activityError) activityState.textContent = '活动同步失败：' + ui.activityError;
      else activityState.textContent = '本会话空闲';
      activityState.title = ui.activityError || activityState.textContent;
    }
    var retryButton = $('#activityRetry');
    if (retryButton) retryButton.hidden = !ui.activityError || ui.activityLoading;
    var pendingCountEl = $('#activityPendingCount');
    if (pendingCountEl) pendingCountEl.textContent = String(pendingCount);

    var any = renderActivityRows($('#activityPending'), pendingApprovals.concat(pendingQuestions), function (record) {
      var isApproval = !!record.data.approval_id;
      var data = record.data;
      return makeActivityItem({
        title: isApproval ? '需要许可 · ' + (data.tool_name || '操作') : '需要回答 · ' + (data.question || '问题'),
        detail: isApproval ? (data.action || interactionDisplayText(data.display)) : (data.description || ''),
        status: 'running',
        action: { label: '查看', onClick: function () { focusInteraction(isApproval ? data.approval_id : data.question_id); } },
      });
    });

    any = renderActivityRows($('#activityTasks'), ui.tasks || [], function (task) {
      var detail = task.command || task.output_preview || '';
      var meta = [activityKindText(task.kind), activityTime(task.started_at || task.created_at)].filter(Boolean).join(' · ');
      return makeActivityItem({
        title: activityKindText(task.kind) + ' · ' + (task.description || task.id),
        detail: detail,
        status: task.status,
        meta: meta,
        action: task.status === 'running' ? {
          label: '取消', title: '取消此任务', onClick: function () { cancelActivityTask(sid, task.id); },
        } : null,
      });
    }) || any;

    var live = (ui.liveActivityOrder || []).map(function (id) { return ui.liveActivities[id]; }).filter(Boolean).slice(-8).reverse();
    any = renderActivityRows($('#activityLiveTools'), live, function (record) {
      return makeActivityItem({
        title: activityKindText(record.kind) + ' · ' + record.name,
        detail: record.action || '',
        status: record.status,
        meta: activityTime(record.updated_at || record.started_at),
      });
    }) || any;

    any = renderActivityRows($('#activityChildren'), ui.children || [], function (child) {
      var childStatus = child.busy ? 'running' : (child.last_turn_reason || 'completed');
      var detail = child.pending_interaction && child.pending_interaction !== 'none' ?
        '等待' + (child.pending_interaction === 'approval' ? '许可' : '回答') : '';
      return makeActivityItem({
        title: child.title || '子代理会话', detail: detail, status: childStatus,
        meta: activityTime(child.updated_at),
        action: { label: '打开', onClick: function () { openChildSession(child); } },
      });
    }) || any;

    any = renderActivityRows($('#activityTerminals'), ui.terminals || [], function (terminal) {
      var detail = terminal.cwd || terminal.shell || '';
      var meta = terminal.status === 'exited' && terminal.exit_code != null ? '退出码 ' + terminal.exit_code : activityTime(terminal.created_at);
      return makeActivityItem({ title: terminal.shell || '终端', detail: detail, status: terminal.status, meta: meta });
    }) || any;

    var empty = $('#activityEmpty');
    if (empty) empty.hidden = any || ui.activityLoading;
  }

  function refreshActivity(sid) {
    if (!sid) return Promise.resolve();
    var ui = uiFor(sid);
    var gen = ++ui.activityRefreshGen;
    ui.activityLoading = true;
    if (sid === state.sid) renderActivityCenter();
    function load(path, key) {
      return api(path).then(function (data) { return { key: key, data: data, error: null }; })
        .catch(function (error) { return { key: key, data: null, error: error }; });
    }
    return Promise.all([
      load('/sessions/' + encodeURIComponent(sid) + '/tasks', 'tasks'),
      load('/sessions/' + encodeURIComponent(sid) + '/children', 'children'),
      load('/sessions/' + encodeURIComponent(sid) + '/terminals', 'terminals'),
    ]).then(function (results) {
      if (ui.activityRefreshGen !== gen) return;
      var errors = [];
      results.forEach(function (result) {
        if (result.error) {
          errors.push(result.error.message);
          return;
        }
        ui[result.key] = result.data && result.data.items || [];
      });
      ui.activityError = errors.join('；');
      ui.activityLoaded = true;
    }).finally(function () {
      if (ui.activityRefreshGen === gen) {
        ui.activityLoading = false;
        if (sid === state.sid) renderActivityCenter();
      }
    });
  }

  function scheduleActivityRefresh(sid, delay) {
    var ui = uiFor(sid);
    if (!ui || ui.activityRefreshTimer) return;
    ui.activityRefreshTimer = setTimeout(function () {
      ui.activityRefreshTimer = null;
      refreshActivity(sid).catch(function () { /* UI 已保留上次可用状态 */ });
    }, delay == null ? 250 : delay);
  }

  function stopWaitLoop(sid) {
    var ui = uiFor(sid);
    if (!ui) return;
    ui.waitGeneration++;
    ui.waiting = false;
    ui.waitAttempts = 0;
    ui.waitEscalated = false;
    if (ui.waitTimer) {
      clearTimeout(ui.waitTimer);
      ui.waitTimer = null;
    }
  }

  /* 一轮结束:清掉该会话轮询；只在它仍是当前会话时清理流式 DOM。 */
  function clearPending(sid) {
    sid = sid || state.sid;
    stopWaitLoop(sid);
    if (sid === state.sid) clearLivePresentation();
  }

  /* 轮询兜底:每个会话独立等待。长任务降为低频同步而非伪造“超时结束”。 */
  function startWaitLoop(sid, renew) {
    sid = sid || state.sid;
    var ui = uiFor(sid);
    if (!ui || ui.archived || (ui.waiting && !renew)) return;
    if (ui.waitTimer) {
      clearTimeout(ui.waitTimer);
      ui.waitTimer = null;
    }
    var generation = ++ui.waitGeneration;
    ui.waiting = true;
    ui.waitAttempts = 0;
    ui.waitEscalated = false;

    function schedule() {
      if (!ui.waiting || ui.waitGeneration !== generation) return;
      ui.waitTimer = setTimeout(poll, ui.waitEscalated ? 10000 : 2500);
    }
    function poll() {
      ui.waitTimer = null;
      if (!ui.waiting || ui.waitGeneration !== generation) return;
      if (ui.submitting) {
        schedule();
        return;
      }
      ui.waitAttempts++;
      if (!ui.waitEscalated && ui.waitAttempts > 40) {
        ui.waitEscalated = true;
        /* Kimi 的工具任务可能超过 100 秒；保留用户消息和停止按钮，改为低频确认。 */
        if (sid === state.sid) {
          refreshMessages();
          renderActivityCenter();
        }
        refreshActivity(sid).catch(function () { /* 保留最后一次可用活动状态 */ });
        schedule();
        return;
      }
      api('/sessions/' + encodeURIComponent(sid)).then(function (s) {
        if (!ui.waiting || ui.waitGeneration !== generation) return;
        mergeSessionSnapshot(s);
        if (!s.busy && !s.main_turn_active &&
            (!s.pending_interaction || s.pending_interaction === 'none')) {
          settleIdleSession(sid, ui.abortAccepted || ui.restoreQueueOnIdle || !!ui.abortTarget);
          stopWaitLoop(sid);
          if (sid === state.sid) clearLivePresentation();
          return hydrateSession(sid, { replaceMessages: sid === state.sid });
        }
        renderSessionList();
        schedule();
      }).catch(function () {
        if (ui.waitGeneration === generation) schedule();
      });
    }
    schedule();
  }
