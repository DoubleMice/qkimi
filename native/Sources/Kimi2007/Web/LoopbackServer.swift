import Foundation
import Network

final class LoopbackServer {
  enum ServerError: LocalizedError {
    case missingPort
    case failed(String)
    case invalidStaticManifest(String)

    var errorDescription: String? {
      switch self {
      case .missingPort:
        return "本地页面服务未分配端口"
      case .failed(let message):
        return "本地页面服务启动失败：\(message)"
      case .invalidStaticManifest(let message):
        return "前端资源清单无效：\(message)"
      }
    }
  }

  private enum BundleKind: String, Decodable {
    case script
    case style
  }

  private enum StaticResource {
    case file(source: String, contentType: String)
    case bundle(kind: BundleKind, sources: [String], contentType: String)

    var contentType: String {
      switch self {
      case .file(_, let contentType), .bundle(_, _, let contentType):
        return contentType
      }
    }
  }

  private struct StaticFile: Decodable {
    let route: String
    let source: String
    let contentType: String
  }

  private struct StaticBundle: Decodable {
    let route: String
    let kind: BundleKind
    let sources: [String]
    let contentType: String
  }

  private struct StaticManifest: Decodable {
    let files: [StaticFile]
    let bundles: [StaticBundle]
  }

  private let root: URL
  private let staticResources: [String: StaticResource]
  private let staticManifestError: Error?
  private let queue = DispatchQueue(label: "com.qkimi.desktop.loopback", qos: .userInitiated)
  private var listener: NWListener?
  private var startCompletion: ((Result<URL, Error>) -> Void)?

  init(root: URL) {
    self.root = root
    do {
      staticResources = try Self.loadStaticResources(from: root)
      staticManifestError = nil
    } catch {
      staticResources = [:]
      staticManifestError = error
    }
  }

