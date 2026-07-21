import Foundation
import Network

final class LoopbackServer {
  enum ServerError: LocalizedError {
    case missingPort
    case failed(String)

    var errorDescription: String? {
      switch self {
      case .missingPort:
        return "本地页面服务未分配端口"
      case .failed(let message):
        return "本地页面服务启动失败：\(message)"
      }
    }
  }

  private let root: URL
  private let queue = DispatchQueue(label: "com.qkimi.desktop.loopback", qos: .userInitiated)
  private var listener: NWListener?
  private var startCompletion: ((Result<URL, Error>) -> Void)?

  init(root: URL) {
    self.root = root
  }

  func start(completion: @escaping (Result<URL, Error>) -> Void) {
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
    guard let fileName = publicFiles[path] else {
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
      let data = try Data(contentsOf: root.appendingPathComponent(fileName))
      send(
        status: 200,
        reason: "OK",
        body: data,
        contentType: mimeTypes[(fileName as NSString).pathExtension] ?? "application/octet-stream",
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

  private let publicFiles = [
    "/index.html": "index.html",
    "/style.css": "style.css",
    "/bootstrap.js": "bootstrap.js",
    "/markdown-it.min.js": "markdown-it.min.js",
    "/app.js": "app.js",
  ]

  private let mimeTypes = [
    "html": "text/html; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
  ]

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
