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

  /* ================= 消息收藏 ================= */

  function persistFavorites() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(state.favorites));
      return true;
    } catch (e) {
      return false;
    }
  }

  function syncFavoriteEntry() {
    var button = $('#favBtn');
    if (!button) return;
    var count = state.favorites.length;
    var countEl = $('#favCount');
    if (countEl) {
      countEl.textContent = String(count);
      countEl.hidden = !count;
    } else {
      button.textContent = '★ 收藏' + (count ? ' ' + count : '');
    }
    var label = count ? '打开收藏知识库，共 ' + count + ' 条收藏' : '打开收藏知识库';
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function commitFavorites() {
    var stored = persistFavorites();
    syncFavoriteEntry();
    return stored;
  }

  function favoriteOf(sid, mid) {
    sid = String(sid || '');
    mid = String(mid || '');
    for (var i = 0; i < state.favorites.length; i++) {
      var f = state.favorites[i];
      if (f.sid === sid && f.mid === mid) return f;
    }
    return null;
  }

  /* 会话列表每次刷新时，为旧收藏补上可得的标题/工作区，不影响服务端数据。 */
  function refreshFavoriteContext() {
    var changed = false;
    state.favorites.forEach(function (f) {
      var session = findSession(f.sid);
      if (!session) return;
      var cwd = session.metadata && session.metadata.cwd;
      if (cwd && !f.cwd) {
        f.cwd = cwd;
        changed = true;
      }
      if (session.title && !f.sessTitle) {
        f.sessTitle = session.title;
        changed = true;
      }
    });
    if (changed) commitFavorites();
  }

  function favoriteCwd(f) {
    var session = findSession(f.sid);
    return f.cwd || (session && session.metadata && session.metadata.cwd) || '';
  }

  function favoriteWorkspaceLabel(cwd) {
    cwd = String(cwd || '').replace(/\/+$/, '');
    if (!cwd) return '未记录工作区';
    var parts = cwd.split('/');
    return parts[parts.length - 1] || cwd;
  }

  /*
   * 当前列表通常只装载一个工作区，不能把“不在列表中”一律当成已归档。
   * 带来源 cwd 的收藏可直接切换工作区后跳转；只有当前范围内找不到时才提示不可用。
   */
  function favoriteLocation(f) {
    var session = findSession(f.sid);
    var cwd = favoriteCwd(f);
    if (session) return { kind: 'ready', cwd: cwd };
    var current = state.cwdFilter === undefined ? ENV.cwd : state.cwdFilter;
    if (cwd && current !== null && cwd !== current) return { kind: 'other-workspace', cwd: cwd };
    return { kind: 'unavailable', cwd: cwd };
  }

  function favoriteTimeLabel(ts) {
    if (!ts) return '时间未知';
    var d = new Date(ts);
    if (isNaN(d)) return '时间未知';
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (day === today) return '今天 ' + time;
    if (day === today - 86400000) return '昨天 ' + time;
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + time;
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time;
  }

  function syncFavoriteMessageAction(button, sid, mid) {
    var saved = !!favoriteOf(sid, mid);
    var label = saved ? '取消收藏此消息' : '收藏此消息到知识库';
    button.textContent = saved ? '★ 已收藏' : '☆ 收藏';
    button.classList.toggle('is-favorite', saved);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', saved ? 'true' : 'false');
  }

  /* 收藏/取消收藏当前会话的某条消息；返回切换后的收藏态。 */
  function toggleFavorite(mid) {
    var sid = state.sid;
    var existing = favoriteOf(sid, mid);
    if (existing) {
      var removed = existing;
      state.favorites = state.favorites.filter(function (f) { return f !== existing; });
      var removedStored = commitFavorites();
      notifyUi(removedStored ? '已取消收藏' : '取消收藏仅在本次打开期间生效', removedStored ? null : 'error', {
        label: '撤销',
        ariaLabel: '撤销取消收藏',
        run: function () {
          if (favoriteOf(removed.sid, removed.mid)) return;
          state.favorites.push(removed);
          var restored = commitFavorites();
          notifyUi(restored ? '已恢复收藏' : '收藏仅在本次打开期间恢复', restored ? 'ok' : 'error');
        }
      });
      return false;
    }
    var r = state.rendered[mid];
    if (!r || !r.text || !sid) return false;
    var session = findSession(sid);
    state.favorites.push({
      id: 'fav-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      sid: sid,
      mid: mid,
      role: r.role || 'assistant',
      text: r.text,
      promptText: r.promptText || '',
      sessTitle: (session && session.title) || chatTitle.textContent || '新会话',
      cwd: (session && session.metadata && session.metadata.cwd) || currentCwd() || '',
      ts: Date.now(),
      tags: [],
      note: ''
    });
    var addedStored = commitFavorites();
    notifyUi(addedStored ? '已收藏到知识库' : '收藏仅在本次打开期间可用', addedStored ? 'ok' : 'error', {
      label: '查看收藏',
      ariaLabel: '打开收藏知识库',
      run: function () { showFavorites(); }
    });
    return true;
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
      return b;
    }
    action('📋 复制', '复制此消息内容', function () {
      var cur = state.rendered[mid];
      copyText((cur && cur.text) || '', '已复制消息内容');
    });
    /* 星标态按 sid+mid 从收藏存储恢复，hydrate 重渲染后仍正确。 */
    var favBtn = action('☆ 收藏', '收藏此消息到知识库', function () {
      toggleFavorite(mid);
      syncFavoriteMessageAction(favBtn, state.sid, mid);
    });
    syncFavoriteMessageAction(favBtn, state.sid, mid);
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

  /* ================= 收藏知识库面板 ================= */

  /* 多词 AND 子串过滤，与 cmdkFilter 同一思路。 */
  function favoriteMatches(f, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return true;
    var hay = (f.text + ' ' + (f.promptText || '') + ' ' + (f.sessTitle || '') + ' ' +
      favoriteCwd(f) + ' ' + (f.tags || []).join(' ') + ' ' + (f.note || '')).toLowerCase();
    return q.split(/\s+/).every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function jumpToFavorite(f) {
    var location = favoriteLocation(f);
    if (location.kind === 'unavailable') {
      notifyUi('该会话已归档或已不可用，无法跳转', 'error');
      return;
    }
    /* 面板盖住目标消息时闪烁没有意义，跳转前先收起它。 */
    closePanel();
    var openSession;
    if (location.kind === 'other-workspace') {
      notifyUi('正在切换到工作区「' + favoriteWorkspaceLabel(location.cwd) + '」…');
      /* 先确认目标还存在，再切换范围；跳转一个失效收藏绝不能顺手创建新会话。 */
      openSession = api('/sessions').then(function (data) {
        var target = (data.items || []).filter(function (session) {
          return session.id === f.sid && !session.archived;
        })[0];
        if (!target) throw new Error('该会话已归档或不可用');
        var targetCwd = (target.metadata && target.metadata.cwd) || location.cwd;
        return activateWorkspace(targetCwd, { noCreate: true, silent: true });
      }).then(function () {
        if (!findSession(f.sid)) throw new Error('该会话已归档或不可用');
        return switchSession(f.sid);
      });
    } else {
      openSession = state.sid === f.sid ? Promise.resolve() : switchSession(f.sid);
    }
    openSession.then(function () {
      var r = state.rendered[f.mid];
      if (!r || !r.el || !r.el.isConnected) {
        notifyUi('这条消息已不在会话中', 'error');
        return;
      }
      r.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      r.el.classList.add('msg-flash');
      setTimeout(function () { r.el.classList.remove('msg-flash'); }, 1800);
    }).catch(function (e) {
      notifyUi('无法跳转：' + (e && e.message ? e.message : '会话不可用'), 'error');
    });
  }

  function favoritesMarkdown(items) {
    var lines = ['# 收藏知识库', '', '> 导出自 Kimi 2007 · ' + new Date().toLocaleString(), ''];
    var bySession = {};
    var order = [];
    items.forEach(function (f) {
      /* 标题可重复，按 sid 分组才不会把不同会话揉进同一个章节。 */
      var key = f.sid;
      if (!bySession[key]) {
        bySession[key] = {
          title: f.sessTitle || '新会话',
          cwd: favoriteCwd(f),
          items: []
        };
        order.push(key);
      }
      bySession[key].items.push(f);
    });
    order.forEach(function (key) {
      var group = bySession[key];
      lines.push('## ' + group.title, '');
      if (group.cwd) lines.push('> 工作区：' + group.cwd, '');
      group.items.forEach(function (f) {
        var role = f.role === 'user' ? 'Kimi 用户' : 'Kimi 小月';
        lines.push('### ' + role + ' · ' + (fullLocalTime(f.ts) || favoriteTimeLabel(f.ts)), '', f.text, '');
        if (f.tags && f.tags.length) lines.push('标签：' + f.tags.join('、'), '');
        if (f.note) lines.push('笔记：' + f.note, '');
      });
    });
    return lines.join('\n');
  }

  function favoriteViewFrom(input) {
    var source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    var expanded = {};
    Object.keys(source.expanded || {}).forEach(function (id) { if (source.expanded[id]) expanded[id] = true; });
    var sort = source.sort || state.favoriteSort;
    if (['newest', 'oldest', 'session'].indexOf(sort) === -1) sort = 'newest';
    return {
      query: typeof input === 'string' ? input : String(source.query || ''),
      sid: String(source.sid || ''),
      cwd: String(source.cwd || ''),
      tag: source.tag || null,
      sort: sort,
      expanded: expanded,
      editingNote: source.editingNote || ''
    };
  }

  function showFavorites(input) {
    var view = favoriteViewFrom(input);
    var body = openPanel('★ 收藏知识库');
    var generation = panelGen;
    $('#panel').classList.add('favorites-panel');
    body.innerHTML =
      '<section class="favorites-library" aria-label="收藏知识库">' +
      '<div class="fav-overview">' +
      '<div><div class="fav-overview-title">收藏知识库</div><div class="fav-overview-meta" aria-live="polite"></div></div>' +
      '<button class="ap-btn fav-current" type="button">当前会话</button></div>' +
      '<label class="fav-search-wrap"><span>查找</span>' +
      '<input type="search" class="fav-search" autocomplete="off" spellcheck="false" placeholder="内容、笔记、会话、标签或工作区" aria-label="搜索收藏"></label>' +
      '<div class="fav-filter-grid">' +
      '<label class="fav-field"><span>会话</span><select class="fav-sess"></select></label>' +
      '<label class="fav-field"><span>工作区</span><select class="fav-workspace"></select></label>' +
      '<label class="fav-field"><span>排序</span><select class="fav-sort"><option value="newest">最近收藏</option><option value="oldest">最早收藏</option><option value="session">按会话</option></select></label>' +
      '</div>' +
      '<div class="fav-tags-row" hidden><span>标签</span><span class="fav-tags"></span></div>' +
      '<div class="fav-active-filters" hidden></div>' +
      '<div class="p-actions fav-ops">' +
      '<button class="ap-btn" id="favCopy" type="button">复制收藏</button>' +
      '<button class="ap-btn" id="favExport" type="button">导出 .md</button></div>' +
      '<div class="fav-list"></div></section>';
    var searchEl = body.querySelector('.fav-search');
    var sessSel = body.querySelector('.fav-sess');
    var workspaceSel = body.querySelector('.fav-workspace');
    var sortSel = body.querySelector('.fav-sort');
    var tagsBox = body.querySelector('.fav-tags');
    var tagsRow = body.querySelector('.fav-tags-row');
    var activeFilters = body.querySelector('.fav-active-filters');
    var overviewMeta = body.querySelector('.fav-overview-meta');
    var currentBtn = body.querySelector('.fav-current');
    var copyBtn = body.querySelector('#favCopy');
    var exportBtn = body.querySelector('#favExport');
    var listEl = body.querySelector('.fav-list');
    searchEl.value = view.query;
    sortSel.value = view.sort;

    function filtered() {
      return state.favorites.filter(function (f) {
        if (view.sid && f.sid !== view.sid) return false;
        if (view.cwd && favoriteCwd(f) !== view.cwd) return false;
        if (view.tag && (f.tags || []).indexOf(view.tag) === -1) return false;
        return favoriteMatches(f, searchEl.value);
      }).slice().sort(function (a, b) {
        if (view.sort === 'oldest') return (a.ts || 0) - (b.ts || 0);
        if (view.sort === 'session') {
          var byTitle = String(a.sessTitle || '').localeCompare(String(b.sessTitle || ''), 'zh-CN');
          return byTitle || (b.ts || 0) - (a.ts || 0);
        }
        return (b.ts || 0) - (a.ts || 0);
      });
    }

    function renderFilters() {
      var seen = {};
      var sessions = [];
      sessSel.innerHTML = '<option value="">全部会话</option>';
      state.favorites.forEach(function (f) {
        if (seen[f.sid]) return;
        seen[f.sid] = true;
        sessions.push(f);
      });
      sessions.sort(function (a, b) {
        return String(a.sessTitle || '').localeCompare(String(b.sessTitle || ''), 'zh-CN');
      });
      sessions.forEach(function (f) {
        var location = favoriteLocation(f);
        var opt = document.createElement('option');
        opt.value = f.sid;
        opt.textContent = (f.sessTitle || '新会话') +
          (location.kind === 'other-workspace' ? '（其他工作区）' :
            location.kind === 'unavailable' ? '（不可用）' : '');
        sessSel.appendChild(opt);
      });
      if (view.sid && !seen[view.sid]) view.sid = '';
      sessSel.value = view.sid;

      var workspaces = {};
      state.favorites.forEach(function (f) {
        var cwd = favoriteCwd(f);
        if (!cwd) return;
        if (!workspaces[cwd]) workspaces[cwd] = 0;
        workspaces[cwd]++;
      });
      workspaceSel.innerHTML = '<option value="">全部工作区</option>';
      Object.keys(workspaces).sort(function (a, b) {
        return favoriteWorkspaceLabel(a).localeCompare(favoriteWorkspaceLabel(b), 'zh-CN');
      }).forEach(function (cwd) {
        var opt = document.createElement('option');
        opt.value = cwd;
        opt.textContent = favoriteWorkspaceLabel(cwd) + '（' + workspaces[cwd] + '）';
        opt.title = cwd;
        workspaceSel.appendChild(opt);
      });
      if (view.cwd && !workspaces[view.cwd]) view.cwd = '';
      workspaceSel.value = view.cwd;

      var tags = {};
      state.favorites.forEach(function (f) {
        (f.tags || []).forEach(function (tag) { tags[tag] = (tags[tag] || 0) + 1; });
      });
      if (view.tag && !tags[view.tag]) view.tag = null;
      tagsBox.innerHTML = '';
      Object.keys(tags).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); }).forEach(function (tag) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tag-chip' + (view.tag === tag ? ' on' : '');
        chip.textContent = tag + ' ' + tags[tag];
        chip.title = '按标签「' + tag + '」过滤';
        chip.setAttribute('aria-pressed', view.tag === tag ? 'true' : 'false');
        chip.addEventListener('click', function () {
          view.tag = view.tag === tag ? null : tag;
          renderList();
        });
        tagsBox.appendChild(chip);
      });
      tagsRow.hidden = !Object.keys(tags).length;

      currentBtn.disabled = !state.sid;
      currentBtn.classList.toggle('is-active', view.sid === state.sid && !!state.sid);
      currentBtn.setAttribute('aria-pressed', view.sid === state.sid && state.sid ? 'true' : 'false');
      currentBtn.textContent = view.sid === state.sid && state.sid ? '已筛选当前会话' : '当前会话';
    }

    function renderActiveFilters(items) {
      var active = [];
      if (view.query.trim()) active.push('搜索：“' + view.query.trim() + '”');
      if (view.sid) {
        var session = state.favorites.filter(function (f) { return f.sid === view.sid; })[0];
        active.push('会话：' + ((session && session.sessTitle) || '新会话'));
      }
      if (view.cwd) active.push('工作区：' + favoriteWorkspaceLabel(view.cwd));
      if (view.tag) active.push('标签：' + view.tag);
      activeFilters.innerHTML = '';
      activeFilters.hidden = !active.length;
      if (active.length) {
        var text = document.createElement('span');
        text.textContent = '已筛选 ' + active.join(' · ') + '，显示 ' + items.length + ' 条';
        var clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'fav-filter-clear';
        clear.textContent = '清除筛选';
        clear.setAttribute('aria-label', '清除全部收藏筛选');
        clear.addEventListener('click', function () {
          view.query = '';
          view.sid = '';
          view.cwd = '';
          view.tag = null;
          searchEl.value = '';
          renderList();
          searchEl.focus();
        });
        activeFilters.appendChild(text);
        activeFilters.appendChild(clear);
      }
    }

    function renderSummary(items) {
      var sessions = {};
      state.favorites.forEach(function (f) { sessions[f.sid] = true; });
      overviewMeta.textContent = state.favorites.length ?
        state.favorites.length + ' 条收藏 · ' + Object.keys(sessions).length + ' 个会话 · 当前显示 ' + items.length + ' 条' :
        '把重要的消息留在这里，方便回顾和复用。';
      copyBtn.disabled = !items.length;
      exportBtn.disabled = !items.length;
      copyBtn.textContent = items.length ? '复制 ' + items.length + ' 条' : '复制收藏';
      exportBtn.textContent = items.length ? '导出 ' + items.length + ' 条 .md' : '导出 .md';
    }

    function renderList() {
      renderFilters();
      var items = filtered();
      renderSummary(items);
      renderActiveFilters(items);
      listEl.innerHTML = '';
      if (!items.length) {
        var empty = document.createElement('div');
        empty.className = 'p-empty fav-empty';
        if (state.favorites.length) {
          empty.innerHTML = '<strong>没有匹配的收藏</strong><span>试试调整关键词、标签或范围。</span>';
        } else {
          empty.innerHTML = '<strong>还没有收藏</strong><span>在消息右上角点“☆ 收藏”，重要内容会保存在这里。</span>';
        }
        listEl.appendChild(empty);
        return;
      }
      items.forEach(function (f) {
        var location = favoriteLocation(f);
        var unavailable = location.kind === 'unavailable';
        var card = document.createElement('div');
        card.className = 'fav-card';
        var role = f.role === 'user' ? 'Kimi 用户' : 'Kimi 小月';
        var fullText = String(f.text || '');
        var longText = fullText.length > 260;
        var expanded = !!view.expanded[f.id];
        var excerpt = longText && !expanded ? fullText.slice(0, 260) + '…' : fullText;
        var tagsHtml = (f.tags || []).map(function (t) {
          return '<button class="tag-chip fav-card-tag" type="button" title="按标签「' + esc(t) + '」筛选">' + esc(t) + '</button>';
        }).join('');
        var cwd = favoriteCwd(f);
        var noteHtml = '';
        if (view.editingNote === f.id) {
          noteHtml =
            '<div class="fav-note fav-note-edit">' +
            '<label>笔记<textarea class="fav-note-editor" maxlength="4000" placeholder="写下为什么要收藏，或下次如何使用…"></textarea></label>' +
            '<div><button class="ap-btn fav-note-save" type="button">保存笔记</button>' +
            '<button class="ap-btn fav-note-cancel" type="button">取消</button></div></div>';
        } else if (f.note) {
          noteHtml = '<div class="fav-note"><strong>笔记</strong><div>' + esc(f.note) + '</div></div>';
        }
        card.innerHTML =
          '<div class="fav-card-head"><strong>' + esc(role) + '</strong>' +
          '<span class="fav-card-session" title="' + esc(f.sessTitle || '新会话') + '">' + esc(f.sessTitle || '新会话') + '</span>' +
          (location.kind === 'other-workspace' ? '<span class="p-badge fav-other-workspace">其他工作区</span>' : '') +
          (unavailable ? '<span class="p-badge muted">会话不可用</span>' : '') +
          '<time class="fav-card-time" title="' + esc(fullLocalTime(f.ts)) + '">' + esc(favoriteTimeLabel(f.ts)) + '</time></div>' +
          (cwd ? '<div class="fav-card-source" title="' + esc(cwd) + '">工作区 · ' + esc(favoriteWorkspaceLabel(cwd)) + '</div>' : '') +
          '<div class="fav-card-text">' + esc(excerpt || '（消息内容为空）') + '</div>' +
          (longText ? '<button class="fav-expand" type="button" aria-expanded="' + (expanded ? 'true' : 'false') + '">' + (expanded ? '收起全文' : '展开全文') + '</button>' : '') +
          (tagsHtml ? '<div class="fav-card-tags">' + tagsHtml + '</div>' : '') +
          noteHtml +
          '<div class="p-actions fav-card-ops">' +
          '<button class="ap-btn fav-jump" type="button"' + (unavailable ? ' disabled title="会话已归档或不可用，无法跳转"' : '') + '>跳转</button>' +
          '<button class="ap-btn fav-copy" type="button">复制</button>' +
          '<button class="ap-btn fav-note-btn" type="button">' + (f.note ? '编辑笔记' : '添加笔记') + '</button>' +
          '<button class="ap-btn fav-tagbtn" type="button">标签</button>' +
          '<button class="ap-btn no fav-del" type="button">取消收藏</button></div>';
        if (!unavailable) {
          card.querySelector('.fav-jump').addEventListener('click', function () { jumpToFavorite(f); });
        }
        card.querySelector('.fav-copy').addEventListener('click', function () {
          copyText(f.text || '', '已复制收藏内容');
        });
        var expand = card.querySelector('.fav-expand');
        if (expand) {
          expand.addEventListener('click', function () {
            if (view.expanded[f.id]) delete view.expanded[f.id];
            else view.expanded[f.id] = true;
            renderList();
          });
        }
        $$('.fav-card-tag', card).forEach(function (tagButton) {
          tagButton.addEventListener('click', function () {
            view.tag = tagButton.textContent;
            renderList();
          });
        });
        card.querySelector('.fav-note-btn').addEventListener('click', function () {
          view.editingNote = f.id;
          renderList();
          requestAnimationFrame(function () {
            var editor = body.querySelector('.fav-note-editor');
            if (editor) {
              editor.value = f.note || '';
              editor.focus();
              editor.setSelectionRange(editor.value.length, editor.value.length);
            }
          });
        });
        var noteSave = card.querySelector('.fav-note-save');
        if (noteSave) {
          noteSave.addEventListener('click', function () {
            var editor = card.querySelector('.fav-note-editor');
            f.note = editor ? editor.value.trim() : '';
            view.editingNote = '';
            var noteStored = commitFavorites();
            renderList();
            notifyUi(noteStored ? (f.note ? '收藏笔记已保存' : '已清除收藏笔记') :
              '笔记仅在本次打开期间可用', noteStored ? 'ok' : 'error');
          });
          card.querySelector('.fav-note-cancel').addEventListener('click', function () {
            view.editingNote = '';
            renderList();
          });
        }
        card.querySelector('.fav-tagbtn').addEventListener('click', function () {
          showTagEditor('收藏标签', f.tags || [], function (tags) {
            f.tags = tags;
            var tagsStored = commitFavorites();
            /* 标签编辑面板盖在收藏面板之上；保存后恢复完整筛选，而不只恢复搜索词。 */
            showFavorites(view);
            notifyUi(tagsStored ? '收藏标签已保存' : '标签仅在本次打开期间可用', tagsStored ? 'ok' : 'error');
          });
        });
        card.querySelector('.fav-del').addEventListener('click', function () {
          var removed = f;
          state.favorites = state.favorites.filter(function (item) { return item !== f; });
          delete view.expanded[f.id];
          view.editingNote = '';
          var deletedStored = commitFavorites();
          renderList();
          notifyUi(deletedStored ? '已取消收藏' : '取消收藏仅在本次打开期间生效', deletedStored ? null : 'error', {
            label: '撤销',
            ariaLabel: '撤销取消收藏',
            run: function () {
              if (favoriteOf(removed.sid, removed.mid)) return;
              state.favorites.push(removed);
              var restored = commitFavorites();
              if (panelIsCurrent(body, generation)) renderList();
              notifyUi(restored ? '已恢复收藏' : '收藏仅在本次打开期间恢复', restored ? 'ok' : 'error');
            }
          });
        });
        listEl.appendChild(card);
      });
    }

    searchEl.addEventListener('input', function () {
      view.query = searchEl.value;
      renderList();
    });
    sessSel.addEventListener('change', function () {
      view.sid = sessSel.value;
      renderList();
    });
    workspaceSel.addEventListener('change', function () {
      view.cwd = workspaceSel.value;
      renderList();
    });
    sortSel.addEventListener('change', function () {
      view.sort = sortSel.value;
      state.favoriteSort = view.sort;
      try { localStorage.setItem(FAV_SORT_KEY, view.sort); } catch (e) { /* 排序偏好仅保存在内存 */ }
      renderList();
    });
    currentBtn.addEventListener('click', function () {
      if (!state.sid) return;
      view.sid = view.sid === state.sid ? '' : state.sid;
      renderList();
    });
    copyBtn.addEventListener('click', function () {
      var items = filtered();
      if (!items.length) {
        notifyUi('没有可复制的收藏', 'error');
        return;
      }
      copyText(favoritesMarkdown(items), '已复制收藏知识库');
    });
    exportBtn.addEventListener('click', function () {
      var items = filtered();
      if (!items.length) {
        notifyUi('没有可导出的收藏', 'error');
        return;
      }
      downloadText(favoritesMarkdown(items), 'kimi-favorites.md');
    });
    renderList();
    requestAnimationFrame(function () {
      if (panelIsCurrent(body, generation)) searchEl.focus();
    });
  }
