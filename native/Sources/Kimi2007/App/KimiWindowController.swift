import AppKit
import WebKit

/// 单个 Kimi 2007 窗口：拥有自己的工作区上下文、WKWebView 和原生桥。
/// 窗口的构建与生命周期原属 AppDelegate.createWindow，多窗口化后收敛到这里。
@MainActor
final class KimiWindowController: NSObject, NSWindowDelegate {
  let store: WorkspaceStore
  private(set) var window: NSWindow?
  private var bridge: NativeBridge?
  private var webCoordinator: WebCoordinator?
  private weak var webView: WKWebView?

  /// 窗口关闭时回调（AppDelegate 用来移除引用并更新持久化的窗口集合）。
  var onClose: ((KimiWindowController) -> Void)?
  /// 前端「新窗口打开工作区」请求，由 AppDelegate 装配。
  var onOpenWorkspaceWindow: ((String) -> Void)? {
    didSet { bridge?.onOpenWorkspaceWindow = onOpenWorkspaceWindow }
  }

  init(runtime: KimiRuntime, store: WorkspaceStore, appURL: URL) {
    self.store = store
    super.init()

    let environment = ProcessInfo.processInfo.environment
    let smokeMode = environment["QKIMI_SMOKE_RESULT"] != nil
    let requestedWidth = Double(environment["QKIMI_SMOKE_WIDTH"] ?? "")
    let requestedHeight = Double(environment["QKIMI_SMOKE_HEIGHT"] ?? "")
    let initialWidth = requestedWidth ?? 1150
    let initialHeight = requestedHeight ?? 830

    let userContent = WKUserContentController()
    let bridge = NativeBridge(runtime: runtime, store: store)
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
    bridge.onWorkspaceChanged = { [weak self] in self?.updateTitle() }
    self.bridge = bridge
    self.webCoordinator = coordinator
    self.window = window
    self.webView = webView
    updateTitle()

    window.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
    webView.load(URLRequest(url: appURL))
  }

  /// 仅 smoke 主窗口使用：页面加载完成后挂测试脚本。
  func setInitialLoadHandler(_ handler: @escaping (WKWebView) -> Void) {
    webCoordinator?.didFinishInitialLoad = handler
  }

  func close() {
    window?.close()
  }

  private func updateTitle() {
    let name = URL(fileURLWithPath: store.workspace).lastPathComponent
    window?.title = name.isEmpty ? "Kimi 2007" : "Kimi 2007 — \(name)"
  }

  func windowDidResize(_ notification: Notification) {
    bridge?.publishWindowState()
  }

  func windowWillClose(_ notification: Notification) {
    onClose?(self)
  }
}
