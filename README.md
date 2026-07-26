# Kimi 2007

Kimi 2007 是一个复古 QQ 2007 风格的 Kimi Code macOS 客户端。它使用 Swift、AppKit 和系统自带的 WKWebView 承载现有前端，不在应用包内放入 Electron、Chromium 或 Node.js 运行时。

当前版本为 `0.1.0`，提供 macOS arm64 构建。客户端连接本机单独安装的 `kimi server`，不包含 Kimi CLI 或模型服务。

## 界面预览

以下图片使用示例会话内容，不包含本机真实对话。

桌面端采用完整三栏布局，集中展示会话列表、Markdown 对话、当前会话的任务活动与代码宠物：

![Kimi 2007 桌面三栏界面：会话、对话、活动中心与代码宠物](assets/screenshots/kimi-2007-desktop.png)

窗口变窄时自动切换为紧凑布局。会话列表和活动中心收纳为抽屉，聊天和输入区域保持可用：

<p align="center">
  <img src="assets/screenshots/kimi-2007-compact.png" alt="Kimi 2007 紧凑界面：抽屉入口、聊天与输入区" width="430">
</p>

## 已支持的功能

- 客户端与窗口：提供基于 AppKit/WKWebView 的 macOS 原生客户端，以及复用同一前端的浏览器兼容模式；原生模式支持工作区选择、窗口控制和在新窗口中打开工作区。
- 工作区与会话：可同时打开多个工作区窗口；会话可按时间、标签、日期或工作区搜索和分组，支持新建、归档、压缩、撤销、分叉和中止。
- 实时协作：通过 REST 快照与 WebSocket 增量更新显示流式回复、思考块、工具调用、任务、终端、子代理、许可请求和结构化问题。
- 编辑与输入：支持 Markdown 渲染与代码块复制、图片和文件上传、拖放或粘贴附件、`/` 会话控制命令，以及 `@` 工作区文件补全。
- 整理与偏好：支持会话标签、消息收藏知识库、会话 Markdown 导出、模型选择、许可模式、发送方式、聊天字号和消息提示音设置。
- 布局与交互：宽窄窗口自适应；紧凑布局通过抽屉保留会话和活动中心；提供命令面板、键盘操作，以及可互动、可成长的代码宠物。

## 使用前提

- macOS 12 或更高版本。
- 已安装并完成登录的 Kimi CLI。
- Kimi CLI 默认路径为 `~/.kimi-code/bin/kimi`；也可以通过 `KIMI_BIN` 指定路径。
- 编译原生客户端需要 Xcode Command Line Tools 或完整 Xcode。
- 原生 `.app` 本身不包含 Node.js；通过 `npm` 运行开发脚本、使用浏览器兼容模式，或执行 JavaScript 检查时，需要 Node.js 20 或更高版本。

客户端启动时会检查本机 `kimi server`。如果服务未运行，客户端会尝试执行 `kimi server run --keep-alive`。默认服务地址为 `http://127.0.0.1:58627`，可以通过 `KIMI_SERVER_PORT` 或 `KIMI_SERVER_BASE` 修改；令牌文件默认位于 `~/.kimi-code/server.token`，可以通过 `KIMI_SERVER_TOKEN_FILE` 修改。

## 多工作区

- 每个窗口绑定一个工作区。「文件」菜单的「新建窗口」（⌘N）和「新窗口打开工作区…」（⌘⇧N）可同时开多个窗口并行工作；左栏「工作区」面板每行的 ↗ 按钮也能把工作区开到新窗口。重启后自动恢复上次打开的窗口集合。
- 单窗口内也能纵览所有工作区：会话列表分组方式选「按工作区」，会话按工作区分节展示，点击分节头可切换到只看该工作区；工作区面板选择「全部工作区」时，会话条目会标注所属工作区。
- 浏览器兼容模式下，「新窗口打开」通过 `?cwd=<目录>` 新标签页实现（目录需真实存在）。

## 开发运行

启动 macOS 原生客户端：

```bash
npm start
```

这条命令会构建 release 版本的 `.app` 并打开它。也可以直接执行：

```bash
bash native/build.sh run
```

浏览器兼容模式：

```bash
npm run start:web
```

