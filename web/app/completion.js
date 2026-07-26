  /* ================= 表情 ================= */

  var EMOJIS = ['^_^', '-_-', 'T_T', 'Orz', '=^_^=', '~_~', '+_+', '@_@',
    'π_π', 'Q_Q', '$_$', 'o_o', '(≧▽≦)', '(¬_¬)', '(=・ω・=)', '╮(╯▽╰)╭',
    '(ง •̀_•́)ง', '(´;ω;`)', '(⊙o⊙)', '(≧ω≦)', '→_→', '←_←', 'zzZ', ':(', ':)'];
  var emojiPop = $('#emojiPop');
  var completePop = $('#completePop');

  /* 弹层注册表：emoji/模型/发送方式/Kimi 菜单的互斥关闭、外部点击关闭、
     Esc 关闭和 aria-expanded 同步统一走这里，新增弹层只需加一行。 */
  function popupSpecs() {
    return [
      { el: emojiPop, trigger: $('#emojiBtn') },
      { el: modelMenu, trigger: $('#modelBtn') },
      { el: sendModeMenu, trigger: $('#sendMore') },
      { el: slMenu, trigger: $('#slMenuBtn') },
      { el: completePop, trigger: null },
      /* 宠物资料卡可由旁侧「资料」按钮固定展开。 */
      { el: $('#petStats'), trigger: $('#petActionInfo') }
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
    /* 补全菜单被统一弹层体系关闭时同步重置内部状态,避免导航键被继续接管 */
    if (el === completePop && comp.mode) compClose();
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

  /* ================= 输入补全(/ 命令与 @ 文件引用) ================= */

  /* 服务端会话动作(compact/undo/fork)：统一走 :action 路由,错误经 toast 反馈。 */
  function sessionAction(action, body) {
    if (!state.sid) { notifyUi('请先打开一个会话', 'error'); return Promise.reject(new Error('no session')); }
    return api('/sessions/' + encodeURIComponent(state.sid) + ':' + action, {
      method: 'POST', body: JSON.stringify(body || {})
    });
  }

  /* 斜杠命令清单：kind=action 走对应的界面入口或服务端 :action 在本地执行；
     kind=prompt 作为普通消息发送给 Kimi(服务端 REST 不拦截 / 前缀,未匹配的命令同理按消息发送)。
     run(args)：菜单选中时 args 为空；直接在输入框键入 "/cmd 参数" 回车时 args 为命令后的文本。 */
  var SLASH_COMMANDS = [
    { name: 'new', aliases: 'clear', ico: '＋', hint: '新建会话', keywords: 'xinjian huihua', kind: 'action',
      run: function () { newSession(); } },
    { name: 'sessions', aliases: 'resume', ico: '💬', hint: '浏览并切换历史会话', keywords: 'huihua lishi', kind: 'action',
      run: function () {
        var toggle = $('#sessionsToggle');
        if (toggle && getComputedStyle(toggle).display !== 'none') toggle.click();
        var search = $('#sessSearch');
        if (search) search.focus();
      } },
    { name: 'model', aliases: '', ico: '🤖', hint: '切换当前会话模型', keywords: 'moxing', kind: 'action',
      run: function () { $('#modelBtn').click(); } },
    { name: 'permission', aliases: '', ico: '🛡️', hint: '选择权限模式', keywords: 'quanxian moshi', kind: 'action',
      run: function () { showPermissionModes(); } },
    { name: 'export', aliases: 'export-md', ico: '📤', hint: '导出会话 Markdown', keywords: 'daochu markdown', kind: 'action',
      run: function () { exportSessionMarkdown(); } },
    { name: 'help', aliases: 'h ?', ico: '⌨', hint: '打开命令面板', keywords: 'bangzhu mingling', kind: 'action',
      run: function () { cmdkShow(); } },
    { name: 'compact', aliases: '', ico: '🗜️', hint: '压缩上下文，可带提示：/compact <保留要点>', keywords: 'yasuo compact context shangxiawen', kind: 'action',
      run: function (args) {
        notifyUi('正在压缩上下文…');
        sessionAction('compact', args ? { instructions: args } : {}).then(function () {
          notifyUi('上下文已压缩', 'ok');
          return hydrateSession(state.sid, { replaceMessages: true });
        }).catch(function (e) { if (e.message !== 'no session') notifyUi('压缩失败: ' + e.message, 'error'); });
      } },
    { name: 'undo', aliases: '', ico: '↩️', hint: '撤销最近的提问：/undo [条数]', keywords: 'chexiao undo', kind: 'action',
      run: function (args) {
        var count = Math.max(1, parseInt(args, 10) || 1);
        sessionAction('undo', { count: count }).then(function () {
          notifyUi('已撤销 ' + count + ' 条提问', 'ok');
          return hydrateSession(state.sid, { replaceMessages: true });
        }).catch(function (e) { if (e.message !== 'no session') notifyUi('撤销失败: ' + e.message, 'error'); });
      } },
    { name: 'fork', aliases: '', ico: '🔀', hint: '分叉当前会话，保留完整历史', keywords: 'fench fork branch fenzhi', kind: 'action',
      run: function () {
        sessionAction('fork').then(function (s) {
          notifyUi('已分叉到新会话', 'ok');
          return loadSessions().then(function () { if (s && s.id) switchSession(s.id); });
        }).catch(function (e) { if (e.message !== 'no session') notifyUi('分叉失败: ' + e.message, 'error'); });
      } },
    { name: 'stop', aliases: '', ico: '■', hint: '停止当前回答', keywords: 'tingzhi stop abort', kind: 'action',
      run: function () { abort(); } },
    { name: 'tasks', aliases: 'task', ico: '☷', hint: '打开活动中心', keywords: 'renwu huodong task activity', kind: 'action',
      run: function () { openActivityCenter(); } },
    { name: 'goal', aliases: '', ico: '🎯', hint: '创建自主目标：/goal <目标>（发送给 Kimi）', keywords: 'mubiao', kind: 'prompt', takesArgs: true },
    { name: 'init', aliases: '', ico: '📄', hint: '分析代码库并生成 AGENTS.md（发送给 Kimi）', keywords: 'agents daimaku', kind: 'prompt' }
  ];

  var comp = {
    mode: null,        /* 'slash' | 'mention' | null */
    items: [],
    active: 0,
    tokenStart: 0,     /* 触发符(/ 或 @)在输入框中的下标 */
    query: '',
    seq: 0,            /* 请求序号,丢弃过期的 fs 响应 */
    timer: 0,
    loading: false,
    truncated: false,
    fsDown: false,     /* fs 接口不可用时不再反复尝试(换会话后重置) */
    sid: null
  };

  function compClose() {
    comp.mode = null;
    comp.items = [];
    comp.active = 0;
    comp.loading = false;
    comp.truncated = false;
    if (comp.timer) { clearTimeout(comp.timer); comp.timer = 0; }
    completePop.classList.remove('show');
    completePop.innerHTML = '';
    input.removeAttribute('aria-activedescendant');
  }

  /* 从光标位置向前解析触发词：仅行首 / 触发命令(前导空白视为普通文本,与 CLI 一致),
     空白后的 @ 触发文件引用;前置非空白字符(如邮箱)不触发。 */
  function compParse() {
    var pos = input.selectionStart;
    if (pos == null || input.selectionEnd !== pos) return null;
    var before = input.value.slice(0, pos);
    var slash = /^\/([\w:.-]*)$/.exec(before);
    if (slash) return { mode: 'slash', tokenStart: 0, query: slash[1] };
    var mention = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (mention) return { mode: 'mention', tokenStart: pos - mention[1].length - 1, query: mention[1] };
    return null;
  }

  function compSlashItems(query) {
    var q = query.toLowerCase();
    return SLASH_COMMANDS.filter(function (c) {
      if (!q) return true;
      var hay = (c.name + ' ' + c.aliases + ' ' + c.keywords + ' ' + c.hint).toLowerCase();
      return q.split(/\s+/).every(function (t) { return hay.indexOf(t) !== -1; });
    }).map(function (c) {
      return { slash: c, ico: c.ico, title: '/' + c.name, hint: c.hint };
    });
  }

  /* 直接键入 "/cmd 参数" 回车时的解析：精确匹配命令名/别名且非 prompt 类才接管,
     否则按普通消息发送(与 CLI “未匹配则作为消息”一致)。 */
  function slashCommandFromText(text) {
    var m = /^\/([\w:.-]+)(?:\s+([\s\S]+?))?\s*$/.exec(String(text || ''));
    if (!m) return null;
    var token = m[1].toLowerCase();
    var found = null;
    SLASH_COMMANDS.some(function (c) {
      var names = [c.name].concat(c.aliases ? c.aliases.split(' ') : []);
      if (names.indexOf(token) !== -1) { found = c; return true; }
      return false;
    });
    if (!found || found.kind === 'prompt') return null;
    return { cmd: found, args: (m[2] || '').trim() };
  }

  /* ---- 本地文件索引与模糊匹配 ----
     首个 @ 触发时后台经 fs:list 递归构建工作区索引(服务端遵循 .gitignore,
     不会遍历 node_modules 等),完成后 @ 补全完全走本地模糊匹配——输入即时过滤、
     无网络往返;构建中/构建失败/目录未遍历到时回退服务端 fs:list/fs:search。
     索引超过 TTL 后下次 @ 时后台重建。 */
  var FS_INDEX_TTL = 5 * 60 * 1000;
  var FS_INDEX_MAX_ENTRIES = 8000;   /* 条目上限,超出即停止遍历(未遍历目录下钻时回退服务端) */
  var FS_INDEX_MAX_REQUESTS = 400;   /* fs:list 请求上限 */
  var FS_INDEX_CONCURRENCY = 4;
  var fsIndex = { sid: null, state: 'idle', items: [], dirs: {}, builtAt: 0, seq: 0 };

  /* 子序列模糊打分：命中返回分数(越高越好),未命中返回 -1。
     连续匹配、词边界(开头 / . _ - 空格、驼峰)与靠前的起始位置加分,长文本略减分。 */
  function fuzzyScore(query, text) {
    if (!query) return 0;
    var q = query.toLowerCase();
    var t = text.toLowerCase();
    var ti = 0, score = 0, lastMatch = -2, firstMatch = -1;
    for (var qi = 0; qi < q.length; qi++) {
      var c = q.charAt(qi), found = -1;
      for (; ti < t.length; ti++) {
        if (t.charAt(ti) === c) { found = ti; ti++; break; }
      }
      if (found === -1) return -1;
      if (firstMatch === -1) firstMatch = found;
      score += 1;
      if (found === lastMatch + 1) score += 5;
      var prev = found > 0 ? text.charAt(found - 1) : '';
      var ch = text.charAt(found);
      if (found === 0 || prev === '/' || prev === '.' || prev === '_' || prev === '-' || prev === ' ') score += 4;
      else if (prev >= 'a' && prev <= 'z' && ch >= 'A' && ch <= 'Z') score += 3;
      lastMatch = found;
    }
    score += Math.max(0, 6 - firstMatch);
    score -= text.length * 0.05;
    return score;
  }

  function fsIndexEnsure() {
    var sid = state.sid;
    if (!sid) return;
    if (fsIndex.sid !== sid) { fsIndexBuild(sid); return; }
    if (fsIndex.state === 'ready' && Date.now() - fsIndex.builtAt > FS_INDEX_TTL) fsIndexBuild(sid);
  }

  function fsIndexBuild(sid) {
    var seq = ++fsIndex.seq;
    fsIndex.sid = sid;
    fsIndex.state = 'building';
    var items = [], dirs = {};
    var queue = ['.'];
    var inFlight = 0, requests = 0, failed = false;
    function capped() { return requests >= FS_INDEX_MAX_REQUESTS || items.length >= FS_INDEX_MAX_ENTRIES; }
    function finish(ok) {
      if (seq !== fsIndex.seq) return;
      if (!ok) { fsIndex.state = 'failed'; return; }
      fsIndex.items = items;
      fsIndex.dirs = dirs;
      fsIndex.builtAt = Date.now();
      fsIndex.state = 'ready';
      /* 菜单若正停在“搜索中…”,索引就绪后立即用本地结果补一帧 */
      if (comp.mode === 'mention' && state.sid === sid && comp.loading) compMentionFetch(comp.query);
    }
    function pump() {
      if (seq !== fsIndex.seq || failed) return;
      while (inFlight < FS_INDEX_CONCURRENCY && queue.length && !capped()) {
        var dir = queue.shift();
        inFlight++; requests++;
        (function (d) {
          api('/sessions/' + encodeURIComponent(sid) + '/fs:list', {
            method: 'POST', body: JSON.stringify({ path: d })
          }).then(function (data) {
            var list = (data && data.items) || [];
            dirs[d] = list;
            list.forEach(function (it) {
              items.push(it);
              if (it.kind === 'directory') queue.push(it.path);
            });
          }).catch(function () {
            if (d === '.' && !items.length) { failed = true; return; }
            /* 非根目录失败按未遍历处理,下钻到它时回退服务端 */
          }).then(function () {
            inFlight--;
            if (failed) { finish(false); return; }
            if ((!queue.length || capped()) && inFlight === 0) { finish(true); return; }
            pump();
          });
        })(dir);
      }
      if ((!queue.length || capped()) && inFlight === 0 && !failed) finish(true);
    }
    pump();
  }

  /* 索引就绪时的本地查询:与服务端三分支(空查询列根目录/含 / 下钻/模糊搜索)对应。
     返回 {items,truncated};索引未就绪或目录未遍历时返回 null,交由服务端路径处理。 */
  function fsIndexQuery(query) {
    if (fsIndex.state !== 'ready' || fsIndex.sid !== state.sid) return null;
    var slashIdx = query.lastIndexOf('/');
    if (slashIdx >= 0) {
      var dir = query.slice(0, slashIdx) || '.';
      var children = fsIndex.dirs[dir];
      if (!children) {
        /* 目录不在索引里：父目录已遍历且其中没有该子目录 → 确认不存在,返回空结果;
           父目录未遍历(索引条目/请求达上限)→ 返回 null 回退服务端。 */
        var pSlash = dir.lastIndexOf('/');
        var pChildren = fsIndex.dirs[pSlash >= 0 ? dir.slice(0, pSlash) : '.'];
        var dirName = dir.slice(pSlash + 1);
        if (pChildren && !pChildren.some(function (it) {
          return it.kind === 'directory' && it.name === dirName;
        })) return { items: [], truncated: false };
        return null;
      }
      var prefix = query.slice(slashIdx + 1);
      var scored = [];
      children.forEach(function (it) {
        var s = fuzzyScore(prefix, it.name);
        if (s >= 0) scored.push({ it: it, s: s });
      });
      scored.sort(function (a, b) {
        if (b.s !== a.s) return b.s - a.s;
        var ad = a.it.kind === 'directory' ? 0 : 1, bd = b.it.kind === 'directory' ? 0 : 1;
        return ad - bd || (a.it.name < b.it.name ? -1 : a.it.name > b.it.name ? 1 : 0);
      });
      return { items: scored.map(function (x) { return x.it; }), truncated: false };
    }
    if (query === '') return { items: fsIndex.dirs['.'] || [], truncated: false };
    var hits = [];
    fsIndex.items.forEach(function (it) {
      var sn = fuzzyScore(query, it.name);
      var sp = fuzzyScore(query, it.path);
      if (sn < 0 && sp < 0) return;
      hits.push({ it: it, s: Math.max(sn + 8, sp) });   /* 文件名命中优先于路径命中 */
    });
    hits.sort(function (a, b) {
      return b.s - a.s || (a.it.path < b.it.path ? -1 : a.it.path > b.it.path ? 1 : 0);
    });
    var truncated = hits.length > 50;
    return { items: hits.slice(0, 50).map(function (x) { return x.it; }), truncated: truncated };
  }

  function mentionItem(it) {
    var isDir = it.kind === 'directory';
    return { mention: it, ico: isDir ? '📁' : '📄',
      title: isDir ? it.name + '/' : it.name,
      hint: it.path !== it.name ? it.path : (isDir ? '目录' : '文件') };
  }

  /* @ 文件补全：索引就绪时本地即时匹配(空查询列根目录/含 / 下钻/全局模糊);
     否则回退服务端——空查询/目录查询走 fs:list,含路径前缀的先列目录再按前缀过滤,
     其余走 fs:search 模糊匹配;目录条目选中后继续向下补全。 */
  function compMentionFetch(query) {
    var sid = state.sid;
    var seq = ++comp.seq;
    fsIndexEnsure();
    var local = fsIndexQuery(query);
    if (local) {
      comp.loading = false;
      comp.truncated = !!local.truncated;
      comp.items = local.items.map(mentionItem);
      if (comp.active >= comp.items.length) comp.active = 0;
      compRender();
      return;
    }
    comp.loading = true;
    compRender();
    var slashIdx = query.lastIndexOf('/');
    var req;
    if (slashIdx >= 0) {
      var dir = query.slice(0, slashIdx) || '.';
      var prefix = query.slice(slashIdx + 1).toLowerCase();
      req = api('/sessions/' + encodeURIComponent(sid) + '/fs:list', {
        method: 'POST', body: JSON.stringify({ path: dir })
      }).then(function (data) {
        var items = ((data && data.items) || []).filter(function (it) {
          return !prefix || it.name.toLowerCase().indexOf(prefix) === 0;
        });
        return { items: items };
      });
    } else if (query === '') {
      req = api('/sessions/' + encodeURIComponent(sid) + '/fs:list', {
        method: 'POST', body: JSON.stringify({ path: '.' })
      }).then(function (data) { return { items: (data && data.items) || [] }; });
    } else {
      req = api('/sessions/' + encodeURIComponent(sid) + '/fs:search', {
        method: 'POST', body: JSON.stringify({ query: query })
      }).then(function (data) {
        return { items: (data && data.items) || [], truncated: !!(data && data.truncated) };
      });
    }
    req.then(function (res) {
      if (seq !== comp.seq || comp.mode !== 'mention') return;
      comp.loading = false;
      comp.truncated = !!res.truncated;
      comp.items = res.items.map(mentionItem);
      if (comp.active >= comp.items.length) comp.active = 0;
      compRender();
    }).catch(function () {
      if (seq !== comp.seq) return;
      comp.fsDown = true;
      compClose();
    });
  }

  function compDetect() {
    if (comp.sid !== state.sid) { comp.sid = state.sid; comp.fsDown = false; }
    var parsed = compParse();
    if (!parsed || (parsed.mode === 'mention' && (comp.fsDown || !state.sid))) {
      if (comp.mode) compClose();
      return;
    }
    var wasClosed = !comp.mode;
    var queryChanged = parsed.mode !== comp.mode || parsed.query !== comp.query ||
      parsed.tokenStart !== comp.tokenStart;
    comp.mode = parsed.mode;
    comp.tokenStart = parsed.tokenStart;
    if (wasClosed) closeAllPopups(completePop);
    if (parsed.mode === 'slash') {
      comp.query = parsed.query;
      comp.items = compSlashItems(parsed.query);
      if (queryChanged) comp.active = 0;
      if (comp.active >= comp.items.length) comp.active = 0;
      compRender();
      return;
    }
    if (!queryChanged) { compRender(); return; }
    comp.query = parsed.query;
    comp.active = 0;
    if (comp.timer) clearTimeout(comp.timer);
    comp.timer = setTimeout(function () {
      comp.timer = 0;
      if (comp.mode === 'mention') compMentionFetch(comp.query);
    }, 120);
    comp.loading = true;
    comp.items = [];
    compRender();
  }

  function compRender() {
    if (!comp.mode) return;
    completePop.innerHTML = '';
    if (!comp.items.length) {
      var empty = document.createElement('div');
      empty.className = 'cmdk-empty';
      empty.textContent = comp.loading ? '搜索中…' :
        (comp.mode === 'slash' ? '没有匹配的命令，Enter 将作为消息发送' : '没有匹配的文件');
      completePop.appendChild(empty);
    } else {
      comp.items.forEach(function (item, idx) {
        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'cmdk-item' + (idx === comp.active ? ' cmdk-active' : '');
        el.id = 'compItem-' + idx;
        el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', idx === comp.active ? 'true' : 'false');
        el.innerHTML =
          '<span class="cmdk-item-ico" aria-hidden="true">' + esc(item.ico || '•') + '</span>' +
          '<span class="cmdk-item-body"><span class="cmdk-item-title">' + esc(item.title) + '</span>' +
          /* 提示行恒在(空则占位),保证所有候选行高一致、图标纵向对齐 */
          '<span class="cmdk-item-hint">' + (item.hint ? esc(item.hint) : ' ') + '</span></span>';
        /* mousedown 阻止默认行为,焦点始终留在输入框以保留键盘导航 */
        el.addEventListener('mousedown', function (e) { e.preventDefault(); });
        el.addEventListener('click', function () { compApply(idx); });
        el.addEventListener('mousemove', function () {
          if (comp.active === idx) return;
          comp.active = idx;
          compSyncActive();
        });
        completePop.appendChild(el);
      });
      if (comp.truncated) {
        var more = document.createElement('div');
        more.className = 'cmdk-empty';
        more.textContent = '结果过多，继续输入以缩小范围';
        completePop.appendChild(more);
      }
      compSyncActive();
    }
    completePop.classList.add('show');
  }

  function compSyncActive() {
    var els = completePop.querySelectorAll('.cmdk-item');
    els.forEach(function (el, i) {
      var on = i === comp.active;
      el.classList.toggle('cmdk-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        input.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function compMove(delta) {
    if (!comp.items.length) return;
    comp.active = (comp.active + delta + comp.items.length) % comp.items.length;
    compSyncActive();
  }

  function compApply(idx) {
    var item = comp.items[idx];
    if (!item) return;
    var pos = input.selectionStart;
    if (item.slash) {
      var cmd = item.slash;
      var rest = input.value.slice(pos);
      if (cmd.kind === 'action') {
        compClose();
        input.value = rest;   /* / 触发词必为行首,直接整段移除 */
        input.selectionStart = input.selectionEnd = 0;
        input.dispatchEvent(new Event('input'));
        input.focus();
        cmd.run('');
        return;
      }
      if (cmd.takesArgs) {
        input.value = '/' + cmd.name + ' ' + rest;
        var caret = cmd.name.length + 2;
        input.selectionStart = input.selectionEnd = caret;
        input.dispatchEvent(new Event('input'));
        input.focus();
        return;
      }
      compClose();
      input.value = '/' + cmd.name;
      send();
      return;
    }
    if (item.mention) {
      var it = item.mention;
      var insert = '@' + it.path + (it.kind === 'directory' ? '/' : ' ');
      input.value = input.value.slice(0, comp.tokenStart) + insert + input.value.slice(pos);
      input.selectionStart = input.selectionEnd = comp.tokenStart + insert.length;
      input.focus();
      /* 文件以空格收尾→菜单关闭;目录以 / 收尾→检测继续向下补全 */
      input.dispatchEvent(new Event('input'));
    }
  }

  /* 点击任何弹层及其触发按钮以外的地方时，统一关闭对应弹层。 */
  document.addEventListener('click', function (e) {
    popupSpecs().forEach(function (p) {
      if (!p.el || !p.el.classList.contains('show')) return;
      if (p.el.contains(e.target) || (p.trigger && p.trigger.contains(e.target))) return;
      closePopup(p.el);
    });
  });
