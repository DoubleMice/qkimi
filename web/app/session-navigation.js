  /* 多窗口共享 localStorage：按工作区分别记住最后会话，避免窗口间互相覆盖恢复目标。 */
  function rememberSidForWorkspace(id) {
    try {
      var s = findSession(id);
      var cwd = (s && s.metadata && s.metadata.cwd) || ENV.cwd;
      var map = JSON.parse(localStorage.getItem('kimi2007.sidByWs') || '{}');
      map[cwd] = id;
      localStorage.setItem('kimi2007.sidByWs', JSON.stringify(map));
    } catch (e) { /* 恢复记忆失败不影响切换 */ }
  }

  function switchSession(id) {
    if (!id || state.sid === id) return Promise.resolve();
    if (!$('#panel').hidden) closePanel();
    var previousSid = state.sid;
    saveComposer(previousSid);
    clearLivePresentation();
    if (previousSid) {
      wsSend({ type: 'unsubscribe', id: nextWsId(), payload: { session_ids: [previousSid] } });
    }
    state.sid = id;
    localStorage.setItem('kimi2007.sid', id);
    rememberSidForWorkspace(id);
    closeMobileDrawers();
    state.rendered = {};
    chatBody.innerHTML = '';
    restoreComposer(id);
    renderActivityCenter();
    var s = findSession(id);
    setBusy(!!(s && s.busy));   /* 停止按钮跟随目标会话的运行状态 */
    applyTitle(s && s.title);
    renderSessionList();
    var done = hydrateSession(id, { replaceMessages: true }).catch(function (e) {
      queueSessionNotice(id, '恢复会话状态失败: ' + e.message);
      return refreshMessages();
    }).then(function () {
      if (state.sid !== id) return;
      subscribe(id);
      if (!Object.keys(state.rendered).length) showChatEmpty();
      flushSessionNotices(id);
    });
    input.focus();
    return done;
  }

  function setNavNewDisabled(disabled) {
    var el = document.getElementById('navNew');
    if (!el) return;
    if ('disabled' in el) el.disabled = disabled;
    if (disabled) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  }

  function newSession() {
    if (state.creatingSession) return Promise.resolve(null);
    state.creatingSession = true;
    setNavNewDisabled(true);
    return createSession().then(function (s) {
      return loadSessions().then(function () {
        return switchSession(s.id).then(function () {
          appendSys('新会话已创建,有什么可以帮你?');
          return s;
        });
      });
    }).catch(function (e) {
      queueSessionNotice(state.sid, '新建会话失败: ' + e.message);
      return null;
    }).finally(function () {
      state.creatingSession = false;
      setNavNewDisabled(false);
    });
  }

  function deleteTemporaryFile(sid, fileId, attempt) {
    if (!fileId) return Promise.resolve();
    attempt = attempt || 0;
    return api('/files/' + encodeURIComponent(fileId), { method: 'DELETE' }).catch(function (error) {
      if (attempt < 1) {
        return new Promise(function (resolve) { setTimeout(resolve, 400); })
          .then(function () { return deleteTemporaryFile(sid, fileId, attempt + 1); });
      }
      queueSessionNotice(sid, '清理附件失败: ' + error.message);
      return null;
    });
  }

  function trackDetachedUpload(ui, file) {
    if (!ui || !file || !file.uploadPromise || ui.detachedUploads.indexOf(file) >= 0) return;
    ui.detachedUploads.push(file);
    file.uploadPromise.finally(function () {
      ui.detachedUploads = ui.detachedUploads.filter(function (item) { return item !== file; });
    });
  }

  function discardPendingFiles(sid) {
    var ui = uiFor(sid);
    if (!ui) return Promise.resolve();
    var files = ui.pendingFiles.slice();
    var detached = ui.detachedUploads.slice();
    if (!files.length && !detached.length) return Promise.resolve();
    ui.pendingFiles = [];
    ui.uploading = 0;
    files.forEach(function (file) {
      file.discarded = true;
      file.countedAsUploading = false;
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    });
    if (sid === state.sid) {
      renderAttachRow();
      updateComposerState();
    }
    return Promise.all(files.concat(detached).filter(function (file, index, all) {
      return all.indexOf(file) === index;
    }).map(function (file) {
      if (file.id) return deleteTemporaryFile(sid, file.id);
      /* 不丢弃即将返回的上传响应；拿到 file id 后由 uploadPromise 立即清理。 */
      return file.uploadPromise || Promise.resolve();
    }));
  }

  function archiveSession(id) {
    var ui = uiFor(id);
    var archiveCommitted = false;
    if (ui) ui.archived = true;
    stopWaitLoop(id);
    return discardPendingFiles(id)
      .then(function () { return api('/sessions/' + encodeURIComponent(id) + ':archive', { method: 'POST', body: '{}' }); })
      .then(function () {
        archiveCommitted = true;
        return loadSessions();
      })
      .then(function () {
        persistDraft(id, '');
        if (id === state.sid) {
          var next = state.sessions[0];
          if (next) return switchSession(next.id);
          return newSession();
        }
        return null;
      }).catch(function (error) {
        if (ui && !archiveCommitted) {
          ui.archived = false;
          if (hasUnsettledPrompt(ui)) startWaitLoop(id, true);
        }
        throw error;
      });
  }

  function confirmArchiveSession(id) {
    var session = findSession(id) || {};
    var sessionUi = uiFor(id);
    var title = session.title || '新会话';
    var body = openPanel('归档会话');
    var gen = panelGen;
    if (sessionUi && sessionUi.submitting) {
      body.innerHTML = '<p class="p-note">“' + esc(title) + '”仍在确认刚才的发送结果。为避免丢失任务状态，请等待确认完成，或先停止当前回答。</p>' +
        '<div class="p-actions"><button class="ap-btn" id="archiveWait" type="button">返回会话</button></div>';
      body.querySelector('#archiveWait').addEventListener('click', closePanel);
      return;
    }
    var runningNote = session.busy ? '<br><strong>该会话的任务仍在运行，归档不会停止 Kimi 服务中的任务。</strong>' : '';
    body.innerHTML = '<p class="p-note">“' + esc(title) + '”将从当前列表隐藏，但不会删除历史消息。' + runningNote + '</p>' +
      '<div class="p-actions"><button class="ap-btn" id="archiveCancel" type="button">取消</button>' +
      '<button class="ap-btn no" id="archiveConfirm" type="button">' + (session.busy ? '仍然归档' : '归档会话') + '</button></div>';
    /* 无标签会话按标题关键词给出建议标签；点击即写入，不阻塞归档。 */
    var suggested = sessionTagsOf(id).length ? null : suggestTagFor(title);
    if (suggested) {
      var hint = document.createElement('div');
      hint.className = 'p-note archive-tag-hint';
      hint.appendChild(document.createTextNode('归档前建议标记：'));
      var hintChip = document.createElement('button');
      hintChip.type = 'button';
      hintChip.className = 'tag-chip';
      hintChip.textContent = '🏷 ' + suggested;
      hintChip.title = '为会话标记「' + suggested + '」后再归档';
      hintChip.addEventListener('click', function () {
        setSessionTags(id, [suggested]);
        hintChip.disabled = true;
        hintChip.classList.add('on');
        hint.insertAdjacentHTML('beforeend', '<span class="p-dim"> 已标记</span>');
      });
      hint.appendChild(hintChip);
      body.insertBefore(hint, body.querySelector('.p-actions'));
    }
    var cancel = body.querySelector('#archiveCancel');
    var confirm = body.querySelector('#archiveConfirm');
    cancel.addEventListener('click', closePanel);
    confirm.addEventListener('click', function () {
      cancel.disabled = confirm.disabled = true;
      confirm.textContent = '归档中…';
      archiveSession(id).then(function () {
        if (panelIsCurrent(body, gen)) closePanel();
      }).catch(function (err) {
        if (!panelIsCurrent(body, gen)) return;
        cancel.disabled = confirm.disabled = false;
        confirm.textContent = session.busy ? '仍然归档' : '归档会话';
        body.insertAdjacentHTML('beforeend', '<div class="p-error">归档失败: ' + esc(err.message) + '</div>');
      });
    });
  }

  function findSession(id) {
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === id) return state.sessions[i];
    }
    return null;
  }

  function applyTitle(t) {
    var name = t || '新会话';
    chatTitle.textContent = name;
    titleText.textContent = 'Kimi 2007 - ' + name;
    document.title = 'Kimi 2007 - ' + name;
    syncChatWs();
  }