  func start(completion: @escaping (Result<URL, Error>) -> Void) {
    if let staticManifestError {
      completion(.failure(staticManifestError))
      return
    }
    do {
      let parameters = NWParameters.tcp
      parameters.acceptLocalOnly = true
      parameters.allowLocalEndpointReuse = true
      let listener = try NWListener(using: parameters, on: .any)
      self.listener = listener
      startCompletion = completion

      listener.stateUpdateHandler = { [weak self, weak listener] state in
        guard let self else { return }
        switch state {
        case .ready:
          guard let port = listener?.port else {
            self.completeStart(.failure(ServerError.missingPort))
            return
          }
          self.completeStart(.success(URL(string: "http://127.0.0.1:\(port.rawValue)/")!))
        case .failed(let error):
          self.completeStart(.failure(ServerError.failed(error.localizedDescription)))
        default:
          break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        self?.handle(connection)
      }
      listener.start(queue: queue)
    } catch {
      completion(.failure(error))
    }
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  private func completeStart(_ result: Result<URL, Error>) {
    guard let completion = startCompletion else { return }
    startCompletion = nil
    DispatchQueue.main.async { completion(result) }
  }

  private func handle(_ connection: NWConnection) {
    connection.start(queue: queue)
    receiveRequest(on: connection, buffer: Data())
  }

  private func receiveRequest(on connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self else {
        connection.cancel()
        return
      }
      var next = buffer
      if let data { next.append(data) }
      if next.range(of: Data("\r\n\r\n".utf8)) != nil {
        self.respond(to: next, on: connection)
      } else if error != nil || isComplete || next.count >= 64 * 1024 {
        connection.cancel()
      } else {
        self.receiveRequest(on: connection, buffer: next)
      }
    }
  }

  private func respond(to requestData: Data, on connection: NWConnection) {
    guard let request = String(data: requestData, encoding: .utf8),
      let requestLine = request.components(separatedBy: "\r\n").first
    else {
      send(status: 400, reason: "Bad Request", body: Data("bad request".utf8), on: connection)
      return
    }

    let parts = requestLine.split(separator: " ", maxSplits: 2).map(String.init)
    guard parts.count == 3 else {
      send(status: 400, reason: "Bad Request", body: Data("bad request".utf8), on: connection)
      return
    }
    let method = parts[0]
    guard method == "GET" || method == "HEAD" else {
      send(
        status: 405,
        reason: "Method Not Allowed",
        body: Data("method not allowed".utf8),
        extraHeaders: ["Allow": "GET, HEAD"],
        headOnly: method == "HEAD",
        on: connection
      )
      return
    }

    let rawPath = parts[1].split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
    guard let decoded = rawPath.removingPercentEncoding else {
      send(status: 400, reason: "Bad Request", body: Data("bad request".utf8), on: connection)
      return
    }
    let path = decoded == "/" ? "/index.html" : decoded
    guard let resource = staticResources[path] else {
      send(
        status: 404,
        reason: "Not Found",
        body: Data("not found".utf8),
        headOnly: method == "HEAD",
        on: connection
      )
      return
    }

    do {
      let data = try data(for: resource)
      send(
        status: 200,
        reason: "OK",
        body: data,
        contentType: resource.contentType,
        extraHeaders: ["Cache-Control": "no-cache"],
        headOnly: method == "HEAD",
        on: connection
      )
    } catch {
      send(
        status: 404,
        reason: "Not Found",
        body: Data("not found".utf8),
        headOnly: method == "HEAD",
        on: connection
      )
    }
  }

  private func data(for resource: StaticResource) throws -> Data {
    switch resource {
    case .file(let source, _):
      return try Data(contentsOf: root.appendingPathComponent(source))
    case .bundle(let kind, let sources, _):
      let fragments = try sources.map {
        try String(contentsOf: root.appendingPathComponent($0), encoding: .utf8)
      }
      let body = fragments.joined(separator: "\n")
      switch kind {
      case .script:
        return Data((Self.scriptBundlePrefix + body + Self.scriptBundleSuffix).utf8)
      case .style:
        return Data((Self.styleBundlePrefix + body).utf8)
      }
    }
  }

  private func send(
    status: Int,
    reason: String,
    body: Data,
    contentType: String = "text/plain; charset=utf-8",
    extraHeaders: [String: String] = [:],
    headOnly: Bool = false,
    on connection: NWConnection
  ) {
    var headers = securityHeaders
    headers["Content-Type"] = contentType
    headers["Content-Length"] = String(body.count)
    headers["Connection"] = "close"
    for (key, value) in extraHeaders {
      headers[key] = value
    }

    var response = "HTTP/1.1 \(status) \(reason)\r\n"
    for key in headers.keys.sorted() {
      response += "\(key): \(headers[key]!)\r\n"
    }
    response += "\r\n"
    var data = Data(response.utf8)
    if !headOnly { data.append(body) }

    connection.send(
      content: data,
      completion: .contentProcessed { _ in
        connection.cancel()
      })
  }

  private static let scriptBundlePrefix = "/* 此文件由 static-manifest.json 按顺序组装；请编辑 web/app/ 下的职责片段。 */\n(function () {\n  'use strict';\n\n"
  private static let scriptBundleSuffix = "\n})();\n"
  private static let styleBundlePrefix = "/* 此文件由 static-manifest.json 按顺序组装；请编辑 web/styles/ 下的职责片段。 */\n"

  private static func loadStaticResources(from root: URL) throws -> [String: StaticResource] {
    let manifestURL = root.appendingPathComponent("static-manifest.json")
    let data: Data
    do {
      data = try Data(contentsOf: manifestURL)
    } catch {
      throw ServerError.invalidStaticManifest("无法读取 static-manifest.json")
    }

    let manifest: StaticManifest
    do {
      manifest = try JSONDecoder().decode(StaticManifest.self, from: data)
    } catch {
      throw ServerError.invalidStaticManifest("JSON 格式错误：\(error.localizedDescription)")
    }

    var resources: [String: StaticResource] = [:]
    func add(_ route: String, _ resource: StaticResource) throws {
      guard isSafeRoute(route) else {
        throw ServerError.invalidStaticManifest("不安全的路由：\(route)")
      }
      guard resources[route] == nil else {
        throw ServerError.invalidStaticManifest("重复路由：\(route)")
      }
      resources[route] = resource
    }

    for file in manifest.files {
      guard isSafeSource(file.source), isContentType(file.contentType) else {
        throw ServerError.invalidStaticManifest("无效文件条目：\(file.route)")
      }
      try ensureFileExists(root.appendingPathComponent(file.source), source: file.source)
      try add(file.route, .file(source: file.source, contentType: file.contentType))
    }

    for bundle in manifest.bundles {
      guard !bundle.sources.isEmpty, isContentType(bundle.contentType) else {
        throw ServerError.invalidStaticManifest("无效 bundle：\(bundle.route)")
      }
      for source in bundle.sources {
        guard isSafeSource(source) else {
          throw ServerError.invalidStaticManifest("不安全的 bundle 片段：\(source)")
        }
        try ensureFileExists(root.appendingPathComponent(source), source: source)
      }
      try add(bundle.route, .bundle(kind: bundle.kind, sources: bundle.sources, contentType: bundle.contentType))
    }
    return resources
  }

  private static func ensureFileExists(_ url: URL, source: String) throws {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
      throw ServerError.invalidStaticManifest("资源不存在：\(source)")
    }
  }

  private static func isSafeRoute(_ route: String) -> Bool {
    guard route.hasPrefix("/"), route != "/", !route.contains("\\") else { return false }
    return !route.split(separator: "/", omittingEmptySubsequences: false).contains("..")
  }

  private static func isSafeSource(_ source: String) -> Bool {
    guard !source.isEmpty, !source.hasPrefix("/"), !source.contains("\\") else { return false }
    return source.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
      !$0.isEmpty && $0 != "." && $0 != ".."
    }
  }

  private static func isContentType(_ contentType: String) -> Bool {
    contentType.contains("/")
  }

  private let securityHeaders = [
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].joined(separator: "; "),
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  ]
}
