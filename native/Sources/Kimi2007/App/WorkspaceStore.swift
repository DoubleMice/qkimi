import Foundation

/// 单个窗口的工作区上下文：持有本窗口绑定的目录，并负责
/// 「默认工作区」与「打开窗口集合」的 UserDefaults 持久化。
final class WorkspaceStore {
  private static let defaultKey = "workspace"
  private static let openKey = "openWorkspaces"

  private(set) var workspace: String

  init(workspace: String) {
    self.workspace = WorkspaceStore.standardize(workspace)
  }

  func setWorkspace(_ path: String) {
    workspace = WorkspaceStore.standardize(path)
    UserDefaults.standard.set(workspace, forKey: WorkspaceStore.defaultKey)
  }

  /// 新建窗口的默认工作区：QKIMI_WORKSPACE → 上次选择 → 用户 Documents。
  static func defaultWorkspace() -> String {
    let environment = ProcessInfo.processInfo.environment
    let configured = environment["QKIMI_WORKSPACE"] ?? UserDefaults.standard.string(forKey: defaultKey)
    if let configured, isDirectory(configured) {
      return standardize(configured)
    }
    return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
      .first?.path ?? FileManager.default.homeDirectoryForCurrentUser.path
  }

  /// 上次退出时打开的窗口工作区集合（去重、仅保留仍然存在的目录）。
  static func savedOpenWorkspaces() -> [String] {
    let saved = UserDefaults.standard.stringArray(forKey: openKey) ?? []
    var seen = Set<String>()
    return saved.compactMap { path in
      guard isDirectory(path) else { return nil }
      let standardized = standardize(path)
      return seen.insert(standardized).inserted ? standardized : nil
    }
  }

  static func saveOpenWorkspaces(_ paths: [String]) {
    UserDefaults.standard.set(paths, forKey: openKey)
  }

  static func isDirectory(_ path: String) -> Bool {
    var isDirectory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
      && isDirectory.boolValue
  }

  private static func standardize(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.path
  }
}
