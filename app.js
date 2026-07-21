/* Kimi 2007 —— 复古 QQ 皮肤 + kimi server 真实后端 (v2 可用终端)
 *
 * 连接方式:
 *   REST  http://127.0.0.1:58627/api/v1/...   (Authorization: Bearer <token>)
 *   WS    ws://127.0.0.1:58627/api/v1/ws?client_id=...
 *         子协议: kimi-code.bearer.<token>
 * 浏览器模式从 /env.json 获取令牌；桌面模式通过原生 WebKit 桥接获取。
 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(s));
  };

  var win = $('#window');
  var titleText = $('#titleText');
  var chatTitle = $('#chatTitle');
  var chatBody = $('#chatBody');
  var input = $('#input');
  var connStatus = $('#connStatus');
  var sessList = $('#sessList');
  var desktopApi = window.KimiDesktop || null;

  var ENV = window.KIMI_ENV || { base: 'http://127.0.0.1:58627', token: '', model: 'kimi-code/k3', cwd: '' };
  var savedModel = localStorage.getItem('kimi2007.model') || ENV.model;
  /* 兼容 v3 存下的 managed: 前缀；新模型选择不再作为跨会话全局状态。 */
  savedModel = String(savedModel || '').replace(/^managed:/, '');

  var FONT_SIZES = [12, 13.5, 15];
  var savedFontSize = parseFloat(localStorage.getItem('kimi2007.font'));
  if (FONT_SIZES.indexOf(savedFontSize) === -1) savedFontSize = 12;

  var DRAFTS_KEY = 'kimi2007.drafts.v1';
  function readStoredDrafts() {
    try {
      var stored = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
      return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    } catch (e) {
      return {};
    }
  }

  var state = {
    sid: null,
    sessions: [],
    model: savedModel,          // 仅作为尚未取得会话 profile 时的回退默认值
    models: [],                 // /models 的单一数据源
    modelsPromise: null,
    ws: null,
    wsOpen: false,
    wsGeneration: 0,
    rendered: {},          // server message id -> {el, html}
    typingEl: null,
    streamEl: null,        // 正在流式输出的 bot 消息元素
    streamText: '',
    streamRenderTimer: null, // 流式 Markdown 增量渲染的节流定时器
    thinkEl: null,         // 正在流式输出的思考块
    thinkText: '',
    activityEl: null,      // 工具活动行
    busy: false,
    lastSeq: {},           // sid -> 已见事件序号(断点续订)
    epochs: {},            // sid -> snapshot epoch，供 WS 游标失效检测
    reconnectTimer: null,
    reconnectAttempts: 0,
    envRefreshPromise: null,
    hydrateGen: {},        // sid -> 最近一次 snapshot 恢复代数
    sessionLoadGen: 0,
    workspaceUpdateGen: 0,
    sessionStatus: {},     // sid -> /status 权威状态
    permissionUpdateGen: {}, // sid -> 最近一次权限模式更新代数，避免旧请求覆盖新选择
    sessionPermission: {}, // sid -> 客户端已写入的权限（下一轮生效值）；优先于忙碌时落后的 /status.permission
    creatingSession: false,
    bell: localStorage.getItem('kimi2007.bell') !== 'off',
    flashTimer: null,
    cwdFilter: undefined,
    sessionUi: {},         // sid -> 草稿/附件/等待/审批/问题等会话级 UI 状态
    uploadSeq: 0,
    sendMode: localStorage.getItem('kimi2007.sendmode') === 'ctrl' ? 'ctrl' : 'enter',
    fontSize: savedFontSize,
    reminders: [],
    drafts: readStoredDrafts(),
    activitySeq: 0,
    layoutLock: localStorage.getItem('kimi2007.layout') || 'auto', /* auto|full|compact */
  };
  window.__kimi2007 = state; /* 调试钩子 */

  function uiFor(sid) {
    if (!sid) return null;
    if (!state.sessionUi[sid]) {
      state.sessionUi[sid] = {
        draft: state.drafts[sid] || '',
        pendingFiles: [],
        uploading: 0,
        submitting: false,
        aborting: false,
        waiting: false,
        waitTimer: null,
        waitGeneration: 0,
        waitAttempts: 0,
        waitEscalated: false,
        approvals: {},
        questions: {},
        notices: [],
        liveActivities: {},
        liveActivityOrder: [],
        lastLiveActivityId: null,
        tasks: [],
        children: [],
        terminals: [],
        activityLoading: false,
        activityLoaded: false,
        activityRefreshGen: 0,
        activityRefreshTimer: null,
        activityError: '',
        pendingOutgoing: [],
        submittedPrompts: [],
        abortTarget: null,
        abortAccepted: false,
        restoreQueueOnIdle: false,
        operationGeneration: 0,
        detachedUploads: [],
        archived: false,
        permissionUpdating: '',
      };
    }
    return state.sessionUi[sid];
  }

  function currentUi() { return uiFor(state.sid); }

  /* ================= 小工具 ================= */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function tick() {
    var d = new Date();
    var t = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var c = $('#clock');
    if (c) c.textContent = t;
  }
  tick();
  setInterval(tick, 10000);

  function nowTime() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function hmOf(iso) {
    if (!iso) return nowTime();
    var d = new Date(iso);
    if (isNaN(d)) return nowTime();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setConn(ok, text) {
    if (connStatus) {
      connStatus.textContent = (ok ? '🟢 ' : '🔴 ') + text;
      connStatus.setAttribute('aria-label', '连接状态：' + text + '，点击重新连接');
    }
  }

  function fmtTok(n) {
    if (!n) return '0';
    return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
  }

  /* ================= markdown 渲染(markdown-it) ================= */

  var md = window.markdownit({ html: false, linkify: true, breaks: true });
  var mdDefaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    var token = tokens[idx];
    var lang = (token.info || '').trim().split(/\s+/)[0] || 'code';
    var inner = mdDefaultFence(tokens, idx, options, env, self);
    var codeMatch = inner.match(/<code[^>]*>([\s\S]*)<\/code>/);
    var code = codeMatch ? codeMatch[1] : esc(token.content.replace(/\n$/, ''));
    return '<div class="codeblock"><div class="cb-head"><span>' + esc(lang) +
      '</span><button class="cb-copy" type="button" title="复制代码" aria-label="复制代码">📋</button></div><pre>' +
      code + '</pre></div>';
  };
  var mdDefaultLinkOpen = md.renderer.rules.link_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noreferrer');
    return mdDefaultLinkOpen(tokens, idx, options, env, self);
  };

  /* 转义代码块/行内代码之外形如 <tag ...> 的类标签文本，避免被 CommonMark
     当作 HTML 块或行内 HTML 解析（进而引发列表懒惰续行等错乱）；代码内容原样保留，
     交给 markdown-it 自身的转义逻辑处理。 */
  function escStrayTags(text) {
    var re = /```[^\n]*\n[\s\S]*?\n```(?=\n|$)|`[^`\n]+`|``[^`]+``/g;
    var out = '', last = 0, m;
    var escTag = function (s) {
      return s.replace(/<(\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?)>/g, '&lt;$1&gt;');
    };
    while ((m = re.exec(text))) {
      out += escTag(text.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + escTag(text.slice(last));
  }

  function renderMd(text) {
    return md.render(escStrayTags(String(text == null ? '' : text)));
  }

  /* 代码块复制(事件委托) */
  chatBody.addEventListener('click', function (e) {
    var btn = e.target.closest('.cb-copy');
    if (!btn) return;
    var pre = btn.closest('.codeblock').querySelector('pre');
    var feedback = function (text) {
      btn.textContent = text;
      setTimeout(function () { btn.textContent = '📋'; }, 1200);
    };
    writeClipboard(pre.textContent).then(
      function () { feedback('✅'); },
      function () {
        feedback('⚠');
        notifyUi('复制代码失败', 'error');
      }
    );
  });

  /* 智能滚动:只在贴近底部时跟随。先写 scrollTop，下一帧再校正
     图片、Markdown 等造成的异步高度变化，避免流式回答跟随半途停住。 */
  function nearBottom() {
    return chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 90;
  }
  function scrollBottom() {
    chatBody.scrollTop = chatBody.scrollHeight;
    var jump = $('#jumpLatest');
    if (jump) jump.hidden = true;
    requestAnimationFrame(function () { chatBody.scrollTop = chatBody.scrollHeight; });
  }

  function showJumpLatest() {
    var jump = $('#jumpLatest');
    if (jump) jump.hidden = false;
  }

  /* 追加内容后的统一跟随策略：原本贴近底部则跟随到底，否则显示“查看新消息”。 */
  function followScroll(stick) {
    if (stick) scrollBottom();
    else showJumpLatest();
  }

  /* ================= 消息渲染 ================= */

  function appendMsg(who, htmlOrText, isHtml, timeStr) {
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
    chatBody.appendChild(msg);
    followScroll(stick);
    return msg;
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

  function notifyUi(text, kind) {
    var region = $('#toastRegion');
    if (!region) return appendSys(text);
    var toast = document.createElement('div');
    toast.className = 'ui-toast' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
    var label = document.createElement('span');
    label.className = 'ui-toast-text';
    label.textContent = text;
    toast.appendChild(label);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'ui-toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '✕';
    toast.appendChild(close);
    region.appendChild(toast);
    while (region.childNodes.length > 3) region.removeChild(region.firstChild);
    var timer = setTimeout(function () { dismissToast(toast); }, kind === 'error' ? 6000 : 3200);
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

  function settlePendingOutgoing(record, built) {
    if (record && record.el && record.el.isConnected) {
      var el = record.el;
      el.classList.remove('pending-user');
      var sendState = el.querySelector('.msg-send-state');
      if (sendState) sendState.remove();
      el.querySelector('.msg-body').innerHTML = built.html;
      el.querySelector('.time').textContent = built.time;
      return el;
    }
    return appendMsg(built.who, built.html, true, built.time);
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
    items.forEach(function (m) {
      var built = buildMsgHtml(m);
      if (built && built.role === 'user' && built.text) lastUserText = built.text;
      var r = state.rendered[m.id];
      if (!r) {
        r = state.rendered[m.id] = { el: null, html: '' };
        if (built && built.html) {
          var pending = built.who === 'user' ? takePendingOutgoing(state.sid, m) : null;
          r.el = pending ? settlePendingOutgoing(pending, built) :
            appendMsg(built.who, built.html, true, built.time);
          r.html = built.html;
        }
      } else if (built && built.html && built.html !== r.html) {
        var stick = nearBottom();
        if (r.el) r.el.querySelector('.msg-body').innerHTML = built.html;
        else r.el = appendMsg(built.who, built.html, true, built.time);
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

  /* ================= 消息操作:复制 / 重新生成 / 新会话继续 ================= */

  /* 写剪贴板：clipboard API 优先，execCommand 兜底，统一返回 Promise 成败。 */
  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var temp = document.createElement('textarea');
      temp.value = text;
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.appendChild(temp);
      temp.select();
      try {
        if (document.execCommand('copy')) resolve();
        else reject(new Error('execCommand copy 返回失败'));
      } catch (e) { reject(e); }
      temp.remove();
    });
  }

  function copyText(text, okMsg) {
    writeClipboard(text).then(
      function () { notifyUi(okMsg || '已复制', 'ok'); },
      function () { notifyUi('复制失败', 'error'); }
    );
  }

  /* 每条消息右上角的操作条。assistant 消息额外提供重新生成和新会话继续。 */
  function attachMsgActions(el, mid) {
    if (!el || el.querySelector('.msg-actions')) return;
    var r = state.rendered[mid];
    if (!r || !r.text) return;
    var bar = document.createElement('div');
    bar.className = 'msg-actions';
    function action(label, title, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg-act';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
      bar.appendChild(b);
    }
    action('📋 复制', '复制此消息内容', function () {
      var cur = state.rendered[mid];
      copyText((cur && cur.text) || '', '已复制消息内容');
    });
    if (r.role === 'assistant') {
      action('↻ 重新生成', '用原始问题重新提问', function () { regenerateMessage(mid); });
      action('⧉ 新会话继续', '带着原始问题去新会话继续', function () { continueInNewSession(mid); });
    }
    el.appendChild(bar);
  }

  function regenerateMessage(mid) {
    var r = state.rendered[mid];
    var prompt = r && r.promptText;
    if (!prompt) {
      notifyUi('找不到这条回答对应的原始问题', 'error');
      return;
    }
    if (state.busy) {
      notifyUi('当前回答仍在进行，请先停止再重新生成', 'error');
      return;
    }
    input.value = prompt;
    input.dispatchEvent(new Event('input'));
    focusChat();
    send();
  }

  function continueInNewSession(mid) {
    var r = state.rendered[mid];
    var prompt = (r && r.promptText) || '';
    var answer = (r && r.text) || '';
    newSession().then(function (s) {
      if (!s) return;
      var seed = prompt || (answer ? '上一个回答：\n' + answer : '');
      if (seed) {
        input.value = seed;
        input.dispatchEvent(new Event('input'));
      }
      focusChat();
      notifyUi('已在新会话中预填内容，可修改后发送');
    });
  }

  /* ================= 会话导出 Markdown ================= */

  function downloadText(text, filename) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    notifyUi('已开始下载 ' + filename);
  }

  function showExportPanel(md, filename) {
    var body = openPanel('📤 导出会话 Markdown');
    body.innerHTML = '<div class="p-note">可以复制全部内容，或下载为 .md 文件。</div>' +
      '<textarea class="export-md" readonly aria-label="会话 Markdown 内容"></textarea>' +
      '<div class="p-actions">' +
      '<button class="ap-btn yes" id="expCopy" type="button">📋 复制全部</button>' +
      '<button class="ap-btn" id="expDownload" type="button">⬇ 下载 .md</button></div>';
    var ta = body.querySelector('.export-md');
    ta.value = md;
    body.querySelector('#expCopy').addEventListener('click', function () {
      ta.focus();
      ta.select();
      copyText(md, '已复制会话 Markdown');
    });
    body.querySelector('#expDownload').addEventListener('click', function () {
      downloadText(md, filename);
    });
  }

  function exportSessionMarkdown() {
    if (!state.sid) {
      notifyUi('请先打开一个会话', 'error');
      return;
    }
    var sid = state.sid;
    notifyUi('正在导出会话…');
    api('/sessions/' + encodeURIComponent(sid) + '/messages').then(function (data) {
      if (sid !== state.sid) return;
      var items = (data.items || []).slice().reverse();
      var title = (chatTitle.textContent || '会话').trim() || '会话';
      var lines = ['# ' + title, '', '> 导出自 Kimi 2007 · ' + new Date().toLocaleString(), ''];
      var count = 0;
      items.forEach(function (m) {
        var role = m.role === 'user' ? 'Kimi 用户' : m.role === 'assistant' ? 'Kimi 小月' : null;
        if (!role) return;
        var texts = [];
        var atts = [];
        (m.content || []).forEach(function (c) {
          if (c.type === 'text' && c.text) texts.push(c.text);
          if (c.type === 'image') atts.push('[图片]');
          if (c.type === 'file') atts.push('[' + (c.name || '文件') + ']');
        });
        var bodyText = texts.join('\n\n');
        if (!bodyText && atts.length) bodyText = atts.join(' ');
        if (!bodyText) return;
        count++;
        lines.push('## ' + role + ' · ' + hmOf(m.created_at), '', bodyText, '');
      });
      if (!count) {
        notifyUi('当前会话还没有可导出的内容', 'error');
        return;
      }
      showExportPanel(lines.join('\n'), 'kimi-session-' + String(sid).slice(0, 8) + '.md');
    }).catch(function (e) {
      notifyUi('导出失败：' + e.message, 'error');
    });
  }

  /* ================= REST ================= */

  function refreshRuntimeEnv() {
    if (state.envRefreshPromise) return state.envRefreshPromise;
    var runtimeRequest = desktopApi && desktopApi.getRuntimeEnv ?
      desktopApi.getRuntimeEnv() :
      fetch('/env.json', { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('无法刷新连接令牌');
        return res.json();
      });
    state.envRefreshPromise = Promise.resolve(runtimeRequest)
      .then(function (next) {
        if (!next || !next.token || !next.base) throw new Error('连接配置无效');
        ENV.base = next.base;
        ENV.token = next.token;
        if (next.model) ENV.model = next.model;
        if (next.cwd) ENV.cwd = next.cwd;
        return ENV;
      })
      .finally(function () { state.envRefreshPromise = null; });
    return state.envRefreshPromise;
  }

  function api(pathname, opts, retried) {
    opts = opts || {};
    var requestOpts = Object.assign({}, opts);
    var timeoutMs = requestOpts.timeoutMs == null ? 20000 : Math.max(1000, Number(requestOpts.timeoutMs) || 20000);
    delete requestOpts.timeoutMs;
    var timeoutController = null;
    var timeoutTimer = null;
    var timedOut = false;
    var callerSignal = requestOpts.signal || null;
    var callerAbortHandler = null;
    if (typeof AbortController !== 'undefined') {
      timeoutController = new AbortController();
      requestOpts.signal = timeoutController.signal;
      if (callerSignal) {
        callerAbortHandler = function () { timeoutController.abort(); };
        if (callerSignal.aborted) callerAbortHandler();
        else callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
      }
      timeoutTimer = setTimeout(function () {
        timedOut = true;
        timeoutController.abort();
      }, timeoutMs);
    }
    var baseHeaders = { Authorization: 'Bearer ' + ENV.token };
    if (opts.body != null && !(typeof FormData !== 'undefined' && opts.body instanceof FormData)) {
      baseHeaders['Content-Type'] = 'application/json';
    }
    requestOpts.headers = Object.assign(baseHeaders, opts.headers || {});
    return fetch(ENV.base + '/api/v1' + pathname, requestOpts).then(function (res) {
      if (res.status === 401 && !retried) {
        return refreshRuntimeEnv().then(function () { return api(pathname, opts, true); });
      }
      return res.json().then(function (j) {
        if (!res.ok || j.code !== 0) {
          var err = new Error(j.msg || ('HTTP ' + res.status));
          err.code = j.code;
          err.status = res.status;
          throw err;
        }
        return j.data;
      });
    }).catch(function (error) {
      if (timedOut) throw new Error('请求超时，请检查 Kimi 服务状态后重试');
      throw error;
    }).finally(function () {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (callerSignal && callerAbortHandler) callerSignal.removeEventListener('abort', callerAbortHandler);
    });
  }

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
    var bar = $('#ctxInfo');
    if (bar) bar.textContent = '📊 ' + context;
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
      renderSessionList();
      return items;
    });
  }

  function renderSessionList() {
    if (!sessList) return;
    var q = ($('#sessSearch') && $('#sessSearch').value || '').trim().toLowerCase();
    sessList.innerHTML = '';
    state.sessions.forEach(function (s) {
      var title = s.title || '新会话';
      if (q && title.toLowerCase().indexOf(q) === -1) return;
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
      open.innerHTML =
        '<span class="sess-ico">💬</span>' +
        '<span class="sess-name">' + esc(title) + '</span>' +
        (s.busy ? '<span class="sess-busy" title="进行中">●</span>' : '') +
        (pendingCount ? '<span class="sess-pending" title="待处理 ' + pendingCount + ' 项">' + pendingCount + '</span>' : '') +
        '<span class="sess-time">' + hmOf(s.updated_at).slice(0, 5) + '</span>';
      open.addEventListener('click', function () { switchSession(s.id); });
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
      item.appendChild(del);
      sessList.appendChild(item);
    });
    if (!sessList.children.length) {
      var empty = document.createElement('div');
      empty.className = 'sess-empty';
      empty.textContent = q ? '没有匹配的会话' : '暂无会话，点击「＋ 新建」开始';
      sessList.appendChild(empty);
    }
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
  }

  function permissionModeLabel(mode) {
    var labels = { manual: '手动许可', auto: '自动许可', yolo: '全部允许' };
    return labels[mode] || mode || '未知';
  }

  function permissionModeFrom(value) {
    if (!value) return '';
    return value.permission || value.permission_mode ||
      (value.agent_config && value.agent_config.permission_mode) ||
      (value.agent_config && value.agent_config.permission) || '';
  }

  function currentPermissionMode(sid) {
    var ui = uiFor(sid);
    if (ui && ui.permissionUpdating) return ui.permissionUpdating;
    /* 客户端已成功写入的权限优先：忙碌时 /status.permission 会落后，不能据此显示旧值。 */
    if (state.sessionPermission[sid]) return state.sessionPermission[sid];
    var fromStatus = permissionModeFrom(state.sessionStatus[sid]);
    if (fromStatus) return fromStatus;
    var fromSession = permissionModeFrom(findSession(sid));
    if (fromSession) return fromSession;
    return 'manual';
  }

  function syncPermissionControl(sid) {
    if (sid !== state.sid) return;
    var button = $('#permissionInfo');
    if (!button) return;
    var label = permissionModeLabel(currentPermissionMode(sid));
    button.textContent = '🛡️ ' + label + ' ▾';
    button.title = '选择当前会话权限模式（当前：' + label + '）';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('data-mode', currentPermissionMode(sid));
  }

  function updatePermissionMode(sid, mode) {
    var ui = uiFor(sid);
    if (!ui) return Promise.reject(new Error('会话不存在'));
    var requestGen = (state.permissionUpdateGen[sid] || 0) + 1;
    state.permissionUpdateGen[sid] = requestGen;
    ui.permissionUpdating = mode;
    /* 先给出可见反馈；仅在 /profile 写入失败时回滚。 */
    if (sid === state.sid) syncPermissionControl(sid);
    return api('/sessions/' + encodeURIComponent(sid) + '/profile', {
      method: 'POST',
      body: JSON.stringify({ agent_config: { permission_mode: mode } }),
    }).then(function (profile) {
      if (state.permissionUpdateGen[sid] !== requestGen) return null;
      mergeSessionSnapshot(profile);
      /* /profile 写入成功即代表权限已持久化到会话（下一轮生效）。
         注意：profile 响应的 agent_config 不回显 permission_mode，且 /status.permission
         是运行时值——会话忙碌时它仍是进行中回合的旧权限，落后属正常，不能据此判定切换失败
         （否则运行中切换会误报“服务端未应用”并把界面回退成旧值）。因此以本次写入的 mode 为准，
         /status 仅用于刷新模型、token 等其它运行时字段。若 profile 明确回显了不同值则以回显为准。 */
      var profileMode = permissionModeFrom(profile);
      var resolved = (profileMode && profileMode !== mode) ? profileMode : mode;
      /* 记为客户端权威值，忙碌时的 /status 旧值不再回退它。 */
      state.sessionPermission[sid] = resolved;
      return api('/sessions/' + encodeURIComponent(sid) + '/status').catch(function () {
        return null;
      }).then(function (status) {
        if (state.permissionUpdateGen[sid] !== requestGen) return null;
        ui.permissionUpdating = '';
        applySessionStatus(sid, Object.assign({}, status || {}, { permission: resolved }));
        return resolved;
      });
    }).catch(function (error) {
      if (state.permissionUpdateGen[sid] === requestGen) {
        ui.permissionUpdating = '';
        if (sid === state.sid) syncPermissionControl(sid);
      }
      throw error;
    });
  }

  /* ================= WebSocket ================= */

  var wsIdCounter = 1;
  function nextWsId() { return wsIdCounter++; }

  function wsSend(obj) {
    if (state.ws && state.wsOpen) {
      try { state.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
    }
  }

  function subscribe(sid) {
    var cursors = {};
    cursors[sid] = { seq: state.lastSeq[sid] || 0 };
    if (state.epochs[sid]) cursors[sid].epoch = state.epochs[sid];
    wsSend({ type: 'subscribe', id: nextWsId(), payload: { session_ids: [sid], cursors: cursors } });
  }

  function connectWS(manual) {
    if (!state.sid) return;
    if (manual) {
      state.reconnectAttempts = 0;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
    }

    var ws;
    try {
      ws = new WebSocket(ENV.base.replace(/^http/, 'ws') + '/api/v1/ws?client_id=qq2007_' + Date.now(),
        ['kimi-code.bearer.' + ENV.token]);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    var previous = state.ws;
    var generation = ++state.wsGeneration;
    state.ws = ws;
    state.wsOpen = false;
    setConn(false, '连接中');
    try { if (previous && previous !== ws) previous.close(); } catch (e2) { /* ignore */ }

    ws.onopen = function () {
      if (state.ws !== ws || state.wsGeneration !== generation) return;
      state.wsOpen = true;
      state.reconnectAttempts = 0;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      setConn(true, '已连接');
      subscribe(state.sid);
    };
    ws.onmessage = function (ev) {
      if (state.ws !== ws || state.wsGeneration !== generation) return;
      var f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      handleFrame(f);
    };
    ws.onclose = function () {
      if (state.ws !== ws || state.wsGeneration !== generation) return;
      state.wsOpen = false;
      state.ws = null;
      setConn(false, '未连接');
      scheduleReconnect();
    };
    ws.onerror = function () { /* onclose 会跟上 */ };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setConn(false, '网络离线');
      return;
    }
    var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(state.reconnectAttempts, 5)));
    state.reconnectAttempts++;
    setConn(false, '重连中 ' + Math.ceil(delay / 1000) + 's');
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      refreshRuntimeEnv().catch(function () { return ENV; }).then(function () { connectWS(false); });
    }, delay);
  }

  window.addEventListener('online', function () {
    if (!state.wsOpen) connectWS(true);
  });
  window.addEventListener('offline', function () {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    setConn(false, '网络离线');
  });

  /* ================= 进行状态(typing/流式/思考/工具) ================= */

  function showTyping() {
    if (state.typingEl || state.streamEl) return;
    titleText.textContent = titleText.textContent.replace('  (对方正在输入...)', '') + '  (对方正在输入...)';
    state.typingEl = appendMsg('bot', '正在输入...');
    state.typingEl.classList.add('typing');
  }

  function hideTyping() {
    if (state.typingEl) {
      state.typingEl.remove();
      state.typingEl = null;
    }
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
    var stick = nearBottom();
    state.thinkText += d;
    if (!state.thinkEl) {
      state.thinkEl = appendMsg('bot', '');
      state.thinkEl.classList.add('thinking-live');
    }
    var t = state.thinkText;
    state.thinkEl.querySelector('.msg-body').textContent =
      '💭 思考中: ' + (t.length > 300 ? '…' + t.slice(-300) : t);
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

  function showActivity(p, sid) {
    sid = sid || state.sid;
    var record = recordLiveActivity(sid, p || {}, 'running');
    if (sid !== state.sid || !record) {
      renderSessionList();
      return;
    }
    var stick = nearBottom();
    if (!state.activityEl) {
      state.activityEl = document.createElement('div');
      state.activityEl.className = 'tool-line';
      chatBody.appendChild(state.activityEl);
    }
    state.activityEl.textContent = '🔧 ' + record.name + (record.action ? ': ' + record.action : '');
    followScroll(stick);
    renderActivityCenter();
    scheduleActivityRefresh(sid, 350);
  }

  function finishActivity(sid, payload) {
    sid = sid || state.sid;
    var record = recordLiveActivity(sid, payload || {}, payload && payload.error ? 'failed' : 'completed');
    if (sid === state.sid && state.activityEl) {
      state.activityEl.textContent += ' ✔';
    }
    if (sid === state.sid && record) renderActivityCenter();
    scheduleActivityRefresh(sid, 350);
  }

  function clearLivePresentation() {
    if (state.streamRenderTimer) {
      clearTimeout(state.streamRenderTimer);
      state.streamRenderTimer = null;
    }
    if (state.streamEl) { state.streamEl.remove(); state.streamEl = null; state.streamText = ''; }
    if (state.thinkEl) { state.thinkEl.remove(); state.thinkEl = null; state.thinkText = ''; }
    if (state.activityEl) { state.activityEl.remove(); state.activityEl = null; }
    hideTyping();
  }

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

  /* ================= 提示音 & 标题闪烁 ================= */

  var audioCtx = null;
  /* 浏览器自动播放策略:首次点击页面时恢复音频上下文 */
  document.addEventListener('click', function () {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  });

  function playDiDi() {
    if (!state.bell) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 660].forEach(function (freq, i) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.12 + 0.11);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + i * 0.12);
        o.stop(audioCtx.currentTime + i * 0.12 + 0.12);
      });
    } catch (e) { /* 无音频环境 */ }
  }

  function flashTitle() {
    if (!document.hidden) return;
    var orig = document.title;
    var on = false;
    clearInterval(state.flashTimer);
    state.flashTimer = setInterval(function () {
      on = !on;
      document.title = on ? '【新消息】Kimi 小月来信啦' : orig;
    }, 800);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      clearInterval(state.flashTimer);
      document.title = 'Kimi 2007';
    }
  });

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
      return;
    }
    if (f.type === 'event.approval.resolved' || f.type === 'permission.approval.resolved') {
      settleApproval(eventSid, p.approval_id || p.approvalId || p.toolCallId, '✅ 已处理');
      return;
    }
    if (f.type === 'event.approval.expired' || f.type === 'permission.approval.expired') {
      settleApproval(eventSid, p.approval_id || p.approvalId || p.toolCallId, '⏹ 已过期');
      return;
    }
    if (f.type === 'event.question.requested') {
      registerQuestion(eventSid, p);
      return;
    }
    if (f.type === 'event.question.answered') {
      settleQuestion(eventSid, p.question_id || p.questionId, '✅ 已回答');
      return;
    }
    if (f.type === 'event.question.dismissed') {
      settleQuestion(eventSid, p.question_id || p.questionId, '⏭ 已跳过');
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
        break;

      case 'assistant.delta':
      case 'event.assistant.delta':
        if (eventSid === state.sid) appendDelta(p.delta || '');
        break;

      case 'tool.call.started':
      case 'tool.use':
        showActivity(p, eventSid);
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
        hydrateSession(eventSid, { replaceMessages: eventSid === state.sid })
          .catch(function () { if (eventSid === state.sid) return refreshMessages(); });
        playDiDi();
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
        hydrateSession(eventSid, { replaceMessages: eventSid === state.sid })
          .catch(function () { if (eventSid === state.sid) return refreshMessages(); })
          .then(function () { queueSessionNotice(eventSid, '已停止'); });
        announceReply('Kimi 回答已停止');
        scheduleActivityRefresh(eventSid, 0);
        break;

      case 'error':
        finishSubmittedPrompt(eventSid, true);
        startWaitLoop(eventSid, true);
        queueSessionNotice(eventSid, '⚠ ' + (p.message || '出错了'));
        announceReply('Kimi 回答出错');
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

  /* ================= 审批 / 结构化问题 ================= */

  var interactionDomSeq = 0;

  function normalizeApproval(p, sid) {
    var id = p.approval_id || p.approvalId || p.toolCallId || p.tool_call_id || p.id || p.request_id;
    if (!id) return null;
    return {
      approval_id: id,
      session_id: p.session_id || p.sessionId || sid,
      tool_name: p.tool_name || p.toolName || p.name || 'tool',
      action: p.action || p.description || 'Kimi 请求执行一个操作',
      display: p.tool_input_display || p.display || {},
    };
  }

  function normalizeQuestion(p, sid) {
    var id = p.question_id || p.questionId || p.id || p.request_id;
    if (!id || !Array.isArray(p.questions)) return null;
    return {
      question_id: id,
      session_id: p.session_id || p.sessionId || sid,
      questions: p.questions,
    };
  }

  function interactionCard(kind, id) {
    var card = appendMsg('bot', '');
    card.classList.add('interaction-card', kind + '-card');
    card.setAttribute('data-interaction-id', id);
    card.querySelector('.msg-body').textContent = '';
    return card;
  }

  function interactionDisplayText(display) {
    if (!display) return '';
    if (typeof display === 'string') return display;
    if (display.path) return String(display.path);
    if (display.command) return String(display.command);
    try {
      var text = JSON.stringify(display, null, 2);
      return text === '{}' ? '' : text.slice(0, 1200);
    } catch (e) { return ''; }
  }

  function registerApproval(sid, payload) {
    var data = normalizeApproval(payload, sid);
    if (!data || !data.session_id) return;
    var ui = uiFor(data.session_id);
    var existing = ui.approvals[data.approval_id];
    if (existing) existing.data = data;
    else ui.approvals[data.approval_id] = { data: data, card: null, submitting: false };
    if (data.session_id === state.sid) {
      hideTyping();
      renderApprovalRecord(data.session_id, ui.approvals[data.approval_id]);
      renderActivityCenter();
    }
    renderSessionList();
  }

  function renderApprovalRecord(sid, record) {
    if (!record || (record.card && document.contains(record.card))) return;
    var data = record.data;
    var card = interactionCard('approval', data.approval_id);
    record.card = card;
    var body = card.querySelector('.msg-body');
    var shell = document.createElement('div');
    shell.className = 'interaction-shell';
    shell.innerHTML = '<div class="interaction-title">🔐 需要许可</div>' +
      '<div class="interaction-main"></div><div class="interaction-detail"></div>' +
      '<div class="interaction-status" aria-live="polite"></div>' +
      '<div class="interaction-actions"></div>';
    shell.querySelector('.interaction-main').textContent = data.action || data.tool_name;
    var detailText = interactionDisplayText(data.display);
    var detail = shell.querySelector('.interaction-detail');
    if (detailText) detail.textContent = detailText;
    else detail.hidden = true;
    var actions = shell.querySelector('.interaction-actions');
    var yes = document.createElement('button');
    var no = document.createElement('button');
    yes.type = no.type = 'button';
    yes.className = 'ap-btn yes';
    no.className = 'ap-btn no';
    yes.textContent = '✔ 批准';
    no.textContent = '✘ 拒绝';
    actions.appendChild(yes);
    actions.appendChild(no);
    body.appendChild(shell);

    function decide(decision) {
      if (record.submitting) return;
      record.submitting = true;
      yes.disabled = no.disabled = true;
      shell.querySelector('.interaction-status').textContent = '正在提交…';
      api('/sessions/' + encodeURIComponent(sid) + '/approvals/' + encodeURIComponent(data.approval_id), {
        method: 'POST',
        body: JSON.stringify({ decision: decision }),
      }).then(function () {
        settleApproval(sid, data.approval_id, decision === 'approved' ? '✅ 已批准' : '🚫 已拒绝');
      }).catch(function (err) {
        record.submitting = false;
        yes.disabled = no.disabled = false;
        shell.querySelector('.interaction-status').textContent = '提交失败: ' + err.message;
      });
    }
    yes.addEventListener('click', function () { decide('approved'); });
    no.addEventListener('click', function () { decide('rejected'); });
  }

  function settleApproval(sid, id, label) {
    var ui = uiFor(sid);
    var record = ui && ui.approvals[id];
    if (!record) return;
    delete ui.approvals[id];
    if (record.card && document.contains(record.card)) {
      var actions = record.card.querySelector('.interaction-actions');
      if (actions) actions.remove();
      var status = record.card.querySelector('.interaction-status');
      if (status) status.textContent = label;
      record.card.classList.add('resolved');
    }
    if (sid === state.sid) renderActivityCenter();
    renderSessionList();
  }

  function registerQuestion(sid, payload) {
    var data = normalizeQuestion(payload, sid);
    if (!data || !data.session_id) return;
    var ui = uiFor(data.session_id);
    var existing = ui.questions[data.question_id];
    if (existing) existing.data = data;
    else ui.questions[data.question_id] = { data: data, card: null, submitting: false };
    if (data.session_id === state.sid) {
      hideTyping();
      renderQuestionRecord(data.session_id, ui.questions[data.question_id]);
      renderActivityCenter();
    }
    renderSessionList();
  }

  function renderQuestionRecord(sid, record) {
    if (!record || (record.card && document.contains(record.card))) return;
    var data = record.data;
    var card = interactionCard('question', data.question_id);
    record.card = card;
    var body = card.querySelector('.msg-body');
    var shell = document.createElement('div');
    shell.className = 'interaction-shell';
    shell.innerHTML = '<div class="interaction-title">❓ 需要你的选择</div>' +
      '<form class="question-form"></form>' +
      '<div class="interaction-status" aria-live="polite"></div>' +
      '<div class="interaction-actions"></div>';
    var form = shell.querySelector('.question-form');
    var controls = {};

    data.questions.forEach(function (q, qi) {
      var field = document.createElement('fieldset');
      field.className = 'question-block';
      var legend = document.createElement('legend');
      legend.textContent = q.header || ('问题 ' + (qi + 1));
      field.appendChild(legend);
      var prompt = document.createElement('div');
      prompt.className = 'question-prompt';
      prompt.textContent = q.question || '';
      field.appendChild(prompt);
      if (q.body) {
        var note = document.createElement('div');
        note.className = 'question-note';
        note.textContent = q.body;
        field.appendChild(note);
      }
      var name = 'q_' + (++interactionDomSeq);
      var inputs = [];
      (q.options || []).forEach(function (opt) {
        var label = document.createElement('label');
        label.className = 'question-option';
        var choose = document.createElement('input');
        choose.type = q.multi_select ? 'checkbox' : 'radio';
        choose.name = name;
        choose.value = opt.id;
        choose.setAttribute('data-option-id', opt.id);
        label.appendChild(choose);
        var copy = document.createElement('span');
        copy.className = 'question-option-copy';
        var title = document.createElement('span');
        title.className = 'question-option-label';
        title.textContent = opt.label;
        copy.appendChild(title);
        if (opt.recommended || opt.is_recommended) {
          var recommended = document.createElement('span');
          recommended.className = 'question-recommended';
          recommended.textContent = '推荐';
          copy.appendChild(recommended);
        }
        if (opt.description) {
          var desc = document.createElement('span');
          desc.className = 'question-option-desc';
          desc.textContent = opt.description;
          copy.appendChild(desc);
        }
        label.appendChild(copy);
        field.appendChild(label);
        inputs.push(choose);
      });

      var otherChoice = null;
      var otherText = null;
      if (q.allow_other) {
        var otherLabel = document.createElement('label');
        otherLabel.className = 'question-option question-other';
        otherChoice = document.createElement('input');
        otherChoice.type = q.multi_select ? 'checkbox' : 'radio';
        otherChoice.name = name;
        otherChoice.value = '__other__';
        otherLabel.appendChild(otherChoice);
        var otherWrap = document.createElement('span');
        otherWrap.className = 'question-option-copy';
        var otherName = document.createElement('span');
        otherName.className = 'question-option-label';
        otherName.textContent = q.other_label || '其他';
        otherText = document.createElement('input');
        otherText.type = 'text';
        otherText.className = 'question-other-input';
        otherText.placeholder = q.other_description || '请输入其他答案';
        otherText.disabled = true;
        otherWrap.appendChild(otherName);
        otherWrap.appendChild(otherText);
        otherLabel.appendChild(otherWrap);
        field.appendChild(otherLabel);
        otherChoice.addEventListener('change', function () {
          otherText.disabled = !otherChoice.checked;
          if (otherChoice.checked) otherText.focus();
        });
        if (!q.multi_select) {
          inputs.forEach(function (optInput) {
            optInput.addEventListener('change', function () { otherText.disabled = true; });
          });
        }
      }
      controls[q.id] = { question: q, field: field, inputs: inputs, otherChoice: otherChoice, otherText: otherText };
      form.appendChild(field);
    });

    var actions = shell.querySelector('.interaction-actions');
    var submit = document.createElement('button');
    var dismiss = document.createElement('button');
    submit.type = dismiss.type = 'button';
    submit.className = 'ap-btn yes';
    dismiss.className = 'ap-btn no';
    submit.textContent = '提交回答';
    dismiss.textContent = '跳过本次';
    actions.appendChild(submit);
    actions.appendChild(dismiss);
    body.appendChild(shell);

    function setLoading(loading, text) {
      record.submitting = loading;
      Array.prototype.forEach.call(shell.querySelectorAll('input, button'), function (el) { el.disabled = loading; });
      if (!loading) {
        Object.keys(controls).forEach(function (qid) {
          var c = controls[qid];
          if (c.otherText) c.otherText.disabled = !c.otherChoice.checked;
        });
      }
      shell.querySelector('.interaction-status').textContent = text || '';
    }

    function collectAnswers() {
      var answers = {};
      var missing = null;
      Object.keys(controls).some(function (qid) {
        var c = controls[qid];
        var selected = c.inputs.filter(function (el) { return el.checked; }).map(function (el) { return el.value; });
        var hasOther = !!(c.otherChoice && c.otherChoice.checked);
        var other = c.otherText ? c.otherText.value.trim() : '';
        if ((!selected.length && !hasOther) || (hasOther && !other)) {
          missing = c;
          return true;
        }
        if (c.question.multi_select) {
          answers[qid] = hasOther
            ? { kind: 'multi_with_other', option_ids: selected, other_text: other }
            : { kind: 'multi', option_ids: selected };
        } else {
          answers[qid] = hasOther
            ? { kind: 'other', text: other }
            : { kind: 'single', option_id: selected[0] };
        }
        return false;
      });
      if (missing) {
        shell.querySelector('.interaction-status').textContent = '请完成所有问题；选择“其他”时需填写内容。';
        var focusTarget = missing.field.querySelector('input:not(:disabled)');
        if (focusTarget) focusTarget.focus();
        return null;
      }
      return answers;
    }

    submit.addEventListener('click', function () {
      if (record.submitting) return;
      var answers = collectAnswers();
      if (!answers) return;
      setLoading(true, '正在提交回答…');
      api('/sessions/' + encodeURIComponent(sid) + '/questions/' + encodeURIComponent(data.question_id), {
        method: 'POST',
        body: JSON.stringify({ answers: answers, method: 'click' }),
      }).then(function () {
        settleQuestion(sid, data.question_id, '✅ 已回答');
      }).catch(function (err) {
        setLoading(false, '提交失败: ' + err.message);
      });
    });

    dismiss.addEventListener('click', function () {
      if (record.submitting) return;
      setLoading(true, '正在跳过…');
      api('/sessions/' + encodeURIComponent(sid) + '/questions/' + encodeURIComponent(data.question_id) + ':dismiss', {
        method: 'POST',
      }).then(function () {
        settleQuestion(sid, data.question_id, '⏭ 已跳过');
      }).catch(function (err) {
        if (err.code === 40909) {
          settleQuestion(sid, data.question_id, '⏭ 已跳过');
          return;
        }
        setLoading(false, '跳过失败: ' + err.message);
      });
    });
  }

  function settleQuestion(sid, id, label) {
    var ui = uiFor(sid);
    var record = ui && ui.questions[id];
    if (!record) return;
    delete ui.questions[id];
    if (record.card && document.contains(record.card)) {
      Array.prototype.forEach.call(record.card.querySelectorAll('input, button'), function (el) { el.disabled = true; });
      var actions = record.card.querySelector('.interaction-actions');
      if (actions) actions.remove();
      var status = record.card.querySelector('.interaction-status');
      if (status) status.textContent = label;
      record.card.classList.add('resolved');
    }
    if (sid === state.sid) renderActivityCenter();
    renderSessionList();
  }

  function syncInteractionState(sid, approvals, questions) {
    var ui = uiFor(sid);
    var nextApprovals = {};
    approvals.forEach(function (p) {
      var data = normalizeApproval(p, sid);
      if (!data) return;
      var old = ui.approvals[data.approval_id];
      nextApprovals[data.approval_id] = old || { data: data, card: null, submitting: false };
      nextApprovals[data.approval_id].data = data;
    });
    var nextQuestions = {};
    questions.forEach(function (q) {
      var data = normalizeQuestion(q, sid);
      if (!data) return;
      var old = ui.questions[data.question_id];
      nextQuestions[data.question_id] = old || { data: data, card: null, submitting: false };
      nextQuestions[data.question_id].data = data;
    });
    ui.approvals = nextApprovals;
    ui.questions = nextQuestions;
    if (sid === state.sid) renderActivityCenter();
    renderSessionList();
  }

  function renderInteractionCards(sid) {
    if (sid !== state.sid) return;
    $$('.interaction-card').forEach(function (card) { card.remove(); });
    var ui = uiFor(sid);
    Object.keys(ui.approvals).forEach(function (id) {
      ui.approvals[id].card = null;
      renderApprovalRecord(sid, ui.approvals[id]);
    });
    Object.keys(ui.questions).forEach(function (id) {
      ui.questions[id].card = null;
      renderQuestionRecord(sid, ui.questions[id]);
    });
  }

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
      if (!record.settled) showTyping();
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
    var promptController = new AbortController();
    submittedPrompt.controller = promptController;

    setDraft(sid, '');
    input.value = '';
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
  input.addEventListener('keydown', function (e) {
    /* 中文输入法组词中按 Enter 是确认候选词,不能发送 */
    if (e.isComposing || e.keyCode === 229) return;
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
  });

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

  /* ================= 表情 ================= */

  var EMOJIS = ['^_^', '-_-', 'T_T', 'Orz', '=^_^=', '~_~', '+_+', '@_@',
    'π_π', 'Q_Q', '$_$', 'o_o', '(≧▽≦)', '(¬_¬)', '(=・ω・=)', '╮(╯▽╰)╭',
    '(ง •̀_•́)ง', '(´;ω;`)', '(⊙o⊙)', '(≧ω≦)', '→_→', '←_←', 'zzZ', ':(', ':)'];
  var emojiPop = $('#emojiPop');

  /* 弹层注册表：emoji/模型/发送方式/Kimi 菜单的互斥关闭、外部点击关闭、
     Esc 关闭和 aria-expanded 同步统一走这里，新增弹层只需加一行。 */
  function popupSpecs() {
    return [
      { el: emojiPop, trigger: $('#emojiBtn') },
      { el: modelMenu, trigger: $('#modelBtn') },
      { el: sendModeMenu, trigger: $('#sendMore') },
      { el: slMenu, trigger: $('#slMenuBtn') }
    ];
  }

  function popupTrigger(el) {
    var found = null;
    popupSpecs().forEach(function (p) { if (p.el === el) found = p.trigger; });
    return found;
  }

  function closePopup(el) {
    var trigger = popupTrigger(el);
    if (el) el.classList.remove('show');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function closeAllPopups(except) {
    popupSpecs().forEach(function (p) {
      if (p.el === except) return;
      closePopup(p.el);
    });
  }

  /* 互斥开关：关闭其他弹层后切换目标弹层，返回切换后的开合状态。 */
  function togglePopup(el, trigger) {
    var open = !el.classList.contains('show');
    closeAllPopups(el);
    el.classList.toggle('show', open);
    if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    return open;
  }

  EMOJIS.forEach(function (e) {
    var s = document.createElement('button');
    s.type = 'button';
    s.textContent = e;
    s.addEventListener('click', function () {
      var start = input.selectionStart || input.value.length;
      var end = input.selectionEnd || input.value.length;
      input.value = input.value.slice(0, start) + e + input.value.slice(end);
      input.selectionStart = input.selectionEnd = start + e.length;
      input.dispatchEvent(new Event('input'));
      closePopup(emojiPop);
      input.focus();
    });
    emojiPop.appendChild(s);
  });

  function toggleEmoji(e) {
    e.stopPropagation();
    var open = togglePopup(emojiPop, $('#emojiBtn'));
    if (open) {
      var composerBounds = $('.composer').getBoundingClientRect();
      var triggerBounds = $('#emojiBtn').getBoundingClientRect();
      emojiPop.style.bottom = Math.max(34, composerBounds.bottom - triggerBounds.top + 4) + 'px';
      var first = emojiPop.querySelector('button');
      if (first) first.focus();
    }
  }

  $('#emojiBtn').addEventListener('click', toggleEmoji);

  /* ================= 模型菜单 ================= */

  var modelMenu = $('#modelMenu');

  $('#modelBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    var open = togglePopup(modelMenu, $('#modelBtn'));
    if (!open) return;
    renderModelMenu();
    loadModels().catch(function (err) {
      if (!state.models.length) {
        modelMenu.innerHTML = '<div class="model-opt p-dim">读取模型失败: ' + esc(err.message) + '</div>';
      }
    }).then(function () {
      var first = modelMenu.querySelector('button:not(:disabled)');
      if (first && modelMenu.classList.contains('show')) first.focus();
    });
  });

  /* 点击任何弹层及其触发按钮以外的地方时，统一关闭对应弹层。 */
  document.addEventListener('click', function (e) {
    popupSpecs().forEach(function (p) {
      if (!p.el || !p.el.classList.contains('show')) return;
      if (p.el.contains(e.target) || (p.trigger && p.trigger.contains(e.target))) return;
      closePopup(p.el);
    });
  });

  /* ================= 导航 ================= */

  var navNewBtn = document.getElementById('navNew');
  if (navNewBtn) navNewBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    newSession();
  });

  /* 会话搜索 */
  var searchEl = $('#sessSearch');
  if (searchEl) {
    searchEl.addEventListener('input', renderSessionList);
  }

  /* 铃铛开关 */
  var bellEl = $('#bellToggle');
  if (bellEl) {
    function syncBell() {
      bellEl.textContent = state.bell ? '🔔' : '🔕';
      bellEl.title = state.bell ? '消息提示音: 已开启' : '消息提示音: 已关闭';
      bellEl.setAttribute('aria-label', bellEl.title);
      bellEl.setAttribute('aria-pressed', state.bell ? 'true' : 'false');
    }
    syncBell();
    bellEl.addEventListener('click', function () {
      state.bell = !state.bell;
      localStorage.setItem('kimi2007.bell', state.bell ? 'on' : 'off');
      syncBell();
    });
  }

  /* ================= 通用面板 ================= */

  var panelGen = 0;
  var panelReturnFocus = null;

  function openPanel(title) {
    panelGen++;
    if ($('#panel').hidden) panelReturnFocus = document.activeElement;
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
  function activateWorkspace(root) {
    var gen = ++state.workspaceUpdateGen;
    saveComposer(state.sid);
    state.cwdFilter = root || null;
    if (root) ENV.cwd = root;
    return loadSessions().then(function (loaded) {
      if (gen !== state.workspaceUpdateGen) return null;
      if (loaded.length) return loaded;
      return createSession(root || ENV.cwd).then(loadSessions);
    }).then(function (loaded) {
      if (gen !== state.workspaceUpdateGen || !loaded) return null;
      var active = loaded.some(function (s) { return s.id === state.sid; });
      if (!active && loaded[0]) return switchSession(loaded[0].id);
      syncModelButton();
      return null;
    }).then(function () {
      if (gen === state.workspaceUpdateGen) {
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
      items.forEach(function (w) {
        var root = w.root || w.cwd || w.path || '';
        var name = w.name || root.split('/').pop() || root;
        html += '<button class="p-row p-ws' + (selectedRoot === root ? ' p-selected' : '') +
          '" type="button" data-root="' + esc(root) + '" aria-pressed="' + (selectedRoot === root ? 'true' : 'false') + '">' +
          '<span>' + esc(name) + '</span><span class="p-dim">' + esc(root) + '</span></button>';
      });
      body.innerHTML = html;
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

  /* ---------------- 图片 / 附件上传 ---------------- */
  function uploadFile(file, signal, retried) {
    var fd = new FormData();
    fd.append('file', file, file.name);
    return fetch(ENV.base + '/api/v1/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ENV.token },
      body: fd,
      signal: signal,
    }).then(function (r) {
      if (r.status === 401 && !retried) {
        return refreshRuntimeEnv().then(function () { return uploadFile(file, signal, true); });
      }
      return r.json().then(function (j) {
        if (!r.ok || j.code !== 0) throw new Error(j.msg || ('HTTP ' + r.status));
        return j.data;
      });
    });
  }

  function renderAttachRow() {
    var row = $('#attachRow');
    var sid = state.sid;
    var ui = currentUi();
    /* 全量重建会移除焦点所在的删除按钮；先记住附件 key，重建后把焦点还回去。 */
    var focusKey = null;
    if (document.activeElement && row.contains(document.activeElement)) {
      focusKey = document.activeElement.getAttribute('data-key') || '';
    }
    row.innerHTML = '';
    (ui ? ui.pendingFiles : []).forEach(function (rec) {
      var chip = document.createElement('div');
      chip.className = 'attach-chip ' + rec.status;
      chip.title = rec.status === 'fail' ? rec.error : rec.name;

      if (rec.previewUrl) {
        var img = document.createElement('img');
        img.className = 'attach-thumb';
        img.src = rec.previewUrl;
        img.alt = '';
        chip.appendChild(img);
      }

      var name = document.createElement('span');
      name.className = 'attach-name';
      name.textContent = (rec.status === 'uploading' ? '⏳ ' : rec.status === 'fail' ? '⚠ ' : '📎 ') +
        rec.name + (rec.status === 'fail' ? '（上传失败）' : '');
      chip.appendChild(name);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'attach-del';
      del.title = '移除 ' + rec.name;
      del.setAttribute('aria-label', '移除附件 ' + rec.name);
      del.setAttribute('data-key', String(rec.key));
      del.textContent = '✕';
      del.disabled = !!(ui && (ui.submitting || ui.aborting));
      del.addEventListener('click', function () {
        var uploadedId = rec.id;
        rec.discarded = true;
        if (rec.countedAsUploading) {
          ui.uploading = Math.max(0, ui.uploading - 1);
          rec.countedAsUploading = false;
        }
        ui.pendingFiles = ui.pendingFiles.filter(function (x) { return x !== rec; });
        if (rec.previewUrl) URL.revokeObjectURL(rec.previewUrl);
        renderAttachRow();
        updateComposerState();
        if (uploadedId) {
          rec.id = null;
          rec.uploadPromise = deleteTemporaryFile(sid, uploadedId);
          trackDetachedUpload(ui, rec);
        } else {
          trackDetachedUpload(ui, rec);
        }
      });
      chip.appendChild(del);
      row.appendChild(chip);
    });
    row.hidden = !ui || !ui.pendingFiles.length;
    if (focusKey !== null) {
      var nextFocus = focusKey ? row.querySelector('[data-key="' + focusKey + '"]') : null;
      (nextFocus || input).focus();
    }
  }

  function addAttachments(files) {
    var sid = state.sid;
    var ui = uiFor(sid);
    if (!sid || !ui || ui.submitting || ui.aborting) return;
    Array.prototype.forEach.call(files, function (f) {
      var controller = new AbortController();
      var rec = {
        key: ++state.uploadSeq,
        id: null,
        name: f.name || '未命名附件',
        media_type: f.type || 'application/octet-stream',
        size: f.size || 0,
        status: 'uploading',
        error: '',
        previewUrl: f.type && f.type.indexOf('image/') === 0 ? URL.createObjectURL(f) : '',
        controller: controller,
        discarded: false,
        countedAsUploading: true,
        uploadPromise: null,
        uploadTimeout: null,
      };
      ui.pendingFiles.push(rec);
      ui.uploading++;
      rec.uploadTimeout = setTimeout(function () { controller.abort(); }, 120000);
      renderAttachRow();
      updateComposerState();

      rec.uploadPromise = uploadFile(f, controller.signal).then(function (d) {
        rec.controller = null;
        if (rec.discarded || ui.pendingFiles.indexOf(rec) === -1) {
          rec.id = d.id;
          return deleteTemporaryFile(sid, d.id).then(function () { rec.id = null; });
        }
        rec.id = d.id;
        rec.name = d.name || rec.name;
        rec.media_type = d.media_type || rec.media_type || 'application/octet-stream';
        rec.size = d.size == null ? rec.size : d.size;
        rec.status = 'ready';
      }).catch(function (e) {
        rec.controller = null;
        if (rec.discarded || ui.pendingFiles.indexOf(rec) === -1) return;
        rec.status = 'fail';
        rec.error = e.name === 'AbortError' ? '上传超时，请移除后重新选择' : (e.message || '上传失败');
      }).then(function () {
        if (rec.uploadTimeout) {
          clearTimeout(rec.uploadTimeout);
          rec.uploadTimeout = null;
        }
        if (rec.countedAsUploading) {
          ui.uploading = Math.max(0, ui.uploading - 1);
          rec.countedAsUploading = false;
        }
        if (state.sid === sid) {
          renderAttachRow();
          updateComposerState();
        }
      });
    });
  }

  $('#imgBtn').addEventListener('click', function () { $('#fileImage').click(); });
  $('#attachBtn').addEventListener('click', function () { $('#fileAny').click(); });
  $('#fileImage').addEventListener('change', function (e) {
    addAttachments(e.target.files);
    e.target.value = '';
  });
  $('#fileAny').addEventListener('change', function (e) {
    addAttachments(e.target.files);
    e.target.value = '';
  });

  /* 文件可直接拖到输入区；粘贴截图时自动进入附件队列。 */
  var composerEl = $('.composer');
  ['dragenter', 'dragover'].forEach(function (type) {
    composerEl.addEventListener(type, function (e) {
      if (!e.dataTransfer || !e.dataTransfer.types || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
      e.preventDefault();
      composerEl.classList.add('drop-target');
    });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    composerEl.addEventListener(type, function () { composerEl.classList.remove('drop-target'); });
  });
  composerEl.addEventListener('drop', function (e) {
    composerEl.classList.remove('drop-target');
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addAttachments(e.dataTransfer.files);
  });
  input.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var files = [];
    Array.prototype.forEach.call(items, function (item) {
      if (item.kind !== 'file') return;
      var file = item.getAsFile && item.getAsFile();
      if (file) files.push(file);
    });
    if (files.length) addAttachments(files);
  });

  /* ---------------- 发送方式(Enter / Ctrl+Enter) ---------------- */
  var sendModeMenu = $('#sendModeMenu');

  $('#sendMore').addEventListener('click', function (e) {
    e.stopPropagation();
    var open = togglePopup(sendModeMenu, $('#sendMore'));
    if (open) {
      var selected = sendModeMenu.querySelector('.active-mode') || sendModeMenu.querySelector('button');
      if (selected) selected.focus();
    }
  });

  $$('#sendModeMenu .model-opt').forEach(function (opt) {
    var active = opt.getAttribute('data-mode') === state.sendMode;
    if (active) opt.classList.add('active-mode');
    opt.setAttribute('aria-checked', active ? 'true' : 'false');
    opt.addEventListener('click', function () {
      state.sendMode = opt.getAttribute('data-mode');
      localStorage.setItem('kimi2007.sendmode', state.sendMode);
      $$('#sendModeMenu .model-opt').forEach(function (o) { o.classList.remove('active-mode'); });
      opt.classList.add('active-mode');
      $$('#sendModeMenu .model-opt').forEach(function (o) {
        o.setAttribute('aria-checked', o === opt ? 'true' : 'false');
      });
      closePopup(sendModeMenu);
      updateComposerState();
      notifyUi('发送方式：' + (state.sendMode === 'enter' ? 'Enter 发送' : 'Ctrl+Enter 发送，Enter 换行'));
      input.focus();
    });
  });

  /* ---------------- 聊天字号 ---------------- */
  var FONT_LABELS = { 12: '小', 13.5: '标准', 15: '大' };

  function applyFontSize(notify) {
    chatBody.style.fontSize = state.fontSize + 'px';
    $('#fontBtn').title = '聊天字号: ' + FONT_LABELS[state.fontSize] + '(' + state.fontSize + 'px),点击切换';
    $('#fontBtn').setAttribute('aria-label', $('#fontBtn').title);
    $('#fontBtn').setAttribute('data-size', FONT_LABELS[state.fontSize]);
    if (notify) notifyUi('聊天字号：' + FONT_LABELS[state.fontSize] + '（' + state.fontSize + 'px）');
  }

  applyFontSize(false);

  $('#fontBtn').addEventListener('click', function () {
    var i = FONT_SIZES.indexOf(state.fontSize);
    state.fontSize = FONT_SIZES[(i + 1) % FONT_SIZES.length];
    localStorage.setItem('kimi2007.font', String(state.fontSize));
    applyFontSize(true);
  });

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
    var leftOpen = sideLeft.classList.contains('mobile-open');
    var rightOpen = !sideRight.classList.contains('is-hidden') && sideRight.classList.contains('mobile-open');
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
  $('#activityToggle').addEventListener('click', function (event) {
    setRightHidden(false);
    if (!compactLayout()) {
      renderActivityCenter();
      sideRight.focus && sideRight.focus();
      return;
    }
    sideLeft.classList.remove('mobile-open');
    var open = !sideRight.classList.contains('mobile-open');
    sideRight.classList.toggle('mobile-open', open);
    drawerReturnFocus = open ? event.currentTarget : null;
    syncMobileBackdrop();
    renderActivityCenter();
    if (open) requestAnimationFrame(function () {
      var first = sideRight.querySelector('button:not([hidden]):not([disabled])');
      (first || sideRight).focus();
    });
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
      '<div class="p-row"><span>搜索会话</span><span class="p-dim">⌘ / Ctrl + K</span></div>' +
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

  function editableTarget(target) {
    return !!(target && (target.matches('input, textarea, select') || target.isContentEditable));
  }
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (!$('#panel').hidden) return;
    var key = String(e.key || '').toLowerCase();
    var command = e.metaKey || e.ctrlKey;
    var openDrawer = sideLeft.classList.contains('mobile-open') ? sideLeft :
      (sideRight.classList.contains('mobile-open') ? sideRight : null);
    if (openDrawer && e.key === 'Tab') {
      var drawerFocusables = Array.prototype.slice.call(openDrawer.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )).filter(function (el) { return !el.hidden && el.offsetParent !== null; });
      if (drawerFocusables.length) {
        var drawerFirst = drawerFocusables[0];
        var drawerLast = drawerFocusables[drawerFocusables.length - 1];
        if (e.shiftKey && document.activeElement === drawerFirst) {
          e.preventDefault();
          drawerLast.focus();
        } else if (!e.shiftKey && document.activeElement === drawerLast) {
          e.preventDefault();
          drawerFirst.focus();
        }
      }
      return;
    }
    if (e.key === 'Escape') {
      var hadDrawer = !!openDrawer;
      var popoverReturn = null;
      popupSpecs().forEach(function (p) {
        if (!popoverReturn && p.el && p.el.classList.contains('show')) popoverReturn = p.trigger;
      });
      closeAllPopups();
      closeMobileDrawers(hadDrawer);
      if (!hadDrawer && popoverReturn) popoverReturn.focus();
      return;
    }
    if (command && key === '.' && state.busy) {
      e.preventDefault();
      abort();
      return;
    }
    if (command && key === 'k') {
      e.preventDefault();
      if (compactLayout()) {
        drawerReturnFocus = document.activeElement;
        sideRight.classList.remove('mobile-open');
        sideLeft.classList.add('mobile-open');
        syncMobileBackdrop();
      }
      searchEl.focus();
      return;
    }
    if (command && key === 'n') {
      e.preventDefault();
      newSession();
      return;
    }
    if (command && e.shiftKey && key === 'a') {
      e.preventDefault();
      $('#activityToggle').click();
      return;
    }
    if (command && e.shiftKey && key === 'm') {
      e.preventDefault();
      showPlugins();
      return;
    }
    if (e.key === '?' && !editableTarget(e.target)) {
      e.preventDefault();
      showShortcuts();
    }
  });

  /* ================= 启动 ================= */

  (function boot() {
    setConn(false, '连接中');
    updateComposerState();
    loadSessions()
      .then(function (items) {
        var stored = localStorage.getItem('kimi2007.sid');
        var pick = null;
        for (var i = 0; i < items.length; i++) {
          if (items[i].id === stored) { pick = items[i]; break; }
        }
        if (!pick) pick = items[0];
        if (pick) {
          state.sid = pick.id;
          localStorage.setItem('kimi2007.sid', pick.id);
          applyTitle(pick.title);
        }
        return pick ? Promise.resolve(pick) : createSession().then(function (s) {
          state.sid = s.id;
          localStorage.setItem('kimi2007.sid', s.id);
          applyTitle(null);
          return loadSessions();
        });
      })
      .then(function () {
        renderSessionList();
        restoreComposer(state.sid);
        syncModelButton();
        return hydrateSession(state.sid, { replaceMessages: true }).catch(function (e) {
          queueSessionNotice(state.sid, '完整状态恢复失败，已回退到消息列表: ' + e.message);
          return refreshMessages();
        });
      })
      .then(function () {
        if (!Object.keys(state.rendered).length) showChatEmpty();
        connectWS(false);
      })
      .catch(function (e) {
        setConn(false, '连接失败');
        appendSys('⚠ 连不上 kimi server(' + ENV.base + '):' + e.message +
          (desktopApi ? ' —— 请确认 Kimi CLI 已安装并完成登录' : ' —— 请确认已运行 node serve.js'));
      });
  })();
})();
