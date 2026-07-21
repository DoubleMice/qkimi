// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "Kimi2007Native",
  platforms: [.macOS(.v12)],
  products: [
    .executable(name: "Kimi2007", targets: ["Kimi2007"]),
  ],
  targets: [
    .executableTarget(
      name: "Kimi2007",
      path: "Sources/Kimi2007",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("Network"),
        .linkedFramework("WebKit"),
      ]
    ),
  ]
)
