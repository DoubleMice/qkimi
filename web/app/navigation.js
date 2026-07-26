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

  /* 会话分组选择与收藏面板入口 */
  var sessGroupSel = $('#sessGroupSel');
  if (sessGroupSel) {
    sessGroupSel.value = state.sessGroup;
    sessGroupSel.addEventListener('change', function () {
      setSessGroup(sessGroupSel.value);
    });
  }
  var favBtnEl = $('#favBtn');
  if (favBtnEl) {
    favBtnEl.addEventListener('click', function () { showFavorites(); });
    syncFavoriteEntry();
  }
  var chatTagBtn = $('#chatTagBtn');
  if (chatTagBtn) {
    chatTagBtn.addEventListener('click', function () { showSessionTags(state.sid); });
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
