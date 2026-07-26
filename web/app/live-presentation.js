  /* ================= 进行状态(typing/流式/思考/工具) ================= */

  /* typing 静默计时:首包前的等待分阶段更新文案，避免长时间看似无响应。 */
  function typingStageText() {
    var waited = Math.floor((Date.now() - state.silenceStart) / 1000);
    if (waited > 20) return '仍在处理中，请耐心等待 (' + waited + 's)';
    if (waited > 8) return '正在思考，马上就好...';
    return '正在输入...';
  }

  function updateTypingText() {
    if (!state.typingEl) return;
    var span = state.typingEl.querySelector('.typing-text');
    if (span) span.textContent = typingStageText();
  }

  function startSilenceTimer() {
    stopSilenceTimer();
    state.silenceStart = Date.now();
    state.silenceTimer = setInterval(updateTypingText, 1000);
  }

  function stopSilenceTimer() {
    if (state.silenceTimer) {
      clearInterval(state.silenceTimer);
      state.silenceTimer = null;
    }
  }

  /* 任何活动信号(delta/思考/工具)到达时重置静默计时与 typing 文案。 */
  function noteProgress() {
    state.silenceStart = Date.now();
    updateTypingText();
  }

  function showTyping() {
    if (state.typingEl || state.streamEl) return;
    titleText.textContent = titleText.textContent.replace('  (对方正在输入...)', '') + '  (对方正在输入...)';
    /* 声波条纹动画 + 跳点 + 文字提示；流式首包到达时 appendDelta 会清空 msg-body 复用该气泡。 */
    state.typingEl = appendMsg('bot',
      '<span class="wave-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
      '<span class="typing-text">正在输入...</span>' +
      '<span class="tdots" aria-hidden="true"><i></i><i></i><i></i></span>', true);
    state.typingEl.classList.add('typing');
    startSilenceTimer();
  }

  function hideTyping() {
    if (state.typingEl) {
      state.typingEl.remove();
      state.typingEl = null;
    }
    stopSilenceTimer();
    titleText.textContent = titleText.textContent.replace('  (对方正在输入...)', '');
  }

  /* 流式期间按节拍打渲染 Markdown，避免纯文本到排版结果的最终跳变。
     未闭合的代码围栏临时补齐；渲染异常时回退纯文本，下一拍自愈。 */
  function renderStreamMarkdown() {
    state.streamRenderTimer = null;
    if (!state.streamEl) return;
    var stick = nearBottom();
    var text = state.streamText;
    var src = (text.match(/```/g) || []).length % 2 ? text + '\n```' : text;
    var body = state.streamEl.querySelector('.msg-body');
    try {
      body.innerHTML = renderMd(src);
    } catch (e) {
      body.textContent = text;
    }
    followScroll(stick);
  }

  function appendDelta(d) {
    if (!d) return;
    noteProgress();
    var stick = nearBottom();
    if (!state.streamEl) {
      if (state.typingEl) {
        state.streamEl = state.typingEl;
        state.typingEl = null;
        state.streamEl.classList.remove('typing');
        state.streamEl.querySelector('.msg-body').textContent = '';
      } else {
        state.streamEl = appendMsg('bot', '');
      }
      state.streamText = '';
    }
    state.streamText += d;
    /* 首拍立即渲染避免空气泡，后续按 120ms 节流。 */
    if (!state.streamEl.querySelector('.msg-body').firstChild) {
      renderStreamMarkdown();
    } else if (!state.streamRenderTimer) {
      state.streamRenderTimer = setTimeout(renderStreamMarkdown, 120);
    }
    followScroll(stick);
  }

  function appendThink(d) {
    if (!d) return;
    noteProgress();
    var stick = nearBottom();
    state.thinkText += d;
    if (!state.thinkEl) {
      state.thinkEl = appendMsg('bot',
        '<div class="think-live-head">💭 思考中' +
        '<span class="tdots" aria-hidden="true"><i></i><i></i><i></i></span></div>' +
        '<div class="think-live-body"></div>', true);
      state.thinkEl.classList.add('thinking-live');
    }
    /* 保留末尾约 1200 字符；正文限高滚动，每次更新自动滚到底部。 */
    var t = state.thinkText;
    if (t.length > 1200) t = t.slice(-1200);
    var body = state.thinkEl.querySelector('.think-live-body');
    if (body) {
      body.textContent = t;
      body.scrollTop = body.scrollHeight;
    }
    followScroll(stick);
  }

  function recordLiveActivity(sid, p, status) {
    var ui = uiFor(sid);
    if (!ui) return null;
    var name = p.toolName || p.tool_name || p.name || '';
    var action = p.action || p.description || '';
    var id = p.task_id || p.taskId || p.tool_call_id || p.toolCallId || p.id;
    if (!id && status !== 'running') id = ui.lastLiveActivityId;
    if (!id && ui.lastLiveActivityId) {
      var previous = ui.liveActivities[ui.lastLiveActivityId];
      if (previous && previous.name === name && previous.status === 'running') id = previous.id;
    }
    if (!id) id = 'live_' + (++state.activitySeq);
    var record = ui.liveActivities[id];
    if (!record) {
      record = { id: id, kind: p.kind || 'tool', name: name || 'tool', action: action, status: status || 'running', started_at: new Date().toISOString() };
      ui.liveActivities[id] = record;
      ui.liveActivityOrder.push(id);
    }
    record.kind = p.kind || record.kind || 'tool';
    record.name = name || record.name;
    record.action = action || record.action;
    record.status = status || record.status;
    record.updated_at = new Date().toISOString();
    ui.lastLiveActivityId = record.status === 'running' ? id : null;
    while (ui.liveActivityOrder.length > 16) {
      var staleIndex = ui.liveActivityOrder.findIndex(function (candidate) { return candidate !== ui.lastLiveActivityId; });
      if (staleIndex < 0) break;
      var stale = ui.liveActivityOrder.splice(staleIndex, 1)[0];
      delete ui.liveActivities[stale];
    }
    return record;
  }

  /* 工具行已运行秒数刷新；activityStart 取自活动记录的开始时间。 */
  function startActivityTick() {
    if (!state.activityTick) {
      state.activityTick = setInterval(updateActivityElapsed, 1000);
    }
    updateActivityElapsed();
  }

  function stopActivityTick() {
    if (state.activityTick) {
      clearInterval(state.activityTick);
      state.activityTick = null;
    }
  }

  function updateActivityElapsed() {
    if (!state.activityEl) return;
    var el = state.activityEl.querySelector('.tool-elapsed');
    if (el) el.textContent = ' ' + Math.max(0, Math.floor((Date.now() - state.activityStart) / 1000)) + 's';
  }

  function showActivity(p, sid) {
    sid = sid || state.sid;
    var record = recordLiveActivity(sid, p || {}, 'running');
    if (sid !== state.sid || !record) {
      renderSessionList();
      return;
    }
    noteProgress();
    var stick = nearBottom();
    if (!state.activityEl) {
      state.activityEl = document.createElement('div');
      state.activityEl.className = 'tool-line';
      chatBody.appendChild(state.activityEl);
    }
    state.activityEl.innerHTML =
      '<span class="tool-ico running">🔧</span>' +
      '<span class="tool-text"></span>' +
      '<span class="tdots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="tool-elapsed"></span>';
    state.activityEl.querySelector('.tool-text').textContent =
      record.name + (record.action ? ': ' + record.action : '');
    state.activityStart = Date.parse(record.started_at) || Date.now();
    startActivityTick();
    followScroll(stick);
    renderActivityCenter();
    scheduleActivityRefresh(sid, 350);
  }

  function finishActivity(sid, payload) {
    sid = sid || state.sid;
    var record = recordLiveActivity(sid, payload || {}, payload && payload.error ? 'failed' : 'completed');
    if (sid === state.sid && state.activityEl) {
      stopActivityTick();
      var secs = Math.max(0, Math.round((Date.now() - state.activityStart) / 1000));
      var ico = state.activityEl.querySelector('.tool-ico');
      if (ico) ico.classList.remove('running');
      var dots = state.activityEl.querySelector('.tdots');
      if (dots) dots.remove();
      var elapsed = state.activityEl.querySelector('.tool-elapsed');
      if (elapsed) elapsed.textContent = ' ✔ ' + secs + 's';
    }
    if (sid === state.sid && record) renderActivityCenter();
    scheduleActivityRefresh(sid, 350);
  }

  function clearLivePresentation() {
    if (state.streamRenderTimer) {
      clearTimeout(state.streamRenderTimer);
      state.streamRenderTimer = null;
    }
    stopSilenceTimer();
    stopActivityTick();
    if (state.streamEl) { state.streamEl.remove(); state.streamEl = null; state.streamText = ''; }
    if (state.thinkEl) { state.thinkEl.remove(); state.thinkEl = null; state.thinkText = ''; }
    if (state.activityEl) { state.activityEl.remove(); state.activityEl = null; }
    hideTyping();
  }
