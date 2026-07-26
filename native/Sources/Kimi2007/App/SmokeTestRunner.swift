import Foundation
import WebKit

/// 原生 WebView 的端到端冒烟入口；与应用生命周期分离，避免 AppDelegate 持有大段注入脚本。
@MainActor
enum SmokeTestRunner {
  static func run(webView: WKWebView, resultPath: String, finish: @escaping () -> Void) {
    let script = #"""
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && !document.querySelector('#connStatus')?.textContent.includes('已连接')) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const waitFor = async (predicate, timeout = 6000) => {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
          if (predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return Boolean(predicate());
      };
      const runtime = await window.KimiDesktop.getRuntimeEnv();
      var upload = { skipped: true };
      var permissionSwitch = { skipped: true };
      document.querySelector('#permissionInfo')?.click();
      const permissionUi = {
        opened: !document.querySelector('#panel')?.hidden,
        modes: Array.from(document.querySelectorAll('.p-permission-option')).map((button) => button.dataset.mode)
      };
      document.querySelector('#panelClose')?.click();
      document.querySelector('#modelBtn')?.click();
      const modelMenuLoaded = await waitFor(() => document.querySelectorAll('#modelMenu button[data-model]').length > 0);
      const modelMenu = {
        loaded: modelMenuLoaded,
        optionCount: document.querySelectorAll('#modelMenu button[data-model]').length,
        selectedCount: document.querySelectorAll('#modelMenu [aria-checked="true"]').length
      };
      document.querySelector('#modelBtn')?.click();
      document.querySelector('#slPlugins')?.click();
      const toolsPanelLoaded = await waitFor(() => document.querySelector('#panelBody')?.textContent.includes('MCP'));
      const toolsPanel = {
        loaded: toolsPanelLoaded,
        title: document.querySelector('#panelTitle')?.textContent,
        hasProviderStatus: document.querySelector('#panelBody')?.textContent.includes('服务商状态') || false,
        failureVisible: false
      };
      document.querySelector('#panelClose')?.click();
      const healthFetch = window.fetch.bind(window);
      window.fetch = (url, options) => String(url).includes('/api/v1/mcp/servers')
        ? Promise.resolve(new Response(JSON.stringify({ code: 503, msg: 'MCP unavailable', data: null }), {
            status: 503, headers: { 'Content-Type': 'application/json' }
          }))
        : healthFetch(url, options);
      document.querySelector('#slPlugins')?.click();
      toolsPanel.failureVisible = await waitFor(() =>
        document.querySelector('#panelBody .p-health-error')?.textContent.includes('MCP unavailable') || false
      );
      document.querySelector('#panelClose')?.click();
      window.fetch = healthFetch;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
      const cmdkOpened = await waitFor(() => document.querySelector('#cmdk') && !document.querySelector('#cmdk').hidden);
      const cmdkFocused = document.activeElement === document.querySelector('#cmdkInput');
      const cmdkHasItems = document.querySelectorAll('#cmdkList .cmdk-item').length > 0;
      const cmdkInputEl = document.querySelector('#cmdkInput');
      if (cmdkInputEl) {
        cmdkInputEl.value = '新建';
        cmdkInputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const cmdkFiltered = await waitFor(() => {
        const items = document.querySelectorAll('#cmdkList .cmdk-item');
        return items.length > 0 && Array.from(items).every((el) => el.textContent.includes('新建'));
      });
      document.querySelector('#cmdkInput')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const cmdkClosed = await waitFor(() => document.querySelector('#cmdk')?.hidden === true);
      const keyboard = {
        commandPalette: cmdkOpened === true && cmdkFocused === true && cmdkHasItems === true &&
          cmdkFiltered === true && cmdkClosed === true,
        sessionButtons: document.querySelectorAll('#sessList .sess-open').length,
        archiveButtons: document.querySelectorAll('#sessList .sess-del').length,
        workspaceButtons: 0,
        workspaceSemantics: false
      };
      document.querySelector('#slSites')?.click();
      await waitFor(() => document.querySelectorAll('#panelBody .p-ws').length > 0);
      keyboard.workspaceButtons = document.querySelectorAll('#panelBody button.p-ws').length;
      keyboard.workspaceSemantics = Array.from(document.querySelectorAll('#panelBody .p-ws')).every((item) =>
        item.tagName === 'BUTTON' && item.hasAttribute('aria-pressed')
      );
      /* 多工作区：每个工作区行都有「新窗口打开」按钮（「全部工作区」行除外）。 */
      const wsOpenButtons = document.querySelectorAll('#panelBody .p-ws-open').length;
      document.querySelector('#panelClose')?.click();
      /* 多工作区：桥接 API 存在；会话列表可按工作区分组。 */
      const wsGroupSel = document.querySelector('#sessGroupSel');
      wsGroupSel.value = 'workspace';
      wsGroupSel.dispatchEvent(new Event('change', { bubbles: true }));
      const wsGroupRendered = await waitFor(() =>
        document.querySelectorAll('#sessList .sess-group .sess-ws-chip').length > 0);
      wsGroupSel.value = 'time';
      wsGroupSel.dispatchEvent(new Event('change', { bubbles: true }));
      const multiWorkspace = {
        bridgeApi: typeof window.KimiDesktop.openWorkspaceWindow === 'function',
        openButtons: wsOpenButtons,
        groupRendered: wsGroupRendered === true
      };
      /* / 命令与 @ 文件补全：打开→过滤→键盘导航→Esc 关闭全路径 */
      const compInput = document.querySelector('#input');
      const compPop = document.querySelector('#completePop');
      const compSetValue = (v) => {
        compInput.value = v;
        compInput.setSelectionRange(v.length, v.length);
        compInput.dispatchEvent(new Event('input', { bubbles: true }));
      };
      compInput.focus();
      compSetValue('/');
      const compSlashOpened = await waitFor(() =>
        compPop?.classList.contains('show') && compPop.querySelectorAll('.cmdk-item').length > 0);
      const compSlashFullCount = compPop?.querySelectorAll('.cmdk-item').length || 0;
      const compSlashTitles = Array.from(compPop?.querySelectorAll('.cmdk-item-title') || [])
        .map((el) => el.textContent);
      const compSlashHasServerCmds = ['/compact', '/undo', '/fork'].every((t) => compSlashTitles.includes(t));
      compSetValue('/mo');
      const compSlashFiltered = await waitFor(() => {
        const items = compPop?.querySelectorAll('.cmdk-item') || [];
        return items.length > 0 && items.length < compSlashFullCount &&
          Array.from(items).some((el) => el.textContent.includes('/model'));
      });
      compInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      const compNav = await waitFor(() =>
        compPop?.querySelectorAll('.cmdk-item.cmdk-active').length === 1);
      compInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const compSlashClosed = await waitFor(() => !compPop?.classList.contains('show'));
      const compMentionSkipped = !window.__kimi2007?.sid;
      let compMentionLoaded = true;
      let compMentionClosed = true;
      if (!compMentionSkipped) {
        compSetValue('@');
        compMentionLoaded = await waitFor(() => compPop?.querySelectorAll('.cmdk-item').length > 0, 9000);
        compInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        compMentionClosed = await waitFor(() => !compPop?.classList.contains('show'));
      }
      compSetValue('');
      const completion = {
        slashOpened: compSlashOpened === true,
        slashFiltered: compSlashFiltered === true,
        slashHasServerCmds: compSlashHasServerCmds === true,
        keyboardNav: compNav === true,
        slashClosed: compSlashClosed === true,
        mentionSkipped: compMentionSkipped,
        mentionLoaded: compMentionSkipped ? true : compMentionLoaded === true,
        mentionClosed: compMentionSkipped ? true : compMentionClosed === true
      };
      const activityCenter = {
        present: Boolean(document.querySelector('#activityPanel')),
        state: document.querySelector('#activityState')?.textContent,
        sections: document.querySelectorAll('#activityPanel .activity-section').length,
        hasStaticFoldControl: Boolean(document.querySelector('#srFold'))
      };
      const narrowLayout = {
        enabled: matchMedia('(max-width: 840px)').matches,
        viewport: [innerWidth, innerHeight],
        chatWidth: document.querySelector('.chat')?.getBoundingClientRect().width,
        scrollWidth: document.documentElement.scrollWidth,
        mobileControls: Array.from(document.querySelectorAll('.chat-mobile-btn')).map((button) => ({
          id: button.id,
          display: getComputedStyle(button).display
        }))
      };
      if (narrowLayout.enabled) {
        document.querySelector('#mobileBackdrop')?.click();
        document.querySelector('#sessionsToggle')?.click();
        await new Promise((resolve) => setTimeout(resolve, 260));
        narrowLayout.sessionsDrawer = document.querySelector('.side-left')?.classList.contains('mobile-open') || false;
        narrowLayout.backdropAfterSessions = !document.querySelector('#mobileBackdrop')?.hidden;
        document.querySelector('#mobileBackdrop')?.click();
        document.querySelector('#activityToggle')?.click();
        await new Promise((resolve) => setTimeout(resolve, 260));
        narrowLayout.activityDrawer = document.querySelector('.side-right')?.classList.contains('mobile-open') || false;
        narrowLayout.backdropAfterActivity = !document.querySelector('#mobileBackdrop')?.hidden;
        document.querySelector('#mobileBackdrop')?.click();
        narrowLayout.drawersClosed = !document.querySelector('.side-left')?.classList.contains('mobile-open') &&
          !document.querySelector('.side-right')?.classList.contains('mobile-open');
      }
      var orphanCleanup = { supported: false, passed: false };
      /* 代码宠物：插画资源、画布分辨率、限时回退、摸头成长、养成数值与旁侧互动按钮 */
      const petAreaEl = document.querySelector('#petArea');
      const petCanvasEl = document.querySelector('#petCanvas');
      const petHook = window.__kimi2007?.pet;
      const pet = {
        areaPresent: Boolean(petAreaEl),
        canvasPresent: Boolean(petCanvasEl),
        canvasDpr: Boolean(petCanvasEl) && petCanvasEl.width >= 48 && petCanvasEl.height >= 56,
        hookPresent: Boolean(petHook),
        spriteLoaded: false,
        modeSet: false,
        revertToIdle: false,
        expIsNumber: false,
        patReacted: false,
        statsIsObj: false,
        feedRaised: false,
        actionsPresent: false,
        actionWorks: false,
        actionValueSynced: false,
        rightClickSuppressed: false
      };
      if (petHook) {
        pet.spriteLoaded = await waitFor(() => petHook.spriteLoaded === true, 2000);
        petHook.set('happy');
        pet.modeSet = petHook.mode === 'happy';
        petHook.setDuration({ happy: 50 });
        petHook.set('happy');
        pet.revertToIdle = await waitFor(() => petHook.mode === 'idle', 2000);
        pet.expIsNumber = typeof petHook.exp === 'number';
        /* 养成数值：三值可读、喂食能恢复饥饿 */
        const st = petHook.stats;
        pet.statsIsObj = Boolean(st) && typeof st.hunger === 'number' &&
          typeof st.clean === 'number' && typeof st.mood === 'number';
        if (pet.statsIsObj && petHook.setStats && petHook.feed) {
          petHook.setStats({ hunger: 50 });
          const hungerBefore = petHook.stats.hunger;
          petHook.feed();
          pet.feedRaised = petHook.stats.hunger > hungerBefore;
          petHook.set('idle');
        }
        if (petAreaEl) {
          const expBefore = petHook.exp;
          const petRect = petAreaEl.getBoundingClientRect();
          const petX = petRect.left + petRect.width / 2;
          const petY = petRect.top + petRect.height / 2;
          petAreaEl.dispatchEvent(new PointerEvent('pointerdown', { clientX: petX, clientY: petY, bubbles: true, pointerId: 1 }));
          petAreaEl.dispatchEvent(new PointerEvent('pointerup', { clientX: petX, clientY: petY, bubbles: true, pointerId: 1 }));
          await new Promise((resolve) => setTimeout(resolve, 150));
          pet.patReacted = petHook.exp > expBefore ||
            document.querySelector('#petBubble')?.classList.contains('on') === true;
          /* 互动按钮常驻在宠物左侧；右键不会再打开菜单。 */
          pet.actionsPresent = document.querySelector('#petActions') !== null &&
            document.querySelectorAll('#petActions .pet-action').length === 4;
          const feedButton = document.querySelector('#petActionFeed');
          if (pet.actionsPresent && feedButton && petHook.setStats) {
            petHook.setStats({ hunger: 50 });
            const hungerBeforeAction = petHook.stats.hunger;
            feedButton.click();
            pet.actionWorks = petHook.stats.hunger > hungerBeforeAction;
            pet.actionValueSynced = document.querySelector('#petActionFeedValue')?.textContent ===
              String(Math.round(petHook.stats.hunger));
            petHook.set('idle');
          }
          const rightClick = new MouseEvent('contextmenu', { clientX: petX, clientY: petY, bubbles: true, cancelable: true });
          petAreaEl.dispatchEvent(rightClick);
          pet.rightClickSuppressed = rightClick.defaultPrevented === true && document.querySelector('#petMenu') === null;
        }
      }
      let delayedUploadFetch = null;
      try {
        delayedUploadFetch = window.fetch.bind(window);
        let orphanDeleted = false;
        window.fetch = (url, options = {}) => {
          const value = String(url);
          if (value.endsWith('/api/v1/files') && options.method === 'POST') {
            return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({
              code: 0, data: { id: 'qkimi-orphan-smoke', name: 'orphan-smoke.txt', media_type: 'text/plain', size: 6 }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })), 350));
          }
          if (value.endsWith('/api/v1/files/qkimi-orphan-smoke') && options.method === 'DELETE') {
            orphanDeleted = true;
            return Promise.resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
              status: 200, headers: { 'Content-Type': 'application/json' }
            }));
          }
          return delayedUploadFetch(url, options);
        };
        const transfer = new DataTransfer();
        transfer.items.add(new File(['orphan'], 'orphan-smoke.txt', { type: 'text/plain' }));
        const picker = document.querySelector('#fileAny');
        picker.files = transfer.files;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        const chipReady = await waitFor(() => Boolean(document.querySelector('#attachRow .attach-chip.uploading')));
        document.querySelector('#attachRow .attach-del')?.click();
        const deletedAfterResponse = await waitFor(() => orphanDeleted);
        orphanCleanup = { supported: true, chipReady: chipReady, passed: chipReady && deletedAfterResponse };
      } catch (error) {
        orphanCleanup = { supported: false, passed: false, error: String(error) };
      } finally {
        if (delayedUploadFetch) window.fetch = delayedUploadFetch;
      }
      if (performUpload) {
        const form = new FormData();
        form.append('file', new File(['native-wkwebview-smoke'], 'native-smoke.txt', { type: 'text/plain' }));
        const response = await fetch(runtime.base + '/api/v1/files', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + runtime.token },
          body: form
        });
        const payload = await response.json();
        const fileId = payload?.data?.id;
        let cleanupStatus = null;
        if (fileId) {
          cleanupStatus = await fetch(runtime.base + '/api/v1/files/' + encodeURIComponent(fileId), {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + runtime.token }
          }).then((cleanup) => cleanup.status);
        }
        upload = {
          skipped: false,
          httpStatus: response.status,
          apiCode: payload?.code,
          receivedId: Boolean(fileId),
          cleanupStatus: cleanupStatus
        };
      }
      if (performPermissionSwitch) {
        const headers = {
          Authorization: 'Bearer ' + runtime.token,
          'Content-Type': 'application/json'
        };
        const api = async (path, options = {}) => {
          const response = await fetch(runtime.base + '/api/v1' + path, {
            ...options,
            headers: { ...headers, ...(options.headers || {}) }
          });
          const payload = await response.json();
          if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || 'HTTP ' + response.status);
          return payload.data;
        };
        let sessionId = null;
        try {
          const created = await api('/sessions', {
            method: 'POST',
            body: JSON.stringify({
              title: '权限切换回归',
              metadata: { cwd: runtime.cwd },
              agent_config: { permission_mode: 'manual' }
            })
          });
          sessionId = created.id;
          const modelListing = await api('/models');
          const selectedModel = modelListing.items?.[0]?.model || null;
          if (selectedModel) {
            await api('/sessions/' + encodeURIComponent(sessionId) + '/profile', {
              method: 'POST', body: JSON.stringify({ agent_config: { model: selectedModel } })
            });
          }
          const uiState = window.__kimi2007;
          const originalSessionId = uiState.sid;
          uiState.sid = sessionId;
          uiState.sessionStatus[sessionId] = { permission: 'manual' };
          const choosePermission = async (mode) => {
            document.querySelector('#permissionInfo')?.click();
            const optionReady = await waitFor(() => Boolean(document.querySelector('.p-permission-option[data-mode="' + mode + '"]')));
            if (!optionReady) return false;
            document.querySelector('.p-permission-option[data-mode="' + mode + '"]')?.click();
            return await waitFor(() =>
              uiState.sessionStatus[sessionId]?.permission === mode &&
              document.querySelector('#panel')?.hidden
            );
          };
          const autoUiPassed = await choosePermission('auto');
          const autoStatus = await api('/sessions/' + encodeURIComponent(sessionId) + '/status');
          const manualUiPassed = await choosePermission('manual');
          const manualStatus = await api('/sessions/' + encodeURIComponent(sessionId) + '/status');
          document.querySelector('#permissionInfo')?.click();
          const advancedModes = Array.from(document.querySelectorAll('.p-permission-option')).map((button) => button.dataset.mode);
          document.querySelector('#panelClose')?.click();
          uiState.sid = originalSessionId;
          const normalizeModel = (model) => String(model || '').replace(/^managed:/, '');
          permissionSwitch = {
            skipped: false,
            auto: autoStatus.permission,
            manual: manualStatus.permission,
            model: manualStatus.model || null,
            modelPassed: !selectedModel || normalizeModel(manualStatus.model) === normalizeModel(selectedModel),
            advancedModes: advancedModes,
            uiTogglePassed: autoUiPassed && manualUiPassed,
            passed: autoStatus.permission === 'auto' && manualStatus.permission === 'manual' &&
              autoUiPassed && manualUiPassed &&
              (!selectedModel || normalizeModel(manualStatus.model) === normalizeModel(selectedModel))
          };
        } finally {
          if (sessionId) {
            await api('/sessions/' + encodeURIComponent(sessionId) + ':archive', { method: 'POST', body: '{}' });
          }
        }
      }
      const messageState = window.__kimi2007;
      const syntheticSessionId = '__qkimi_order_smoke__';
      messageState.sid = syntheticSessionId;
      const originalFetch = window.fetch.bind(window);
      let syntheticPromptCalls = 0;
      let unknownPromptVisible = false;
      const syntheticMessages = () => [{
        id: 'qkimi-order-smoke-user', role: 'user', created_at: new Date().toISOString(),
        content: [{ type: 'text', text: '消息顺序回归' }]
      }].concat(unknownPromptVisible ? [{
        id: 'qkimi-unknown-result-user', role: 'user', created_at: new Date().toISOString(),
        content: [{ type: 'text', text: '结果不明回归' }]
      }] : []);
      window.fetch = (url, options) => {
        if (String(url).includes('/sessions/' + syntheticSessionId + '/prompts')) {
          syntheticPromptCalls += 1;
          let promptText = '';
          try {
            const payload = JSON.parse(options?.body || '{}');
            promptText = (payload.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          } catch (_) {}
          if (promptText === '结果不明回归') {
            unknownPromptVisible = true;
            return Promise.reject(new TypeError('模拟响应丢失'));
          }
          if (syntheticPromptCalls === 3) {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
              })), 900);
              options?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
              }, { once: true });
            });
          }
          return Promise.resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        }
        if (String(url).includes('/sessions/' + syntheticSessionId + ':abort')) {
          return Promise.resolve(new Response(JSON.stringify({ code: 0, data: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        }
        if (String(url).includes('/sessions/' + syntheticSessionId + '/messages')) {
          return Promise.resolve(new Response(JSON.stringify({
            code: 0,
            data: { items: syntheticMessages() }
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        }
        if (String(url).endsWith('/sessions/' + syntheticSessionId + '/snapshot')) {
          return Promise.resolve(new Response(JSON.stringify({
            code: 0,
            data: {
              as_of_seq: 0,
              epoch: 'qkimi-smoke',
              session: { id: syntheticSessionId, title: '回归会话', busy: false, pending_interaction: 'none' },
              messages: { items: syntheticMessages() },
              pending_approvals: [], pending_questions: []
            }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (String(url).endsWith('/sessions/' + syntheticSessionId + '/status')) {
          return Promise.resolve(new Response(JSON.stringify({
            code: 0, data: { busy: false, permission: 'manual', model: 'kimi-code/k3' }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (String(url).endsWith('/sessions/' + syntheticSessionId)) {
          return Promise.resolve(new Response(JSON.stringify({
            code: 0,
            data: { id: syntheticSessionId, busy: false, main_turn_active: false, pending_interaction: 'none' }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return originalFetch(url, options);
      };
      const smokeInput = document.querySelector('#input');
      const userMessageCount = document.querySelectorAll('.msg.user').length;
      const chatBody = document.querySelector('#chatBody');
      chatBody.scrollTop = 0;
      smokeInput.value = '消息顺序回归';
      smokeInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn')?.click();
      const optimisticUser = document.querySelector('.msg.pending-user');
      const optimisticUserPresent = Boolean(optimisticUser);
      const typingPresent = await waitFor(() => Boolean(document.querySelector('.msg.typing')));
      const typingMessage = document.querySelector('.msg.typing');
      const userBeforeTyping = Boolean(optimisticUser && typingMessage) &&
        Boolean(optimisticUser.compareDocumentPosition(typingMessage) & Node.DOCUMENT_POSITION_FOLLOWING);
      const reconciled = await waitFor(() => Boolean(optimisticUser) &&
        !optimisticUser.classList.contains('pending-user') &&
        document.querySelectorAll('.msg.user').length === userMessageCount + 1
      );
      const immediateScroll = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 3;
      smokeInput.value = '排队消息回归';
      smokeInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn')?.click();
      await waitFor(() => messageState.sessionUi[syntheticSessionId]?.submitting === false);
      smokeInput.value = '新草稿';
      smokeInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#stopBtn')?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const waitsForAuthoritativeStop = smokeInput.value === '新草稿';
      const abortedPromptRestored = await waitFor(() =>
        smokeInput.value === '消息顺序回归\n\n排队消息回归\n\n新草稿'
      );
      smokeInput.value = '';
      smokeInput.dispatchEvent(new Event('input', { bubbles: true }));
      smokeInput.value = '快速停止回归';
      smokeInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn')?.click();
      messageState.ws?.onmessage?.({ data: JSON.stringify({
        type: 'event.session.status_changed', session_id: syntheticSessionId, seq: 1,
        payload: { status: 'idle' }
      }) });
      const staleIdleIgnored = messageState.sessionUi[syntheticSessionId]?.submitting === true &&
        messageState.sessionUi[syntheticSessionId]?.submittedPrompts?.some((record) => record.text === '快速停止回归') &&
        getComputedStyle(document.querySelector('#stopBtn')).display !== 'none';
      document.querySelector('#stopBtn')?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const immediateStopWaitsForAuthority = smokeInput.value === '';
      const immediateAbortRestored = await waitFor(() => smokeInput.value === '快速停止回归');
      smokeInput.value = '';
      smokeInput.dispatchEvent(new Event('input', { bubbles: true }));
      smokeInput.value = '结果不明回归';
      smokeInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn')?.click();
      const unknownResultReconciled = await waitFor(() =>
        messageState.sessionUi[syntheticSessionId]?.submittedPrompts?.some((record) =>
          record.text === '结果不明回归' && record.accepted
        ) && smokeInput.value === ''
      );
      const syntheticUi = messageState.sessionUi[syntheticSessionId];
      syntheticUi.archived = true;
      syntheticUi.waiting = false;
      syntheticUi.waitGeneration += 1;
      if (syntheticUi.waitTimer) clearTimeout(syntheticUi.waitTimer);
      window.fetch = originalFetch;
      const messageOrder = {
        optimisticUserPresent: optimisticUserPresent,
        typingPresent: typingPresent,
        userBeforeTyping: userBeforeTyping,
        reconciledWithoutDuplicate: reconciled,
        immediateScroll: immediateScroll,
        waitsForAuthoritativeStop: waitsForAuthoritativeStop,
        abortedPromptRestored: abortedPromptRestored,
        staleIdleIgnored: staleIdleIgnored,
        immediateStopWaitsForAuthority: immediateStopWaitsForAuthority,
        immediateAbortRestored: immediateAbortRestored,
        unknownResultReconciled: unknownResultReconciled
      };
      /* 全尺寸锁定下权限面板能否弹出回归：锁定 full 后点 permissionInfo，
         验证 #panel 不再 hidden、三种模式按钮都出现。 */
      const fullLockPermissionTest = await (async function () {
        document.querySelector('#slMenuBtn')?.click();
        await waitFor(() => document.querySelector('#slLayout') != null);
        document.querySelector('#slLayout')?.click();
        await waitFor(() => document.querySelector('.p-permission-option[data-layout]') != null);
        document.querySelector('.p-permission-option[data-layout="full"]')?.click();
        const fullLocked = await waitFor(() =>
          document.documentElement.getAttribute('data-layout-lock') === 'full'
        );
        /* 确保有会话：用当前 sid（smoke 已 hydrate 一个会话）。 */
        const permBtn = document.querySelector('#permissionInfo');
        const beforeHidden = document.querySelector('#panel')?.hidden;
        permBtn?.click();
        const opened = await waitFor(() =>
          !document.querySelector('#panel')?.hidden &&
          document.querySelectorAll('.p-permission-option[data-mode]').length >= 3
        , 4000);
        const modes = Array.from(document.querySelectorAll('.p-permission-option[data-mode]')).map((b) => b.dataset.mode);
        document.querySelector('#panelClose')?.click();
        /* 还原 auto */
        document.querySelector('#slMenuBtn')?.click();
        await waitFor(() => document.querySelector('#slLayout') != null);
        document.querySelector('#slLayout')?.click();
        await waitFor(() => document.querySelector('.p-permission-option[data-layout]') != null);
        document.querySelector('.p-permission-option[data-layout="auto"]')?.click();
        await waitFor(() => document.documentElement.getAttribute('data-layout-lock') === 'auto');
        return { fullLocked: fullLocked, panelWasHidden: beforeHidden, opened: opened, modes: modes };
      })().catch((e) => ({ error: String(e) }));

      /* 布局锁定 + 权限标签更新回归：验证 QQ 风格“尺寸模式”切换，
         以及点击权限模式后按钮文字一定会更新到所选模式。 */
      const layoutTest = await (async function () {
        const before = document.documentElement.getAttribute('data-layout-lock');
        const beforeEff = document.documentElement.getAttribute('data-layout');
        document.querySelector('#slMenuBtn')?.click();
        await waitFor(() => document.querySelector('#slLayout') != null);
        document.querySelector('#slLayout')?.click();
        await waitFor(() => document.querySelector('.p-permission-option[data-layout]') != null);
        /* 锁定 compact */
        document.querySelector('.p-permission-option[data-layout="compact"]')?.click();
        const compactLocked = await waitFor(() =>
          document.documentElement.getAttribute('data-layout-lock') === 'compact' &&
          document.documentElement.getAttribute('data-layout') === 'compact'
        );
        /* 还原 auto，避免污染后续用例 */
        document.querySelector('#slMenuBtn')?.click();
        await waitFor(() => document.querySelector('#slLayout') != null);
        document.querySelector('#slLayout')?.click();
        await waitFor(() => document.querySelector('.p-permission-option[data-layout]') != null);
        document.querySelector('.p-permission-option[data-layout="auto"]')?.click();
        const restored = await waitFor(() =>
          document.documentElement.getAttribute('data-layout-lock') === 'auto'
        );
        return {
          beforeLock: before,
          beforeEffective: beforeEff,
          compactLocked: compactLocked,
          restoredAuto: restored,
        };
      })().catch((e) => ({ error: String(e) }));

      const permissionLabelTest = await (async function () {
        /* 用临时会话验证点击后按钮文字一定会更新。需要服务端 REST，复用权限切换块里定义的 api。 */
        const headers = {
          Authorization: 'Bearer ' + runtime.token,
          'Content-Type': 'application/json'
        };
        const apiLocal = async (path, options = {}) => {
          const response = await fetch(runtime.base + '/api/v1' + path, Object.assign({}, options, { headers }));
          const payload = await response.json();
          if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || 'HTTP ' + response.status);
          return payload.data;
        };
        let sid = null;
        try {
          const created = await apiLocal('/sessions', {
            method: 'POST',
            body: JSON.stringify({ metadata: { cwd: runtime.cwd }, agent_config: { permission_mode: 'manual' } })
          });
          sid = created.id;
          const uiState = window.__kimi2007;
          const original = uiState.sid;
          uiState.sid = sid;
          uiState.sessionStatus[sid] = { permission: 'manual', busy: false };
          uiState.sessionPermission[sid] = 'manual';
          /* 打开权限面板 -> 点 auto -> 等按钮文字变成自动许可 */
          document.querySelector('#permissionInfo')?.click();
          await waitFor(() => document.querySelector('.p-permission-option[data-mode="auto"]') != null);
          document.querySelector('.p-permission-option[data-mode="auto"]')?.click();
          const labelChanged = await waitFor(() =>
            /自动许可/.test(document.querySelector('#permissionInfo')?.textContent || '')
          );
          const statusPerm = await apiLocal('/sessions/' + encodeURIComponent(sid) + '/status').then((s) => s.permission);
          uiState.sid = original;
          return { labelChanged: labelChanged, statusPermission: statusPerm };
        } finally {
          if (sid) await apiLocal('/sessions/' + encodeURIComponent(sid) + ':archive', { method: 'POST', body: '{}' }).catch(() => {});
        }
      })().catch((e) => ({ error: String(e) }));

      const tagFavTest = await (async function () {
        /* 会话标签与收藏回归：标签写入/读取 + 分组渲染；收藏增删、计数、笔记与面板。 */
        const uiState = window.__kimi2007;
        const result = {
          sessionTags: { writeRead: false, groupRendered: false },
          favorites: {
            addRemove: false, countSynced: false, panelOpened: false,
            controlsVisible: false, noOverflow: false, noteSaved: false
          }
        };
        try {
          if (uiState.sessions && uiState.sessions.length) {
            document.querySelector('#sessList .sess-item .sess-tagbtn')?.click();
            const tagPanelOpened = await waitFor(() =>
              !document.querySelector('#panel')?.hidden &&
              document.querySelectorAll('#panelBody .tag-opt input').length >= 4);
            const workBox = Array.from(document.querySelectorAll('#panelBody .tag-opt input'))
              .find((box) => box.value === '工作');
            if (workBox) workBox.checked = true;
            document.querySelector('#panelBody #tagSave')?.click();
            await waitFor(() => document.querySelector('#panel')?.hidden);
            let storedTags = {};
            try { storedTags = JSON.parse(localStorage.getItem('kimi2007.sessionTags.v1') || '{}'); } catch (_) {}
            const taggedSid = Object.keys(storedTags).find((sid) => (storedTags[sid] || []).includes('工作'));
            result.sessionTags.writeRead = tagPanelOpened && Boolean(taggedSid) &&
              (uiState.sessionTags[taggedSid] || []).includes('工作');
            const sel = document.querySelector('#sessGroupSel');
            sel.value = 'tag';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            result.sessionTags.groupRendered = await waitFor(() =>
              Array.from(document.querySelectorAll('#sessList .sess-group .tag-chip'))
                .some((chip) => chip.textContent.includes('工作')));
            sel.value = 'time';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          const favAct = document.querySelector('#chatBody .msg-actions .msg-act[title="收藏此消息到知识库"]');
          const storedFavCount = () => {
            try { return JSON.parse(localStorage.getItem('kimi2007.favorites.v1') || '[]').length; }
            catch (_) { return -1; }
          };
          if (favAct) {
            favAct.click();
            const added = await waitFor(() => storedFavCount() > 0);
            const starred = favAct.textContent.includes('已收藏');
            const countSynced = await waitFor(() => {
              const badge = document.querySelector('#favCount');
              return badge?.textContent === '1' && badge?.hidden === false;
            });
            favAct.click();
            const removed = await waitFor(() => storedFavCount() === 0);
            favAct.click();
            await waitFor(() => storedFavCount() > 0);
            result.favorites.addRemove = added && starred && removed;
            result.favorites.countSynced = countSynced;
            document.querySelector('#favBtn')?.click();
            result.favorites.panelOpened = await waitFor(() =>
              !document.querySelector('#panel')?.hidden &&
              document.querySelectorAll('#panelBody .fav-card').length > 0);
            result.favorites.controlsVisible = document.querySelector('#panelBody .fav-workspace') != null &&
              document.querySelector('#panelBody .fav-sort') != null &&
              document.querySelector('#panelBody .fav-overview-meta') != null;
            const favPanel = document.querySelector('#panel');
            result.favorites.noOverflow = Boolean(favPanel && favPanel.scrollWidth <= favPanel.clientWidth);
            document.querySelector('#panelBody .fav-note-btn')?.click();
            const noteEditorOpened = await waitFor(() => document.querySelector('#panelBody .fav-note-editor') != null);
            const noteEditor = document.querySelector('#panelBody .fav-note-editor');
            if (noteEditor) noteEditor.value = 'smoke 收藏笔记';
            document.querySelector('#panelBody .fav-note-save')?.click();
            result.favorites.noteSaved = noteEditorOpened && await waitFor(() => {
              try {
                return JSON.parse(localStorage.getItem('kimi2007.favorites.v1') || '[]')
                  .some((fav) => fav.note === 'smoke 收藏笔记');
              } catch (_) {
                return false;
              }
            });
            document.querySelector('#panelClose')?.click();
            await waitFor(() => document.querySelector('#panel')?.hidden);
          }
        } catch (error) {
          result.error = String(error);
        } finally {
          /* 清理 smoke 写入的本地数据，避免污染真实会话列表。 */
          try {
            localStorage.removeItem('kimi2007.sessionTags.v1');
            localStorage.removeItem('kimi2007.favorites.v1');
            localStorage.removeItem('kimi2007.sessgroup');
          } catch (_) {}
          uiState.sessionTags = {};
          uiState.favorites = [];
          uiState.sessGroup = 'time';
          uiState.tagFilter = null;
        }
        return result;
      })().catch((e) => ({ error: String(e) }));

      const bounds = document.querySelector('#window')?.getBoundingClientRect();
      return {
        bootstrap: window.__qkimiBootstrap?.phase,
        connection: document.querySelector('#connStatus')?.textContent,
        desktop: window.KimiDesktop?.isDesktop,
        platform: window.KimiDesktop?.platform,
        nodeGlobalsHidden: typeof window.require === 'undefined' && typeof window.process === 'undefined',
        hasToken: Boolean(runtime.token),
        cwd: runtime.cwd,
        upload: upload,
        orphanCleanup: orphanCleanup,
        permissionUi: permissionUi,
        permissionSwitch: permissionSwitch,
        permissionLabel: permissionLabelTest,
        fullLockPermission: fullLockPermissionTest,
        layoutSwitch: layoutTest,
        messageOrder: messageOrder,
        sessionTags: tagFavTest.sessionTags,
        favorites: tagFavTest.favorites,
        modelMenu: modelMenu,
        toolsPanel: toolsPanel,
        keyboard: keyboard,
        multiWorkspace: multiWorkspace,
        completion: completion,
        activityCenter: activityCenter,
        narrowLayout: narrowLayout,
        pet: pet,
        fillsViewport: Boolean(bounds) && bounds.x === 0 && bounds.y === 0 && bounds.width === innerWidth && bounds.height === innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight
      };
      """#
    let performUpload = ProcessInfo.processInfo.environment["QKIMI_SMOKE_UPLOAD"] == "1"
    let performPermissionSwitch =
      ProcessInfo.processInfo.environment["QKIMI_SMOKE_PERMISSION"] == "1"
    webView.callAsyncJavaScript(
      script,
      arguments: [
        "performUpload": performUpload,
        "performPermissionSwitch": performPermissionSwitch,
      ],
      in: nil,
      in: .page
    ) { result in
      let output: [String: Any]
      switch result {
      case .success(let value):
        output = ["ok": true, "result": value]
      case .failure(let error):
        output = ["ok": false, "error": error.localizedDescription]
      }
      do {
        let data = try JSONSerialization.data(
          withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: resultPath), options: .atomic)
      } catch {
        fputs("[kimi-2007] smoke result write failed: \(error)\n", stderr)
      }
      finish()
    }
  }
}
