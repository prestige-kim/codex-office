import AppKit
import WebKit
import Darwin

// A small, non-sandboxed local app. No model calls and no access to provider credentials.
final class OfficeApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView?
    var child: Process?
    var input: Pipe?
    var output: Pipe?
    var errors: Pipe?
    var stdoutBuffer = Data()
    var errorText = ""
    var appURL: URL?
    var profile: URL?
    var stopping = false
    var replied = false
    var ready = false
    var failurePresented = false
    var startupTimeout: DispatchWorkItem?
    let allowedPreferences: Set<String> = ["codexOffice.hiddenFloors", "codexOffice.layout", "codexOffice.night", "codexOffice.priv"]
    var preferences: [String: String] = [:]
    let env = ProcessInfo.processInfo.environment

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bundleID = Bundle.main.bundleIdentifier ?? "com.prestigekim.codexoffice"
        if let other = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first(where: { $0.processIdentifier != getpid() }) {
            other.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        makeMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "코덱스 오피스 · Claude + Codex"
        window.minSize = NSSize(width: 390, height: 560)
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.center()
        let loading = NSTextField(labelWithString: "오피스를 준비하고 있습니다…\nClaude Code와 Codex의 로컬 기록을 읽습니다.")
        loading.alignment = .center; loading.font = .systemFont(ofSize: 17)
        loading.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(loading)
        NSLayoutConstraint.activate([loading.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor), loading.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor)])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        do { try launchServer() } catch { fail(error.localizedDescription) }
    }

    func makeMenu() {
        let menu = NSMenu()
        let app = NSMenuItem(); menu.addItem(app)
        let appMenu = NSMenu(); app.submenu = appMenu
        appMenu.addItem(withTitle: "코덱스 오피스 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = NSMenuItem(); menu.addItem(file)
        let fileMenu = NSMenu(title: "파일"); file.submenu = fileMenu
        fileMenu.addItem(withTitle: "창 닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = NSMenuItem(); menu.addItem(edit)
        let editMenu = NSMenu(title: "편집"); edit.submenu = editMenu
        for (title, action, key) in [("잘라내기", "cut:", "x"), ("복사", "copy:", "c"), ("붙여넣기", "paste:", "v"), ("모두 선택", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        NSApp.mainMenu = menu
    }

    func ownProfile() throws -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let location = env["OFFICE_APP_DATA_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? home.appendingPathComponent("Library/Application Support/CodexOffice", isDirectory: true)
        let protected = [env["CODEX_HOME"] ?? home.appendingPathComponent(".codex").path,
                         env["CLAUDE_CONFIG_DIR"] ?? home.appendingPathComponent(".claude").path,
                         env["CODEX_SESSIONS_DIR"], env["CLAUDE_PROJECTS_DIR"]].compactMap { $0 }
        let p = location.standardizedFileURL.resolvingSymlinksInPath().path
        for source in protected {
            let root = URL(fileURLWithPath: source).standardizedFileURL.resolvingSymlinksInPath().path
            if p == root || p.hasPrefix(root + "/") { throw messageError("앱 설정 폴더는 Claude/Codex의 기록·설정 폴더 밖에 있어야 합니다.") }
        }
        try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return location
    }

    func launchServer() throws {
        profile = try ownProfile()
        let settingsURL = profile!.appendingPathComponent("launcher.json")
        var settings: [String: String] = [:]
        if let data = try? Data(contentsOf: settingsURL), let values = try? JSONSerialization.jsonObject(with: data) as? [String: String] { settings = values }
        let prefURL = profile!.appendingPathComponent("view-preferences.json")
        if let data = try? Data(contentsOf: prefURL), data.count <= 262144, let values = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            preferences = values.filter { allowedPreferences.contains($0.key) }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let paths = [env["OFFICE_NODE"], settings["nodePath"], "/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node", home + "/.volta/bin/node"].compactMap { $0 }
        guard let node = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw messageError("Node.js 18 이상이 필요합니다. 설치 후 앱을 다시 열거나, 앱 설정 폴더의 launcher.json에 nodePath를 지정해 주세요.")
        }
        guard let resources = Bundle.main.resourceURL else { throw messageError("앱 리소스를 찾을 수 없습니다.") }
        let office = resources.appendingPathComponent("office", isDirectory: true)
        let script = office.appendingPathComponent("desktop/server-host.js")
        guard FileManager.default.fileExists(atPath: script.path) else { throw messageError("앱 파일이 빠져 있습니다. 앱 ZIP을 다시 압축 해제해 주세요.") }
        var environment = env
        environment["OFFICE_DATA_DIR"] = profile!.path
        // Only our own launcher.json is read. Provider settings and auth files are never read.
        if let root = settings["codexSessionsDir"] { environment["CODEX_SESSIONS_DIR"] = root }
        if let root = settings["claudeProjectsDir"] { environment["CLAUDE_PROJECTS_DIR"] = root }
        environment["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        let task = Process(); child = task
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = [script.path]
        task.currentDirectoryURL = office
        task.environment = environment
        input = Pipe(); output = Pipe(); errors = Pipe()
        task.standardInput = input!; task.standardOutput = output!; task.standardError = errors!
        output!.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { DispatchQueue.main.async { self?.consume(data) } }
        }
        errors!.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { DispatchQueue.main.async { self?.errorText = String(((self?.errorText ?? "") + String(decoding: data, as: UTF8.self)).suffix(6000)) } }
        }
        task.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.startupTimeout?.cancel()
                self.removeState()
                if self.stopping { self.finishQuit() }
                else { self.fail("오피스 서버가 종료되었습니다 (코드 \(task.terminationStatus)).\n\(self.errorText)") }
            }
        }
        try task.run()
        let timeout = DispatchWorkItem { [weak self] in self?.fail("서버 시작이 지연되고 있습니다. 기록 경로와 Node.js 설치를 확인해 주세요.") }
        startupTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: timeout)
    }

    func consume(_ data: Data) {
        guard !stopping else { return }
        stdoutBuffer.append(data)
        if stdoutBuffer.count > 65536 { stdoutBuffer = Data(stdoutBuffer.suffix(32768)) }
        while let newline = stdoutBuffer.firstIndex(of: 10) {
            let line = stdoutBuffer[..<newline]
            stdoutBuffer.removeSubrange(...newline)
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let type = object["type"] as? String else { continue }
            if type == "fatal" { fail(object["message"] as? String ?? "서버를 시작하지 못했습니다."); return }
            if type == "ready", !ready, object["pid"] as? Int32 == child?.processIdentifier,
               let raw = object["url"] as? String, let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1", let port = url.port, port > 0, url.path == "/" {
                ready = true; startupTimeout?.cancel(); appURL = url
                writeState(url)
                showOffice(url)
            }
        }
    }

    func showOffice(_ url: URL) {
        let configuration = WKWebViewConfiguration()
        let controller = configuration.userContentController
        controller.add(self, name: "officePreferences")
        let jsonData = (try? JSONSerialization.data(withJSONObject: preferences, options: [.sortedKeys])) ?? Data("{}".utf8)
        let json = String(decoding: jsonData, as: UTF8.self)
        let keys = "[\"codexOffice.hiddenFloors\",\"codexOffice.layout\",\"codexOffice.night\",\"codexOffice.priv\"]"
        let script = """
        (() => { try {
          const initial = \(json), allowed = new Set(\(keys));
          const original = Storage.prototype.setItem;
          for (const [k,v] of Object.entries(initial)) original.call(localStorage,k,v);
          Storage.prototype.setItem = function(k,v) {
            original.call(this,k,v);
            if(this === localStorage && allowed.has(k)) window.webkit.messageHandlers.officePreferences.postMessage({key:k,value:String(v)});
          };
        } catch (_) {} })();
        """
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self; view.uiDelegate = self
        window.contentView = view; webView = view
        view.load(URLRequest(url: url))
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, sameOrigin(message.frameInfo.request.url),
              let values = message.body as? [String: String], let key = values["key"], let value = values["value"],
              allowedPreferences.contains(key), value.utf8.count <= 131072, let profile = profile else { return }
        preferences[key] = value
        if let data = try? JSONSerialization.data(withJSONObject: preferences, options: [.sortedKeys]) {
            try? data.write(to: profile.appendingPathComponent("view-preferences.json"), options: .atomic)
        }
    }

    func sameOrigin(_ url: URL?) -> Bool {
        guard let url = url, let base = appURL else { return false }
        return url.scheme == base.scheme && url.host == base.host && url.port == base.port
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if sameOrigin(action.request.url) { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if !stopping { fail("화면을 열지 못했습니다.\n\(error.localizedDescription)") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if !stopping { fail("화면 표시 프로세스가 종료되었습니다. 앱을 다시 실행해 주세요.") }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "확인"); alert.addButton(withTitle: "취소")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func writeState(_ url: URL) {
        guard let profile = profile, let child = child else { return }
        let state: [String: Any] = ["appPid": getpid(), "serverPid": child.processIdentifier, "url": url.absoluteString]
        if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) { try? data.write(to: profile.appendingPathComponent("server-state.json"), options: .atomic) }
    }
    func removeState() {
        guard let profile = profile else { return }
        let file = profile.appendingPathComponent("server-state.json")
        if let data = try? Data(contentsOf: file), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], value["appPid"] as? Int32 == getpid() { try? FileManager.default.removeItem(at: file) }
    }
    func fail(_ message: String) {
        guard !stopping, !failurePresented else { return }
        failurePresented = true
        startupTimeout?.cancel()
        let alert = NSAlert(); alert.alertStyle = .warning; alert.messageText = "오피스를 열 수 없습니다"; alert.informativeText = message
        alert.addButton(withTitle: "종료")
        alert.beginSheetModal(for: window) { _ in NSApp.terminate(nil) }
    }
    func messageError(_ message: String) -> NSError { NSError(domain: "CodexOffice", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window?.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let task = child, task.isRunning else { removeState(); return .terminateNow }
        if !stopping {
            stopping = true; startupTimeout?.cancel()
            try? input?.fileHandleForWriting.write(contentsOf: Data("{\"type\":\"shutdown\"}\n".utf8))
            try? input?.fileHandleForWriting.close()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self = self else { return }
                if task.isRunning { task.terminate() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    if task.isRunning { kill(task.processIdentifier, SIGKILL) }
                    self.finishQuit()
                }
            }
        }
        return .terminateLater
    }
    func finishQuit() { if !replied { replied = true; removeState(); NSApp.reply(toApplicationShouldTerminate: true) } }
    func applicationWillTerminate(_ notification: Notification) {
        try? input?.fileHandleForWriting.close()
        if let task = child, task.isRunning { task.terminate() }
        removeState()
        output?.fileHandleForReading.readabilityHandler = nil
        errors?.fileHandleForReading.readabilityHandler = nil
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = OfficeApp()
application.delegate = delegate
application.run()
