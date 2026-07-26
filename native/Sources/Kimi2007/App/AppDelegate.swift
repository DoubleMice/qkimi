import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var runtime: KimiRuntime?
  private var pageServer: LoopbackServer?
  private var appURL: URL?
  private var controllers: [KimiWindowController] = []

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

  private func startPageServer(runtime: KimiRuntime) {
    do {
      let root = try webResourceRoot()
      let server = LoopbackServer(root: root)
      pageServer = server
      server.start { [weak self] result in
        switch result {
        case .success(let url):
          self?.openInitialWindows(runtime: runtime, appURL: url)
        case .failure(let error):
          self?.failStartup(error)
        }
      }
    } catch {
      failStartup(error)
    }
  }

  /// 启动建窗：smoke 模式只开单个默认窗口；正常模式恢复上次打开的窗口集合。
  private func openInitialWindows(runtime: KimiRuntime, appURL: URL) {
    self.appURL = appURL
    let smokeMode = ProcessInfo.processInfo.environment["QKIMI_SMOKE_RESULT"] != nil
    if smokeMode {
      let controller = openWindow(workspace: WorkspaceStore.defaultWorkspace())
      if let resultPath = ProcessInfo.processInfo.environment["QKIMI_SMOKE_RESULT"] {
        controller?.setInitialLoadHandler { [weak self] loadedWebView in
          SmokeTestRunner.run(webView: loadedWebView, resultPath: resultPath) { [weak self] in
            self?.controllers.first?.close()
            NSApplication.shared.terminate(nil)
          }
        }
      }
      return
    }
    let saved = WorkspaceStore.savedOpenWorkspaces()
    if saved.isEmpty {
      openWindow(workspace: WorkspaceStore.defaultWorkspace())
    } else {
      saved.forEach { openWindow(workspace: $0) }
    }
  }

  /// 打开一个绑定指定工作区的新窗口，并持久化当前窗口集合。
  /// 服务未就绪（启动早期的菜单快捷键）时返回 nil。
  @discardableResult
  private func openWindow(workspace: String) -> KimiWindowController? {
    guard let runtime, let appURL else { return nil }
    let controller = KimiWindowController(
      runtime: runtime, store: WorkspaceStore(workspace: workspace), appURL: appURL)
    controller.onClose = { [weak self] closed in
      self?.controllers.removeAll { $0 === closed }
      self?.persistOpenWorkspaces()
    }
    controller.onOpenWorkspaceWindow = { [weak self] path in
      self?.openWindow(workspace: path)
    }
    controllers.append(controller)
    persistOpenWorkspaces()
    return controller
  }

  private func persistOpenWorkspaces() {
    // smoke 运行不写窗口集合，避免污染日常启动。
    guard ProcessInfo.processInfo.environment["QKIMI_SMOKE_RESULT"] == nil else { return }
    WorkspaceStore.saveOpenWorkspaces(controllers.map { $0.store.workspace })
  }

  @objc private func newWindowAction() {
    openWindow(workspace: WorkspaceStore.defaultWorkspace())
  }

  @objc private func openWorkspaceWindowAction() {
    let panel = NSOpenPanel()
    panel.title = "选择 Kimi 工作区"
    panel.prompt = "打开工作区"
    panel.directoryURL = URL(fileURLWithPath: WorkspaceStore.defaultWorkspace())
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    if panel.runModal() == .OK, let selected = panel.url {
      openWindow(workspace: selected.path)
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
    let currentWeb = current.appendingPathComponent("web", isDirectory: true)
    if FileManager.default.fileExists(atPath: currentWeb.appendingPathComponent("index.html").path) {
      return currentWeb
    }
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

    let fileItem = NSMenuItem()
    mainMenu.addItem(fileItem)
    let fileMenu = NSMenu(title: "文件")
    fileMenu.addItem(
      withTitle: "新建窗口", action: #selector(newWindowAction), keyEquivalent: "n")
    fileMenu.addItem(
      withTitle: "新窗口打开工作区…", action: #selector(openWorkspaceWindowAction),
      keyEquivalent: "N")
    fileItem.submenu = fileMenu

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
