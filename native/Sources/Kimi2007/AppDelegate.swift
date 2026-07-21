import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var runtime: KimiRuntime?
  private var pageServer: LoopbackServer?
  private var window: NSWindow?
  private var bridge: NativeBridge?
  private var webCoordinator: WebCoordinator?

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildApplicationMenu()
    do {
      let runtime = try KimiRuntime()
      self.runtime = runtime
      runtime.ensureServer { [weak self] result in
        switch result {
        case .success:
          self?.startPageServer(runtime: runtime)
        case .failure(let error):
          self?.failStartup(error)
        }
      }
    } catch {
      failStartup(error)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationWillTerminate(_ notification: Notification) {
    pageServer?.stop()
  }

  func windowDidResize(_ notification: Notification) {
    bridge?.publishWindowState()
  }

  private func startPageServer(runtime: KimiRuntime) {
    do {
      let root = try webResourceRoot()
      let server = LoopbackServer(root: root)
      pageServer = server
      server.start { [weak self] result in
        switch result {
        case .success(let url):
          self?.createWindow(runtime: runtime, appURL: url)
        case .failure(let error):
          self?.failStartup(error)
        }
      }
    } catch {
      failStartup(error)
    }
  }

  private func createWindow(runtime: KimiRuntime, appURL: URL) {
    let environment = ProcessInfo.processInfo.environment
    let smokeMode = environment["QKIMI_SMOKE_RESULT"] != nil
    let requestedWidth = Double(environment["QKIMI_SMOKE_WIDTH"] ?? "")
    let requestedHeight = Double(environment["QKIMI_SMOKE_HEIGHT"] ?? "")
    let initialWidth = requestedWidth ?? 1150
    let initialHeight = requestedHeight ?? 830
    let userContent = WKUserContentController()
    let bridge = NativeBridge(runtime: runtime)
    let bridgeScript = WKUserScript(
      source: NativeBridge.injectedJavaScript,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true
    )
    userContent.addUserScript(bridgeScript)
    userContent.addScriptMessageHandler(bridge, contentWorld: .page, name: "nativeBridge")

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = userContent
    configuration.websiteDataStore = .default()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.mediaTypesRequiringUserActionForPlayback = .all

    let webView = NativeWebView(frame: .zero, configuration: configuration)
    webView.setValue(false, forKey: "drawsBackground")
    webView.allowsMagnification = false
    webView.allowsBackForwardNavigationGestures = false

    let coordinator = WebCoordinator(appOrigin: appURL)
    webView.navigationDelegate = coordinator
    webView.uiDelegate = coordinator

    let style: NSWindow.StyleMask = [
      .titled, .closable, .miniaturizable, .resizable, .fullSizeContentView,
    ]
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: initialWidth, height: initialHeight),
      styleMask: style,
      backing: .buffered,
      defer: false
    )
    window.title = "Kimi 2007"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.backgroundColor = NSColor(
      calibratedRed: 44 / 255, green: 90 / 255, blue: 140 / 255, alpha: 1)
    window.minSize = smokeMode && requestedWidth != nil
      ? NSSize(width: 320, height: 420)
      : NSSize(width: 900, height: 650)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.standardWindowButton(.closeButton)?.isHidden = true
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true
    window.contentView = webView
    window.center()

    bridge.window = window
    bridge.webView = webView
    self.bridge = bridge
    self.webCoordinator = coordinator
    self.window = window

    if let resultPath = ProcessInfo.processInfo.environment["QKIMI_SMOKE_RESULT"] {
      coordinator.didFinishInitialLoad = { [weak self] loadedWebView in
        self?.runSmokeTest(webView: loadedWebView, resultPath: resultPath)
      }
    }

    window.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
    webView.load(URLRequest(url: appURL))
  }

  private func runSmokeTest(webView: WKWebView, resultPath: String) {
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
      const keyboard = {
        searchFocused: document.activeElement === document.querySelector('#sessSearch'),
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
      document.querySelector('#panelClose')?.click();
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
        modelMenu: modelMenu,
        toolsPanel: toolsPanel,
        keyboard: keyboard,
        activityCenter: activityCenter,
        narrowLayout: narrowLayout,
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
    ) {
      [weak self] result in
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
      self?.window?.close()
      NSApplication.shared.terminate(nil)
    }
  }

  private func webResourceRoot() throws -> URL {
    let environment = ProcessInfo.processInfo.environment
    if let configured = environment["QKIMI_RESOURCE_ROOT"] {
      return URL(fileURLWithPath: configured, isDirectory: true)
    }
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true),
      FileManager.default.fileExists(atPath: bundled.appendingPathComponent("index.html").path)
    {
      return bundled
    }
    let current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    if FileManager.default.fileExists(atPath: current.appendingPathComponent("index.html").path) {
      return current
    }
    throw NSError(
      domain: "com.qkimi.desktop",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "找不到客户端网页资源"]
    )
  }

  private func failStartup(_ error: Error) {
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "Kimi 2007 启动失败"
    alert.informativeText = error.localizedDescription
    alert.addButton(withTitle: "退出")
    alert.runModal()
    NSApplication.shared.terminate(nil)
  }

  private func buildApplicationMenu() {
    let mainMenu = NSMenu()

    let appItem = NSMenuItem()
    mainMenu.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "关于 Kimi 2007", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "隐藏 Kimi 2007", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "退出 Kimi 2007", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu

    let editItem = NSMenuItem()
    mainMenu.addItem(editItem)
    let editMenu = NSMenu(title: "编辑")
    editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu

    let windowItem = NSMenuItem()
    mainMenu.addItem(windowItem)
    let windowMenu = NSMenu(title: "窗口")
    windowMenu.addItem(
      withTitle: "最小化", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
    windowItem.submenu = windowMenu
    NSApplication.shared.windowsMenu = windowMenu

    NSApplication.shared.mainMenu = mainMenu
  }
}
