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

  var TAGS_KEY = 'kimi2007.sessionTags.v1';
  function readStoredTags() {
    try {
      var stored = JSON.parse(localStorage.getItem(TAGS_KEY) || '{}');
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
      var tags = {};
      Object.keys(stored).forEach(function (sid) {
        if (!Array.isArray(stored[sid])) return;
        var list = stored[sid].filter(function (t) { return typeof t === 'string' && t.trim(); });
        if (list.length) tags[sid] = list;
      });
      return tags;
    } catch (e) {
      return {};
    }
  }

  var FAV_KEY = 'kimi2007.favorites.v1';
  var FAV_SORT_KEY = 'kimi2007.favoriteSort.v1';

  /*
   * 收藏只保存在本地，因此在读入时就把旧记录补全为当前结构。这样后来加入的
   * 工作区、笔记等字段不会让老数据失效；同时按 sid + mid 去重，避免旧版本
   * 异常重试留下两张一模一样的卡片。
   */
  function normalizeStoredFavorite(raw, index) {
    if (!raw || typeof raw !== 'object' || !raw.sid || !raw.mid) return null;
    var tags = [];
    if (Array.isArray(raw.tags)) {
      raw.tags.forEach(function (tag) {
        tag = typeof tag === 'string' ? tag.trim() : '';
        if (tag && tags.indexOf(tag) === -1) tags.push(tag);
      });
    }
    var ts = typeof raw.ts === 'number' ? raw.ts : Date.parse(raw.ts);
    if (!isFinite(ts) || ts < 0) ts = 0;
    var sid = String(raw.sid);
    var mid = String(raw.mid);
    return {
      id: raw.id ? String(raw.id) : 'fav-' + index + '-' + sid + '-' + mid,
      sid: sid,
      mid: mid,
      role: raw.role === 'user' ? 'user' : 'assistant',
      text: String(raw.text || ''),
      promptText: String(raw.promptText || ''),
      sessTitle: String(raw.sessTitle || ''),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      ts: ts,
      tags: tags,
      note: typeof raw.note === 'string' ? raw.note : ''
    };
  }

  function readStoredFavorites() {
    try {
      var stored = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
      if (!Array.isArray(stored)) return [];
      var items = [];
      var byMessage = {};
      stored.forEach(function (raw, index) {
        var favorite = normalizeStoredFavorite(raw, index);
        if (!favorite) return;
        var key = favorite.sid + '\u0000' + favorite.mid;
        var previous = byMessage[key];
        if (previous == null) {
          byMessage[key] = items.length;
          items.push(favorite);
        } else if ((items[previous].ts || 0) <= (favorite.ts || 0)) {
          items[previous] = favorite;
        }
      });
      return items;
    } catch (e) {
      return [];
    }
  }

  function readStoredFavoriteSort() {
    try {
      var sort = localStorage.getItem(FAV_SORT_KEY);
      return ['newest', 'oldest', 'session'].indexOf(sort) >= 0 ? sort : 'newest';
    } catch (e) {
      return 'newest';
    }
  }

  var SESS_GROUPS = ['time', 'tag', 'date', 'workspace'];
  var savedSessGroup = null;
  try { savedSessGroup = localStorage.getItem('kimi2007.sessgroup'); } catch (e) { savedSessGroup = null; }
  if (SESS_GROUPS.indexOf(savedSessGroup) === -1) savedSessGroup = 'time';

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
    silenceTimer: null,    // typing 阶段静默计时(分阶段文案)
    silenceStart: 0,       // 最近一次活动信号时间戳
    activityTick: null,    // 工具行已运行秒数刷新定时器
    activityStart: 0,      // 当前工具行开始时间戳
    busy: false,
    lastSeq: {},           // sid -> 已见事件序号(断点续订)
    epochs: {},            // sid -> snapshot epoch，供 WS 游标失效检测
    reconnectTimer: null,
    reconnectAttempts: 0,
    wsReconnectPending: false, // 经历过断线、待重连成功后回读 /status 纠偏运行态
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
    sessionTags: readStoredTags(),
    favorites: readStoredFavorites(),
    favoriteSort: readStoredFavoriteSort(),
    sessGroup: savedSessGroup, // time|tag|date
    tagFilter: null,           // 非空时只显示带该标签的会话
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

  /* 会话列表的时间标签：只给 HH:MM 会让三天前的 15:15 看着比今天的 09:11 还新，
     与按 updated_at 倒序的实际排列矛盾。按新旧程度换用不同粒度。 */
  function sessTimeLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var t = d.getTime();
    if (t >= startOfToday) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (t >= startOfToday - 86400000) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '-' + d.getDate();
    return String(d.getFullYear()).slice(2) + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  /* 悬停用的完整本地时间(服务端给的是 UTC ISO，直接截字符串会和上面的本地标签对不上)。 */
  function fullLocalTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
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
    /* markdown-it 在块级标签之间输出换行;.msg-body 是 pre-wrap,这些换行会被
       渲染成多余空行,故剔除标签之间及首尾的换行(段落内换行已由 breaks 转为
       <br>,代码块内容经转义不含裸标签,均不受影响)。 */
    return md.render(escStrayTags(String(text == null ? '' : text)))
      .replace(/<br>\n/g, '<br>').replace(/>\n+</g, '><').replace(/^\n+|\n+$/g, '');
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
