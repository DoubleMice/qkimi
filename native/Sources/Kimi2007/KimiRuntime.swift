import Foundation

final class KimiRuntime {
  enum RuntimeError: LocalizedError {
    case invalidBaseURL(String)
    case missingToken
    case launchFailed(String)
    case startupTimeout

    var errorDescription: String? {
      switch self {
      case .invalidBaseURL(let value):
        return "Kimi 服务地址无效：\(value)"
      case .missingToken:
        return "无法读取 Kimi 服务令牌，请确认 Kimi CLI 已完成登录"
      case .launchFailed(let message):
        return "无法启动 Kimi CLI：\(message)"
      case .startupTimeout:
        return "Kimi 服务启动超时，请运行 `kimi server run --keep-alive` 排查"
      }
    }
  }

  let baseURL: URL
  private let tokenFile: URL
  private let serverPort: Int
  private var initialToken: String?
  private var daemonProcess: Process?
  private(set) var workspace: String

  init() throws {
    let environment = ProcessInfo.processInfo.environment
    let port = Int(environment["KIMI_SERVER_PORT"] ?? "58627") ?? 58627
    let base = environment["KIMI_SERVER_BASE"] ?? "http://127.0.0.1:\(port)"
    guard let parsedBase = URL(string: base), parsedBase.scheme != nil else {
      throw RuntimeError.invalidBaseURL(base)
    }

    baseURL = parsedBase
    serverPort = port

    let tokenPath =
      environment["KIMI_SERVER_TOKEN_FILE"]
      ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".kimi-code/server.token").path
    tokenFile = URL(fileURLWithPath: tokenPath)

    let configured =
      environment["QKIMI_WORKSPACE"] ?? UserDefaults.standard.string(forKey: "workspace")
    if let configured, KimiRuntime.isDirectory(configured) {
      workspace = URL(fileURLWithPath: configured).standardizedFileURL.path
    } else {
      workspace =
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
        .first?.path ?? FileManager.default.homeDirectoryForCurrentUser.path
    }
  }

  func setWorkspace(_ path: String) {
    workspace = URL(fileURLWithPath: path).standardizedFileURL.path
    UserDefaults.standard.set(workspace, forKey: "workspace")
  }

  func environmentDictionary() throws -> [String: Any] {
    guard let token = readToken() ?? initialToken, !token.isEmpty else {
      throw RuntimeError.missingToken
    }
    return [
      "base": baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
      "token": token,
      "model": "kimi-code/k3",
      "cwd": workspace,
    ]
  }

  func ensureServer(completion: @escaping (Result<Void, Error>) -> Void) {
    let token = readToken()
    checkHealthy(token: token) { [weak self] healthy in
      guard let self else { return }
      if healthy, let token {
        self.initialToken = token
        self.finish(.success(()), completion: completion)
        return
      }

      do {
        try self.launchDaemon()
        self.pollUntilHealthy(attempt: 0, completion: completion)
      } catch {
        self.finish(.failure(error), completion: completion)
      }
    }
  }

  private func pollUntilHealthy(
    attempt: Int,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    guard attempt < 30 else {
      finish(.failure(RuntimeError.startupTimeout), completion: completion)
      return
    }

    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1) { [weak self] in
      guard let self else { return }
      let token = self.readToken()
      self.checkHealthy(token: token) { healthy in
        if healthy, let token {
          self.initialToken = token
          self.finish(.success(()), completion: completion)
        } else {
          self.pollUntilHealthy(attempt: attempt + 1, completion: completion)
        }
      }
    }
  }

  private func checkHealthy(token: String?, completion: @escaping (Bool) -> Void) {
    guard let token, !token.isEmpty else {
      completion(false)
      return
    }
    var request = URLRequest(url: baseURL.appendingPathComponent("api/v1/meta"))
    request.timeoutInterval = 2
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: request) { _, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      completion((200..<300).contains(status))
    }.resume()
  }

  private func launchDaemon() throws {
    let environment = ProcessInfo.processInfo.environment
    let installed = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".kimi-code/bin/kimi")
    let configured = environment["KIMI_BIN"]
    let process = Process()

    if let configured, configured.contains("/") {
      process.executableURL = URL(fileURLWithPath: configured)
      process.arguments = daemonArguments
    } else if FileManager.default.isExecutableFile(atPath: installed.path) {
      process.executableURL = installed
      process.arguments = daemonArguments
    } else {
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = [configured ?? "kimi"] + daemonArguments
    }

    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      daemonProcess = process
    } catch {
      throw RuntimeError.launchFailed(error.localizedDescription)
    }
  }

  private var daemonArguments: [String] {
    ["server", "run", "--keep-alive", "--port", String(serverPort)]
  }

  private func readToken() -> String? {
    guard let data = try? Data(contentsOf: tokenFile),
      let value = String(data: data, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines),
      !value.isEmpty
    else {
      return nil
    }
    return value
  }

  private func finish(
    _ result: Result<Void, Error>,
    completion: @escaping (Result<Void, Error>) -> Void
  ) {
    DispatchQueue.main.async { completion(result) }
  }

  private static func isDirectory(_ path: String) -> Bool {
    var isDirectory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
      && isDirectory.boolValue
  }
}
