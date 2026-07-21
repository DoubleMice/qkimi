import AppKit
import WebKit

@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
  private let runtime: KimiRuntime
  weak var window: NSWindow?
  weak var webView: WKWebView?

  init(runtime: KimiRuntime) {
    self.runtime = runtime
  }

  static let injectedJavaScript = #"""
    (function () {
      'use strict';
      var stateListeners = [];
      function invoke(action) {
        return window.webkit.messageHandlers.nativeBridge.postMessage({ action: action });
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

    switch action {
    case "runtime":
      do {
        replyHandler(try runtime.environmentDictionary(), nil)
      } catch {
        replyHandler(nil, error.localizedDescription)
      }
    case "chooseWorkspace":
      chooseWorkspace(replyHandler: replyHandler)
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
    panel.directoryURL = URL(fileURLWithPath: runtime.workspace)
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
        replyHandler(["canceled": true, "cwd": self.runtime.workspace], nil)
        return
      }
      self.runtime.setWorkspace(selected.path)
      replyHandler(["canceled": false, "cwd": self.runtime.workspace], nil)
    }
  }
}
