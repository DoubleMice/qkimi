import AppKit
import WebKit

@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
  private let runtime: KimiRuntime
  private let store: WorkspaceStore
  weak var window: NSWindow?
  weak var webView: WKWebView?

  /// 工作区经「选择目录」变更后回调（窗口标题等需要刷新）。
  var onWorkspaceChanged: (() -> Void)?
  /// 前端请求在新窗口打开某个工作区。
  var onOpenWorkspaceWindow: ((String) -> Void)?

  init(runtime: KimiRuntime, store: WorkspaceStore) {
    self.runtime = runtime
    self.store = store
  }

  static let injectedJavaScript = #"""
    (function () {
      'use strict';
      var stateListeners = [];
      function invoke(action, params) {
        return window.webkit.messageHandlers.nativeBridge.postMessage({ action: action, params: params || {} });
      }
      function markDesktop() {
        if (!document.documentElement) return;
        document.documentElement.classList.add('desktop-client', 'native-client');
        document.documentElement.setAttribute('data-platform', 'darwin');
      }
      window.__qkimiNativeWindowState = function (state) {
        stateListeners.slice().forEach(function (listener) {
          try { listener(state); } catch (error) { console.error(error); }
        });
      };
      window.KimiDesktop = Object.freeze({
        isDesktop: true,
        platform: 'darwin',
        getRuntimeEnv: function () { return invoke('runtime'); },
        chooseWorkspace: function () { return invoke('chooseWorkspace'); },
        openWorkspaceWindow: function (cwd) { return invoke('openWorkspaceWindow', { cwd: cwd }); },
        minimize: function () { invoke('minimize').catch(function () {}); },
        toggleMaximize: function () { invoke('toggleMaximize').catch(function () {}); },
        close: function () { invoke('close').catch(function () {}); },
        onWindowState: function (callback) {
          if (typeof callback !== 'function') return;
          stateListeners.push(callback);
          invoke('windowState').then(callback).catch(function () {});
        }
      });
      markDesktop();
      document.addEventListener('DOMContentLoaded', markDesktop, { once: true });
    })();
    """#

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    guard let body = message.body as? [String: Any],
      let action = body["action"] as? String
    else {
      replyHandler(nil, "无效的客户端请求")
      return
    }
    let params = body["params"] as? [String: Any] ?? [:]

    switch action {
    case "runtime":
      do {
        replyHandler(try runtime.environmentDictionary(workspace: store.workspace), nil)
      } catch {
        replyHandler(nil, error.localizedDescription)
      }
    case "chooseWorkspace":
      chooseWorkspace(replyHandler: replyHandler)
    case "openWorkspaceWindow":
      openWorkspaceWindow(params: params, replyHandler: replyHandler)
    case "minimize":
      replyHandler(nil, nil)
      window?.miniaturize(nil)
    case "toggleMaximize":
      replyHandler(nil, nil)
      window?.zoom(nil)
      DispatchQueue.main.async { [weak self] in self?.publishWindowState() }
    case "close":
      replyHandler(nil, nil)
      window?.performClose(nil)
    case "windowState":
      replyHandler(windowState, nil)
    default:
      replyHandler(nil, "不支持的客户端请求：\(action)")
    }
  }

  func publishWindowState() {
    guard let webView else { return }
    let state = windowState
    let maximized = (state["maximized"] as? Bool) == true ? "true" : "false"
    webView.evaluateJavaScript(
      "window.__qkimiNativeWindowState && window.__qkimiNativeWindowState({maximized:\(maximized)});"
    )
  }

  private var windowState: [String: Any] {
    ["maximized": window?.isZoomed ?? false]
  }

  private func chooseWorkspace(replyHandler: @escaping (Any?, String?) -> Void) {
    guard let window else {
      replyHandler(nil, "客户端窗口不可用")
      return
    }
    let panel = NSOpenPanel()
    panel.title = "选择 Kimi 工作区"
    panel.prompt = "选择工作区"
    panel.directoryURL = URL(fileURLWithPath: store.workspace)
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.beginSheetModal(for: window) { [weak self] response in
      guard let self else {
        replyHandler(["canceled": true], nil)
        return
      }
      guard response == .OK, let selected = panel.url else {
        replyHandler(["canceled": true, "cwd": self.store.workspace], nil)
        return
      }
      self.store.setWorkspace(selected.path)
      self.onWorkspaceChanged?()
      replyHandler(["canceled": false, "cwd": self.store.workspace], nil)
    }
  }

  private func openWorkspaceWindow(
    params: [String: Any], replyHandler: @escaping (Any?, String?) -> Void
  ) {
    let requested = (params["cwd"] as? String) ?? store.workspace
    guard WorkspaceStore.isDirectory(requested) else {
      replyHandler(nil, "工作区目录不存在：\(requested)")
      return
    }
    guard let onOpenWorkspaceWindow else {
      replyHandler(nil, "客户端暂不支持多窗口")
      return
    }
    replyHandler(["ok": true], nil)
    onOpenWorkspaceWindow(requested)
  }
}