默认访问地址为 `http://127.0.0.1:2007`。浏览器模式使用 `tools/serve.js` 提供页面，并通过 `/env.json` 注入本机服务配置；原生客户端不提供这个 HTTP 接口，而是通过 WKWebView 原生桥接传递配置。

## 检查与打包

```bash
# 前端资源清单/组合后的 JavaScript 检查和 Swift debug 编译
npm run check

# 原生 WKWebView smoke test
npm test

# 只生成 .app
npm run package:mac

# 生成 .app、DMG 和 ZIP
npm run make:mac
```

构建产物位于 `out/`：

- `out/Kimi 2007-darwin-arm64/Kimi 2007.app`
- `out/make/Kimi 2007-0.1.0-arm64.dmg`
- `out/make/zip/darwin/arm64/Kimi 2007-darwin-arm64-0.1.0.zip`

`out/` 和 `native/.build/` 已加入 `.gitignore`。Swift 增量缓存不会进入分发包；需要清理时执行：

```bash
swift package --package-path native clean
```

## 客户端结构

- `native/Sources/Kimi2007/App/`：应用生命周期、多窗口、工作区持久化和冒烟测试；`Runtime/` 负责 Kimi 服务检测；`Web/` 负责 WKWebView 桥接和本地页面服务。
- `web/app/`、`web/styles/`：按职责拆分的前端 JavaScript/CSS 源片段；`web/static-manifest.json` 定义仅可访问的静态路由及虚拟 `/app.js`、`/style.css` 的组合顺序；`runtime/`、`vendor/`、`assets/` 存放启动器、第三方库和图片。
- `tools/serve.js`：浏览器兼容模式的本地 HTTP 服务和运行配置注入；`tools/web-assets.js` 负责校验并交付受控资源清单。
- `docs/`：本地过程记录（`DESKTOP.md` 原生客户端说明、`todolist.md` 在途工作）。
- `native/build.sh`：原生 `.app`、DMG 和 ZIP 的构建脚本。
- `native/smoke.sh`：原生 WKWebView 端到端 smoke test，由 `npm test` 调用。

原生客户端的页面服务只绑定本机回环地址，并且只提供 `web/static-manifest.json` 中列出的路由；源片段与清单自身不会直接暴露。工作区保存在 macOS `UserDefaults`，不会写入项目源码目录。原生客户端页面中的外部 HTTP(S) 链接交给系统浏览器打开，应用页面不能导航到其他来源。

## 前端资源组织

`web/static-manifest.json` 同时定义浏览器模式和原生模式的资源路由：

- `/app.js` 按清单顺序组合 `web/app/` 片段，并在一个私有 IIFE 中执行；各片段可共享状态，但不会把内部函数挂到 `window`。
- `/style.css` 按清单顺序组合 `web/styles/` 片段。样式覆盖关系由清单中的顺序决定。
- `runtime/bootstrap.js`、`vendor/markdown-it.min.js` 和 `assets/pet-kimi.png` 以独立文件路由提供。

浏览器模式由 `tools/web-assets.js` 读取清单；原生模式由
`Web/LoopbackServer.swift` 读取同一份清单。两端都只匹配清单中的路由，因此直接请求
`/app/core.js` 或 `/static-manifest.json` 会得到 404。`native/build.sh` 会复制整个 `web/`
目录，以便原生页面服务在运行时组合资源。

新增前端文件时：若它只参与 `/app.js` 或 `/style.css`，把它加入相应 bundle 的
`sources`；若页面需要直接请求它，再加入 `files`。随后运行 `npm run check`，它会读取
清单并检查实际交付的 `/app.js`。

## 发布说明

当前构建使用 ad-hoc 签名，只适合本机或内部验证。对外发布前还需要：

- Apple Developer 的 Developer ID Application 签名。
- Apple notarization 公证并将票据 stapling 到应用或安装包。
- 自动更新和正式发布流水线（当前尚未接入）。

因此，当前产物可以用于本机验证，但不能作为消除 Gatekeeper 提示的公开 macOS 安装包。

## 运行边界

Kimi 2007 只负责客户端窗口、页面和本机 Kimi 服务连接。Kimi CLI 的登录状态、服务令牌、模型调用和实际任务执行仍由本机 Kimi 环境负责。
