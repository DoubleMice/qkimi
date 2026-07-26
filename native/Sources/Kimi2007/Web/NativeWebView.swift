import AppKit
import WebKit

final class NativeWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    // WKWebView 是 flipped 视图：y=0 在顶部，y=bounds.height 在底部。
    let inTitlebar = point.y <= 30
    let outsideButtons = point.x < bounds.width - 104
    if inTitlebar && outsideButtons {
      if event.clickCount == 2 {
        window?.zoom(nil)
      } else {
        window?.performDrag(with: event)
      }
      return
    }
    super.mouseDown(with: event)
  }
}

@MainActor
final class WebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
  let appOrigin: URL
  var didFinishInitialLoad: ((WKWebView) -> Void)?

  init(appOrigin: URL) {
    self.appOrigin = appOrigin
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if isAppURL(url) || url.absoluteString == "about:blank" {
      decisionHandler(.allow)
      return
    }
    if url.scheme == "http" || url.scheme == "https" {
      NSWorkspace.shared.open(url)
    }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    didFinishInitialLoad?(webView)
    didFinishInitialLoad = nil
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url,
      url.scheme == "http" || url.scheme == "https"
    {
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView,
    runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping ([URL]?) -> Void
  ) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.begin { response in
      completionHandler(response == .OK ? panel.urls : nil)
    }
  }

  private func isAppURL(_ url: URL) -> Bool {
    url.scheme == appOrigin.scheme && url.host == appOrigin.host && url.port == appOrigin.port
  }
}
