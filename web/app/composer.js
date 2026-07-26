  /* ================= 发送 / 停止 ================= */

  function setBusy(b) {
    state.busy = b;
    var ui = currentUi();
    if (!b && ui) ui.aborting = false;
    /* 发送始终可用(服务端会排队),停止按钮只在忙碌时出现 */
    $('#stopBtn').style.display = b ? '' : 'none';
    input.placeholder = b ? '可继续输入后续要求，发送后将排队' : '输入消息';
    updateComposerState();
    if (state.sid) renderActivityCenter();
  }

  function updateComposerState() {
    var ui = currentUi();
    var blocked = !ui || ui.uploading > 0 || ui.submitting || ui.aborting;
    var hasContent = !!(ui && (input.value.trim() || ui.pendingFiles.some(function (f) { return f.status === 'ready'; })));
    $('#sendBtn').disabled = blocked || !hasContent;
    $('#imgBtn').disabled = !ui || ui.submitting || ui.aborting;
    $('#attachBtn').disabled = !ui || ui.submitting || ui.aborting;
    var shortcut = state.sendMode === 'ctrl' ? 'Ctrl+Enter' : 'Enter';
    $('#sendBtn').textContent = ui && ui.uploading > 0 ? '上传中…' : (ui && ui.submitting ? '发送中…' : '发送');
    $('#sendBtn').title = shortcut + '发送' + (state.busy ? '；当前回答进行中，新消息将排队' : '');
    $('#sendBtn').setAttribute('aria-label', $('#sendBtn').title);
    $('#stopBtn').disabled = !!(ui && ui.aborting);
    $('#stopBtn').textContent = ui && ui.aborting ? '停止中…' : '停止';
    $$('.attach-del').forEach(function (btn) { btn.disabled = !!(ui && (ui.submitting || ui.aborting)); });
    syncSendHint(ui, shortcut);
  }

  /* 输入区左下角的状态/快捷键提示：发送方式此前只能靠 tooltip 或 ▾ 菜单发现。 */
  function syncSendHint(ui, shortcut) {
    var hint = $('#sendHint');
    if (!hint) return;
    var text;
    if (ui && ui.uploading > 0) text = '附件上传中，完成后可发送';
    else if (state.busy) text = '回答进行中 · 发送后排队';
    else text = shortcut + ' 发送 · ' + (state.sendMode === 'ctrl' ? 'Enter' : 'Shift+Enter') + ' 换行';
    hint.textContent = text;
    hint.title = text;
  }

  function rememberSubmittedPrompt(sid, text, files, outgoing) {
    var ui = uiFor(sid);
    if (!ui) return null;
    var record = {
      text: String(text || ''),
      fileNames: (files || []).map(function (file) { return file.name || '文件'; }),
      sentAt: Date.now(),
      knownMessageIds: Object.assign({}, state.rendered),
      generation: ++ui.operationGeneration,
      outgoing: outgoing || null,
      restored: false,
      accepted: false,
      cancelRequested: false,
      controller: null,
      attachmentsNeedReselect: false,
    };
    ui.submittedPrompts.push(record);
    return record;
  }

  /* 停止生成后把本轮原始文字放回输入框。若用户已经写了新草稿，
     则保留两者，不用恢复动作覆盖新内容。 */
  function restoreAbortedPrompt(sid, record) {
    var ui = uiFor(sid);
    record = record || (ui && ui.submittedPrompts[0]);
    if (!record || record.restored) return false;
    record.restored = true;
    var recovered = record.text;
    var draft = ui.draft || '';
    if (recovered && draft !== recovered) {
      setDraft(sid, recovered + (draft ? '\n\n' + draft : ''));
    }
    if (sid === state.sid) {
      restoreComposer(sid);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if (record.attachmentsNeedReselect && record.fileNames.length) {
      queueSessionNotice(sid, '已停止；文字已回填，附件需要重新选择：' + record.fileNames.join('、'));
    }
    return true;
  }

  function finishSubmittedPrompt(sid, aborted) {
    var ui = uiFor(sid);
    if (!ui) return 0;
    var record = ui.submittedPrompts.shift() || ui.abortTarget;
    if (record) {
      record.settled = true;
      record.accepted = true;
      record.attachmentsNeedReselect = !!record.fileNames.length;
    }
    if (aborted && record) restoreAbortedPrompt(sid, record);
    if (record && ui.abortTarget === record && !aborted) {
      ui.abortTarget = null;
      ui.aborting = false;
    }
    return ui.submittedPrompts.length;
  }

  function removeSubmittedPrompt(sid, record) {
    var ui = uiFor(sid);
    if (!ui || !record) return;
    var index = ui.submittedPrompts.indexOf(record);
    if (index >= 0) ui.submittedPrompts.splice(index, 1);
  }

  function promptAppearsInSnapshot(record, snap) {
    var items = snap && snap.messages && snap.messages.items || [];
    return items.some(function (message) {
      if (!message || message.role !== 'user') return false;
      if (message.id && record.knownMessageIds && record.knownMessageIds[message.id]) return false;
      var createdAt = Date.parse(message.created_at || '');
      if (Number.isFinite(createdAt) && createdAt + 5000 < record.sentAt) return false;
      var parts = message.content || [];
      var text = parts.filter(function (part) { return part.type === 'text' && part.text; })
        .map(function (part) { return String(part.text); }).join('\n').trim();
      var attachmentCount = parts.filter(function (part) { return part.type === 'image' || part.type === 'file'; }).length;
      return text === record.text.trim() && attachmentCount >= record.fileNames.length;
    });
  }

  function reconcileUnknownSubmission(sid, record, attempt) {
    attempt = attempt || 0;
    return Promise.all([
      api('/sessions/' + encodeURIComponent(sid) + '/snapshot', { timeoutMs: 3500 })
        .then(function (snap) { return promptAppearsInSnapshot(record, snap); })
        .catch(function () { return false; }),
      api('/sessions/' + encodeURIComponent(sid) + '/messages', { timeoutMs: 3500 })
        .then(function (messages) { return promptAppearsInSnapshot(record, { messages: messages }); })
        .catch(function () { return false; }),
    ]).then(function (matches) { return matches.some(Boolean); })
      .then(function (accepted) {
        if (accepted || attempt >= 2) return accepted;
        return new Promise(function (resolve) { setTimeout(resolve, 400 * (attempt + 1)); })
          .then(function () { return reconcileUnknownSubmission(sid, record, attempt + 1); });
      });
  }

  function releaseSubmittedFiles(sid, ui, sentFiles) {
    ui.pendingFiles = ui.pendingFiles.filter(function (file) {
      if (sentFiles.indexOf(file) === -1) return true;
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      return false;
    });
    if (state.sid === sid) renderAttachRow();
  }

  function markPromptAccepted(sid, ui, record, sentFiles, uncertain) {
    record.accepted = true;
    record.controller = null;
    record.attachmentsNeedReselect = !!sentFiles.length;
    ui.submitting = false;
    releaseSubmittedFiles(sid, ui, sentFiles);
    if (ui.archived) return;
    if (state.sid === sid) {
      updateComposerState();
      refreshMessages();
      /* 排队发送(发送时会话已在忙)不显示 typing:回合尚未开始,
         其位置由真正的 turn.started 事件驱动。 */
      if (!record.settled && !record.queued) showTyping();
      if (uncertain) notifyUi('已从会话记录确认：服务端已接收这条消息');
    }
    if (!record.settled) startWaitLoop(sid, true);
    loadSessions().catch(function () { /* WS/轮询仍会更新 */ });
  }

  function send() {
    var sid = state.sid;
    var ui = uiFor(sid);
    if (!sid || !ui || ui.submitting || ui.aborting) return;
    var text = input.value;
    /* 直接键入 "/cmd 参数" 回车：命中本地/服务端命令就执行而不是发送(CLI 行为);
       prompt 类命令与未匹配的 / 文本仍按普通消息走原管线。 */
    var direct = text.trim().charAt(0) === '/' ? slashCommandFromText(text) : null;
    if (direct) {
      setDraft(sid, '');
      input.value = '';
      compClose();
      resizeComposer();
      updateComposerState();
      direct.cmd.run(direct.args);
      return;
    }
    if (ui.uploading > 0) {
      notifyUi('附件仍在上传，请稍候…');
      return;
    }
    if (ui.pendingFiles.some(function (f) { return f.status === 'fail'; })) {
      notifyUi('请先移除上传失败的附件', 'error');
      return;
    }
    var sentFiles = ui.pendingFiles.filter(function (f) { return f.status === 'ready'; });
    if (!text.trim() && !sentFiles.length) return;
    var session = findSession(sid);
    var wasBusy = !!(state.busy || session && session.busy || ui.waiting);
    /* 用户的新发送使尚未返回的旧 snapshot 失效。 */
    state.hydrateGen[sid] = (state.hydrateGen[sid] || 0) + 1;

    /* 先固定本地时间线位置，再让服务端确认并接管这条消息。 */
    var content = [];
    if (text.trim()) content.push({ type: 'text', text: text });
    sentFiles.forEach(function (f) {
      if (f.media_type && f.media_type.indexOf('image/') === 0) {
        content.push({ type: 'image', source: { kind: 'file', file_id: f.id } });
      } else {
        content.push({ type: 'file', file_id: f.id, name: f.name, media_type: f.media_type, size: f.size });
      }
    });
    var pendingOutgoing = appendPendingOutgoing(sid, text, sentFiles);
    var submittedPrompt = rememberSubmittedPrompt(sid, text, sentFiles, pendingOutgoing);
    /* 发送时会话已在忙 = 本条排队等待。排队回合不提前显示“正在输入”，
       否则幻影 typing 块插在排队消息之间，后续消息被挤到 Kimi 块下方。 */
    submittedPrompt.queued = wasBusy;
    var promptController = new AbortController();
    submittedPrompt.controller = promptController;

    setDraft(sid, '');
    input.value = '';
    compClose();
    resizeComposer();
    ui.submitting = true;
    updateComposerState();
    setBusy(true);
    startWaitLoop(sid, true);
    if (session) session.busy = true;
    renderSessionList();

    api('/sessions/' + encodeURIComponent(sid) + '/prompts', {
      method: 'POST',
      body: JSON.stringify({
        content: content,
        model: sessionModel(sid),
      }),
      signal: promptController.signal,
    }).then(function () {
      markPromptAccepted(sid, ui, submittedPrompt, sentFiles, false);
    }).catch(function (e) {
      submittedPrompt.controller = null;
      if (submittedPrompt.cancelRequested && ui.abortAccepted) {
        ui.submitting = false;
        removeSubmittedPrompt(sid, submittedPrompt);
        if (submittedPrompt.accepted) releaseSubmittedFiles(sid, ui, sentFiles);
        if (state.sid === sid) updateComposerState();
        return;
      }
      var resultUnknown = !e.status;
      var reconciliation = resultUnknown ? reconcileUnknownSubmission(sid, submittedPrompt) : Promise.resolve(false);
      reconciliation.then(function (accepted) {
        if (accepted) {
          markPromptAccepted(sid, ui, submittedPrompt, sentFiles, true);
          return;
        }
        ui.submitting = false;
        removeSubmittedPrompt(sid, submittedPrompt);
        discardPendingOutgoing(sid, pendingOutgoing);
        var failedSession = findSession(sid);
        if (failedSession) failedSession.busy = wasBusy;
        if (state.sid === sid) setBusy(wasBusy);
        if (!wasBusy) stopWaitLoop(sid);
        if (text && ui.draft !== text) setDraft(sid, text + (ui.draft ? '\n' + ui.draft : ''));
        if (state.sid === sid) {
          restoreComposer(sid);
          updateComposerState();
        }
        renderSessionList();
        queueSessionNotice(sid, '⚠ 发送失败: ' + e.message);
      });
    });
  }

  function abort() {
    var sid = state.sid;
    var ui = uiFor(sid);
    if (!sid || !ui || ui.aborting) return;
    var target = ui.submittedPrompts[0] || null;
    if (target) target.cancelRequested = true;
    ui.abortTarget = target;
    ui.abortAccepted = false;
    ui.restoreQueueOnIdle = false;
    ui.aborting = true;
    updateComposerState();
    api('/sessions/' + encodeURIComponent(sid) + ':abort', { method: 'POST', body: '{}' })
      .then(function () {
        if (!ui.aborting || (target && target.settled)) return;
        ui.abortAccepted = true;
        if (target && target.controller) target.controller.abort();
        startWaitLoop(sid, true);
      })   /* WS 事件丢失时靠轮询收尾 */
      .catch(function (e) {
        if (target) target.cancelRequested = false;
        ui.abortTarget = null;
        ui.abortAccepted = false;
        ui.aborting = false;
        queueSessionNotice(sid, '停止失败: ' + e.message);
        if (state.sid === sid) updateComposerState();
      });
  }

  $('#sendBtn').addEventListener('click', send);
  $('#stopBtn').addEventListener('click', abort);
  /* WKWebView 用回车确认输入法候选词时,该 keydown 常在 compositionend 之后才
     派发且 isComposing 已为 false,单靠 e.isComposing/229 拦不住,会误触发发送。
     因此本地跟踪组词状态,并在组词结束后的短时间窗口内忽略这一次回车。 */
  var imeComposing = false;
  var imeEndedAt = 0;
  input.addEventListener('compositionstart', function () { imeComposing = true; });
  input.addEventListener('compositionend', function () {
    imeComposing = false;
    imeEndedAt = Date.now();
  });

  function imeGuardEnter(e) {
    if (e.isComposing || e.keyCode === 229 || imeComposing) return true;
    return e.key === 'Enter' && Date.now() - imeEndedAt < 120;
  }

  input.addEventListener('keydown', function (e) {
    /* 中文输入法组词中按 Enter 是确认候选词,不能发送 */
    if (imeGuardEnter(e)) return;
    /* 补全菜单打开时优先接管导航键；无候选时 Enter 照常发送(与 CLI 行为一致) */
    if (comp.mode) {
      if (e.key === 'ArrowDown') { e.preventDefault(); compMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); compMove(-1); return; }
      if (e.key === 'Home' && comp.items.length) { e.preventDefault(); comp.active = 0; compSyncActive(); return; }
      if (e.key === 'End' && comp.items.length) { e.preventDefault(); comp.active = comp.items.length - 1; compSyncActive(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && comp.items.length) {
        e.preventDefault();
        compApply(comp.active);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); compClose(); return; }
    }
    /* macOS WebKit 的 Home/End 只滚动不移动光标,补上手水平跳转到行首/行尾(Shift 扩展选区) */
    if ((e.key === 'Home' || e.key === 'End') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      var pos = input.selectionStart;
      var lineStart = input.value.slice(0, pos).lastIndexOf('\n') + 1;
      var rest = input.value.slice(input.selectionEnd);
      var nl = rest.indexOf('\n');
      var lineEnd = input.selectionEnd + (nl < 0 ? rest.length : nl);
      var target = e.key === 'Home' ? lineStart : lineEnd;
      if (e.shiftKey) {
        var anchor = input.selectionDirection === 'backward' ? input.selectionEnd : pos;
        input.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target),
          target <= anchor ? 'backward' : 'forward');
      } else {
        input.setSelectionRange(target, target);
      }
      compDetect();
      return;
    }
    if (e.key === 'Enter') {
      var want = state.sendMode === 'ctrl'
        ? (e.ctrlKey || e.metaKey)          /* Ctrl+Enter 发送,Enter 换行 */
        : !e.shiftKey;                      /* Enter 发送,Shift+Enter 换行 */
      if (want) {
        e.preventDefault();
        send();
      }
    }
  });

  /* 输入框随内容长高(最多约 6 行) */
  input.addEventListener('input', function () {
    if (currentUi()) setDraft(state.sid, input.value);
    resizeComposer();
    updateComposerState();
    compDetect();
  });

  /* 光标移出触发词时关闭补全菜单 */
  input.addEventListener('click', compDetect);
  input.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') compDetect();
  });
