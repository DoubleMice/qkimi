import AppKit

MainActor.assumeIsolated {
  let application = NSApplication.shared
  application.setActivationPolicy(.regular)
  let delegate = AppDelegate()
  application.delegate = delegate
  application.run()
  withExtendedLifetime(delegate) {}
}
