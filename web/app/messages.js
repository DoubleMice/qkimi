  /* ================= 消息渲染 ================= */

  function appendMsg(who, htmlOrText, isHtml, timeStr, beforeEl) {
    var stick = nearBottom();
    removeChatEmpty();
    var msg = document.createElement('div');
    msg.className = 'msg ' + who;

    var head = document.createElement('div');
    head.className = 'msg-head';
    var name = document.createElement('span');
    name.className = 'name ' + (who === 'user' ? 'me' : 'bot');
    name.textContent = who === 'user' ? 'Kimi 用户' : 'Kimi 小月';
    var time = document.createElement('span');
    time.className = 'time';
    time.textContent = timeStr || nowTime();
    head.appendChild(name);
    head.appendChild(time);

    var body = document.createElement('div');
    body.className = 'msg-body';
    if (isHtml) body.innerHTML = htmlOrText;
    else body.textContent = htmlOrText;

    msg.appendChild(head);
    msg.appendChild(body);
    if (beforeEl && beforeEl.parentNode === chatBody) chatBody.insertBefore(msg, beforeEl);
    else chatBody.appendChild(msg);
    followScroll(stick);
    return msg;
  }

  /* 时间线的“活动尾部”：未确认的本地回声、typing、流式/思考气泡、工具活动行。
     合并渲染（非整体重建）时新到的服务端消息必须插到它们之前，
     否则回合边界处会把上一条回复追加到排队消息之后，造成顺序错乱。 */
  function liveTailEl() {
    var tails = [state.thinkEl, state.typingEl, state.streamEl, state.activityEl];
    var ui = currentUi();
    if (ui) ui.pendingOutgoing.forEach(function (r) { if (r.el) tails.push(r.el); });
    var node = chatBody.firstChild;
    while (node) {
      if (tails.indexOf(node) >= 0) return node;
      node = node.nextSibling;
    }
    return null;
  }

  function appendSys(text) {
    var stick = nearBottom();
    removeChatEmpty();
    var d = document.createElement('div');
    d.className = 'msg-sys';
    d.textContent = text;
    chatBody.appendChild(d);
    followScroll(stick);
    return d;
  }

  /* 空会话的居中空态；首条消息（含系统消息）出现时自动移除。 */
  function removeChatEmpty() {
    var empty = chatBody.querySelector('.chat-empty');
    if (empty) empty.remove();
  }

  function showChatEmpty() {
    if (chatBody.querySelector('.chat-empty')) return;
    var d = document.createElement('div');
    d.className = 'chat-empty';
    d.innerHTML = '<div class="ce-logo">🌙</div>' +
      '<div class="ce-title">Kimi 小月 已上线，开始聊天吧~</div>' +
      '<div class="ce-tip">输入消息开始对话 · 按 ? 查看快捷键</div>';
    chatBody.appendChild(d);
  }

  function dismissToast(toast) {
    if (!toast || !toast.isConnected || toast.classList.contains('leaving')) return;
    toast.classList.add('leaving');
    setTimeout(function () { if (toast.isConnected) toast.remove(); }, 190);
  }

  /*
   * 轻量可撤销反馈：收藏这类本地操作无需再打断用户开确认框，同时仍给误点留出
   * 明确的恢复路径。既有两参调用保持不变。
   */
  function notifyUi(text, kind, action) {
    var region = $('#toastRegion');
    if (!region) return appendSys(text);
    var toast = document.createElement('div');
    toast.className = 'ui-toast' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
    var label = document.createElement('span');
    label.className = 'ui-toast-text';
    label.textContent = text;
    toast.appendChild(label);
    var timer = null;
    if (action && typeof action.run === 'function') {
      var actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'ui-toast-action';
      actionBtn.textContent = action.label || '查看';
      actionBtn.setAttribute('aria-label', action.ariaLabel || actionBtn.textContent);
      actionBtn.addEventListener('click', function () {
        if (timer) clearTimeout(timer);
        dismissToast(toast);
        action.run();
      });
      toast.appendChild(actionBtn);
    }
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'ui-toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '✕';
    toast.appendChild(close);
    region.appendChild(toast);
    while (region.childNodes.length > 3) region.removeChild(region.firstChild);
    timer = setTimeout(function () { dismissToast(toast); }, kind === 'error' ? 6000 : 4200);
    close.addEventListener('click', function () {
      clearTimeout(timer);
      dismissToast(toast);
    });
    return toast;
  }

  function announceReply(text) {
    var announcer = $('#replyAnnouncer');
    if (!announcer) return;
    announcer.textContent = '';
    requestAnimationFrame(function () { announcer.textContent = text; });
  }

  $('#jumpLatest').addEventListener('click', function () {
    scrollBottom();
    chatBody.focus({ preventScroll: true });
  });
  chatBody.addEventListener('scroll', function () {
    if (nearBottom()) $('#jumpLatest').hidden = true;
  });

  /* 发送后先把用户消息放入时间线。服务端确认的同一条 user 消息到达时会接管它，
     避免“正在输入”的 Kimi 信息抢在用户内容之前出现。 */
  function buildOutgoingHtml(text, files) {
    var html = esc(String(text || '')).replace(/\n/g, '<br>');
    var attachments = (files || []).map(function (file) {
      var image = file.media_type && file.media_type.indexOf('image/') === 0;
      return '<span class="att-chip">' + (image ? '📷' : '📎') + ' [' + esc(file.name || '文件') + ']</span>';
    });
    if (attachments.length) html += (html ? '<br>' : '') + attachments.join(' ');
    return html || '[非文本消息]';
  }

  function appendPendingOutgoing(sid, text, files) {
    var ui = uiFor(sid);
    if (!ui) return null;
    var record = {
      text: String(text || '').trim(),
      sentAt: Date.now(),
      knownMessageIds: Object.assign({}, state.rendered),
      el: null,
    };
    if (sid === state.sid) {
      var el = appendMsg('user', buildOutgoingHtml(text, files), true);
      el.classList.add('pending-user');
      var stateEl = document.createElement('span');
      stateEl.className = 'msg-send-state';
      stateEl.textContent = '发送中…';
      el.querySelector('.msg-head').appendChild(stateEl);
      record.el = el;
      /* 用户主动发送时必须立即看到自己的新消息，不受先前滚动位置影响。 */
      scrollBottom();
    }
    ui.pendingOutgoing.push(record);
    return record;
  }

  function takePendingOutgoing(sid, message) {
    var ui = uiFor(sid);
    if (!ui || !ui.pendingOutgoing.length) return null;
    var serverText = (message.content || []).filter(function (part) {
      return part.type === 'text' && part.text;
    }).map(function (part) { return String(part.text).trim(); }).join('\n');
    var index = -1;
    ui.pendingOutgoing.some(function (record, i) {
      if (message.id && record.knownMessageIds && record.knownMessageIds[message.id]) return false;
      if (record.text && record.text === serverText) {
        index = i;
        return true;
      }
      return false;
    });
    if (index < 0 && !serverText) {
      ui.pendingOutgoing.some(function (record, i) {
        if (message.id && record.knownMessageIds && record.knownMessageIds[message.id]) return false;
        if (!record.text) {
          index = i;
          return true;
        }
        return false;
      });
    }
    /* 服务端不回显附件文本时，单条未确认发送仍可安全接管。 */
    if (index < 0 && ui.pendingOutgoing.length === 1 &&
        Date.now() - ui.pendingOutgoing[0].sentAt < 120000 &&
        !(message.id && ui.pendingOutgoing[0].knownMessageIds && ui.pendingOutgoing[0].knownMessageIds[message.id])) index = 0;
    return index < 0 ? null : ui.pendingOutgoing.splice(index, 1)[0];
  }

  function settlePendingOutgoing(record, built, beforeEl) {
    if (record && record.el && record.el.isConnected) {
      var el = record.el;
      el.classList.remove('pending-user');
      var sendState = el.querySelector('.msg-send-state');
      if (sendState) sendState.remove();
      el.querySelector('.msg-body').innerHTML = built.html;
      el.querySelector('.time').textContent = built.time;
      return el;
    }
    return appendMsg(built.who, built.html, true, built.time, beforeEl);
  }

  function discardPendingOutgoing(sid, record) {
    if (!record) return;
    var ui = uiFor(sid);
    if (ui) {
      var index = ui.pendingOutgoing.indexOf(record);
      if (index >= 0) ui.pendingOutgoing.splice(index, 1);
      else return; /* 已由服务端消息接管，不能再删掉已确认内容。 */
    }
    if (record.el && record.el.isConnected) record.el.remove();
  }

  /* 服务端消息 -> {who, html, time};内容会随流式追加而变,返回 html 供比对更新 */
  function buildMsgHtml(m) {
    var texts = [];
    var tools = [];
    var thinks = [];
    (m.content || []).forEach(function (c) {
      if (c.type === 'text' && c.text) texts.push(c.text);
      if (c.type === 'tool_use') tools.push(c.tool_name || c.name || 'tool');
      if (c.type === 'thinking' && c.thinking) thinks.push(c.thinking);
    });
    var t = hmOf(m.created_at);
    if (m.role === 'user') {
      var atts = [];
      (m.content || []).forEach(function (c) {
        if (c.type === 'image') atts.push('<span class="att-chip">📷 [图片]</span>');
        if (c.type === 'file') atts.push('<span class="att-chip">📎 [' + esc(c.name || '文件') + ']</span>');
      });
      var body = esc(texts.join('\n')).replace(/\n/g, '<br>');
      if (atts.length) body += (body ? '<br>' : '') + atts.join(' ');
      return { who: 'user', time: t, html: body || '[非文本消息]', role: 'user', text: texts.join('\n') };
    }
    if (m.role === 'assistant') {
      var html = '';
      if (thinks.length) {
        html += '<details class="think"><summary>💭 思考过程</summary><div class="think-body">' +
          esc(thinks.join('\n\n')) + '</div></details>';
      }
      html += texts.map(renderMd).join('');
      if (tools.length) {
        html += '<div class="tool-note">🔧 调用工具: ' + esc(tools.join('、')) + '</div>';
      }
      return { who: 'bot', time: t, html: html, role: 'assistant', text: texts.join('\n\n') };
    }
    return null;
  }

  var refreshGen = 0;
  function applyMessageItems(rawItems, newestFirst) {
    var items = (rawItems || []).slice();
    if (newestFirst) items.reverse();
    var lastUserText = '';
    /* 新消息元素要落在服务端时序对应的位置：优先插到列表中更靠后的已渲染消息之前，
       否则回合边界处会把上一条回复追加到排队消息之后；都没有则退到活动尾部之前。 */
    var tailEl = liveTailEl();
    function anchorFor(index) {
      for (var j = index + 1; j < items.length; j++) {
        var later = state.rendered[items[j] && items[j].id];
        if (later && later.el && later.el.isConnected) return later.el;
      }
      return tailEl;
    }
    items.forEach(function (m, index) {
      var built = buildMsgHtml(m);
      if (built && built.role === 'user' && built.text) lastUserText = built.text;
      var r = state.rendered[m.id];
      if (!r) {
        r = state.rendered[m.id] = { el: null, html: '' };
        if (built && built.html) {
          var pending = built.who === 'user' ? takePendingOutgoing(state.sid, m) : null;
          r.el = pending ? settlePendingOutgoing(pending, built, anchorFor(index)) :
            appendMsg(built.who, built.html, true, built.time, anchorFor(index));
          r.html = built.html;
        }
      } else if (built && built.html && built.html !== r.html) {
        var stick = nearBottom();
        if (r.el) r.el.querySelector('.msg-body').innerHTML = built.html;
        else r.el = appendMsg(built.who, built.html, true, built.time, anchorFor(index));
        r.html = built.html;
        followScroll(stick);
      }
      if (built && r) {
        r.role = built.role;
        if (built.text) r.text = built.text;
        if (built.role === 'assistant' && lastUserText && !r.promptText) r.promptText = lastUserText;
        if (built.role === 'user' && built.text) r.promptText = built.text;
        if (r.el) attachMsgActions(r.el, m.id);
      }
    });
  }

  function refreshMessages() {
    if (!state.sid) return Promise.resolve();
    var sid = state.sid;
    var gen = ++refreshGen;
    return api('/sessions/' + encodeURIComponent(sid) + '/messages').then(function (data) {
      /* 竞态防护:切换过会话或已有更新的刷新,丢弃过期结果 */
      if (sid !== state.sid || gen !== refreshGen) return;
      applyMessageItems(data.items, true); /* messages 接口是最新在前 */
      syncModelButton();
    }).catch(function (e) {
      console.warn('refreshMessages failed', e);
    });
  }
