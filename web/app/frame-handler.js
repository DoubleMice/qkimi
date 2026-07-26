  /* ================= WS 事件处理 ================= */

  function handleFrame(f) {
    var fsid = f.session_id;
    var p = f.payload || {};
    var eventSid = fsid || p.session_id || p.sessionId || state.sid;
    if (f.type !== 'resync_required' && eventSid && typeof f.seq === 'number') {
      if (f.seq <= (state.lastSeq[eventSid] || 0)) return;
      state.lastSeq[eventSid] = f.seq;
    }

    if (f.type === 'resync_required' && eventSid) {
      if (typeof p.current_seq === 'number') state.lastSeq[eventSid] = p.current_seq;
      if (p.epoch) state.epochs[eventSid] = p.epoch;
      hydrateSession(eventSid, { replaceMessages: eventSid === state.sid })
        .catch(function (e) { queueSessionNotice(eventSid, '会话重新同步失败: ' + e.message); });
      return;
    }
    if (f.type === 'event.session.history_compacted' && eventSid) {
      hydrateSession(eventSid, { replaceMessages: eventSid === state.sid })
        .catch(function (e) { queueSessionNotice(eventSid, '压缩后恢复会话失败: ' + e.message); });
      return;
    }

    /* 全会话范围的状态(列表小红点/标题) */
    if ((f.type === 'event.session.work_changed' || f.type === 'event.session.status_changed') && eventSid) {
      var s = findSession(eventSid);
      var terminalUi = uiFor(eventSid);
      var busy = f.type === 'event.session.status_changed'
        ? p.status !== 'idle' && p.status !== 'aborted'
        : !!p.busy;
      /* 服务器尚未看到本地新发送时，上一轮晚到的 idle 不能清掉新轮次。 */
      var deferIdle = !busy && hasUnsettledPrompt(terminalUi) &&
        !terminalUi.abortAccepted && !terminalUi.restoreQueueOnIdle;
      if (deferIdle) {
        if (s) s.busy = true;
        if (eventSid === state.sid) setBusy(true);
        startWaitLoop(eventSid);
        renderSessionList();
        scheduleActivityRefresh(eventSid, 120);
        return;
      }
      if (s) {
        s.busy = busy;
        if (p.main_turn_active != null) s.main_turn_active = !!p.main_turn_active;
        if (p.pending_interaction) s.pending_interaction = p.pending_interaction;
        renderSessionList();
      }
      if (busy && terminalUi.restoreQueueOnIdle && !terminalUi.aborting) terminalUi.restoreQueueOnIdle = false;
      if (eventSid === state.sid) setBusy(busy);
      if (busy) startWaitLoop(eventSid);
      else {
        settleIdleSession(eventSid, terminalUi.abortAccepted || terminalUi.restoreQueueOnIdle || !!terminalUi.abortTarget);
        clearPending(eventSid);
        hydrateSession(eventSid, { replaceMessages: eventSid === state.sid, skipWaitStart: true })
          .catch(function () { if (eventSid === state.sid) return refreshMessages(); });
      }
      scheduleActivityRefresh(eventSid, 120);
      return;
    }
    if ((f.type === 'session.meta.updated' || f.type === 'event.session.updated') && eventSid) {
      var nextSession = p.session || p;
      var s2 = findSession(eventSid);
      if (s2) {
        if (nextSession.title) s2.title = nextSession.title;
        if (nextSession.agent_config) {
          s2.agent_config = s2.agent_config || {};
          Object.assign(s2.agent_config, nextSession.agent_config);
        }
        if (nextSession.permission) {
          s2.permission = nextSession.permission;
        }
        renderSessionList();
      }
      if (eventSid === state.sid) {
        if (nextSession.title) applyTitle(nextSession.title);
        syncPermissionControl(eventSid);
      }
      /* 事件负载的 agent_config 不含权限字段，权威值以 /status 为准。 */
      if (nextSession.agent_config || nextSession.permission) {
        api('/sessions/' + encodeURIComponent(eventSid) + '/status')
          .then(function (status) { applySessionStatus(eventSid, status); })
          .catch(function () { /* 忽略瞬时失败，下轮 hydrate 会补齐 */ });
      }
      return;
    }

    /* 交互请求按事件所属会话保存，切换会话后也不会串到当前 sid。 */
    if (f.type === 'event.approval.requested' || f.type === 'permission.approval.requested') {
      registerApproval(eventSid, p);
      /* 有待处理审批：宠物举牌求关注，直到用户处理 */
      if (eventSid === state.sid) setPetMode('attention');
      return;
    }
    if (f.type === 'event.approval.resolved' || f.type === 'permission.approval.resolved') {
      settleApproval(eventSid, p.approval_id || p.approvalId || p.toolCallId, '✅ 已处理');
      if (eventSid === state.sid && petMode === 'attention') setPetMode('idle');
      return;
    }
    if (f.type === 'event.approval.expired' || f.type === 'permission.approval.expired') {
      settleApproval(eventSid, p.approval_id || p.approvalId || p.toolCallId, '⏹ 已过期');
      if (eventSid === state.sid && petMode === 'attention') setPetMode('idle');
      return;
    }
    if (f.type === 'event.question.requested') {
      registerQuestion(eventSid, p);
      if (eventSid === state.sid) setPetMode('attention');
      return;
    }
    if (f.type === 'event.question.answered') {
      settleQuestion(eventSid, p.question_id || p.questionId, '✅ 已回答');
      if (eventSid === state.sid && petMode === 'attention') setPetMode('idle');
      return;
    }
    if (f.type === 'event.question.dismissed') {
      settleQuestion(eventSid, p.question_id || p.questionId, '⏭ 已跳过');
      if (eventSid === state.sid && petMode === 'attention') setPetMode('idle');
      return;
    }

    switch (f.type) {
      case 'ping':
        wsSend({ type: 'pong', payload: { nonce: p.nonce } });
        break;

      case 'turn.started':
        if (eventSid === state.sid) showTyping();
        scheduleActivityRefresh(eventSid, 120);
        break;

      case 'thinking.delta':
        if (eventSid === state.sid) appendThink(p.delta || '');
        if (eventSid === state.sid) setPetMode('thinking');
        break;

      case 'assistant.delta':
      case 'event.assistant.delta':
        if (eventSid === state.sid) appendDelta(p.delta || '');
        /* 纯文本流式时也让宠物保持思考态 */
        if (eventSid === state.sid) setPetMode('thinking');
        break;

      case 'tool.call.started':
      case 'tool.use':
        showActivity(p, eventSid);
        playToolPop();
        if (eventSid === state.sid) setPetMode('working');
        break;

      case 'tool.result':
        finishActivity(eventSid, p);
        break;

      case 'agent.status.updated':
        applySessionStatus(eventSid, {
          model: p.model || (state.sessionStatus[eventSid] && state.sessionStatus[eventSid].model),
          context_tokens: p.contextTokens == null ? p.context_tokens : p.contextTokens,
          max_context_tokens: p.maxContextTokens == null ? p.max_context_tokens : p.maxContextTokens,
        });
        break;

      case 'event.message.created':
      case 'event.message.updated':
        if (eventSid === state.sid) refreshMessages();
        break;

      case 'prompt.completed':
        finishSubmittedPrompt(eventSid, false);
        /* 本地队列可能在刷新后为空；终态后仍以 snapshot/轮询确认整个会话是否空闲。 */
        startWaitLoop(eventSid, true);
        /* 队列里还有后续回合时，hydrate 只能增量合并、不会整体重建；
           先清掉本回合的流式残留，否则下一回合的输出会续进旧气泡。 */
        if (eventSid === state.sid && hasUnsettledPrompt(uiFor(eventSid))) clearLivePresentation();
        hydrateSession(eventSid, { replaceMessages: eventSid === state.sid })
          .catch(function () { if (eventSid === state.sid) return refreshMessages(); });
        playDiDi();
        if (eventSid === state.sid) {
          setPetMode('happy');
          addPetExp(10); /* 完成回合 +10 经验 */
        }
        announceReply('Kimi 回答已完成');
        flashTitle();
        scheduleActivityRefresh(eventSid, 0);
        break;

      case 'prompt.aborted':
        var abortedRemaining = finishSubmittedPrompt(eventSid, true);
        var abortedUi = uiFor(eventSid);
        if (abortedUi) {
          abortedUi.restoreQueueOnIdle = abortedRemaining > 0;
          abortedUi.abortTarget = null;
          abortedUi.abortAccepted = false;
          abortedUi.aborting = false;
        }
        startWaitLoop(eventSid, true);
        /* 同 prompt.completed：队列未空时 hydrate 只增量合并，先清流式残留。 */
        if (eventSid === state.sid && hasUnsettledPrompt(uiFor(eventSid))) clearLivePresentation();
        hydrateSession(eventSid, { replaceMessages: eventSid === state.sid })
          .catch(function () { if (eventSid === state.sid) return refreshMessages(); })
          .then(function () { queueSessionNotice(eventSid, '已停止'); });
        if (eventSid === state.sid) setPetMode('idle');
        announceReply('Kimi 回答已停止');
        scheduleActivityRefresh(eventSid, 0);
        break;

      case 'error':
        finishSubmittedPrompt(eventSid, true);
        startWaitLoop(eventSid, true);
        queueSessionNotice(eventSid, '⚠ ' + (p.message || '出错了'));
        announceReply('Kimi 回答出错');
        playErrorBuzz();
        if (eventSid === state.sid) setPetMode('sad');
        hydrateSession(eventSid, { replaceMessages: eventSid === state.sid })
          .catch(function () { if (eventSid === state.sid) return refreshMessages(); });
        scheduleActivityRefresh(eventSid, 0);
        break;

      default:
        if (/^(event\.)?(task|terminal|subagent)\./.test(f.type || '')) scheduleActivityRefresh(eventSid, 150);
        if (f.type !== 'ack' && f.type !== 'server_hello') {
          console.debug('[kimi2007] frame', f.type, f);
        }
    }
  }
