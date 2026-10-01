import ApplicationServices
import Cocoa
import CoreGraphics
import Foundation

func fail(_ message: String, code: Int32 = 1) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: ["ok": false, "error": message]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    exit(code)
}

func reply(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else {
        fail("json encode failed")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func args() -> [String: String] {
    var parsed: [String: String] = [:]
    var index = 2
    let raw = CommandLine.arguments
    while index < raw.count {
        let key = raw[index]
        if key.hasPrefix("--"), index + 1 < raw.count {
            parsed[String(key.dropFirst(2))] = raw[index + 1]
            index += 2
        } else {
            index += 1
        }
    }
    return parsed
}

func num(_ value: String?) -> Double? {
    guard let value else { return nil }
    return Double(value)
}

func int(_ value: String?) -> Int? {
    guard let value else { return nil }
    return Int(value)
}

func mainScreen() -> NSScreen {
    NSScreen.main ?? NSScreen.screens[0]
}

func displaySize() -> (CGFloat, CGFloat, CGFloat) {
    let screen = mainScreen()
    return (screen.frame.width, screen.frame.height, screen.backingScaleFactor)
}

func trusted() -> Bool {
    AXIsProcessTrusted()
}

func point(_ argv: [String: String]) -> CGPoint {
    guard let x = num(argv["x"]), let y = num(argv["y"]) else {
        fail("x and y required")
    }
    return CGPoint(x: x, y: y)
}

func mouse(_ type: CGEventType, at location: CGPoint, button: CGMouseButton) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: location, mouseButton: button) else {
        fail("mouse event failed")
    }
    event.post(tap: .cghidEventTap)
}

func click(at location: CGPoint, button: CGMouseButton, count: Int) {
    let down: CGEventType
    let up: CGEventType
    switch button {
    case .right:
        down = .rightMouseDown
        up = .rightMouseUp
    case .center:
        down = .otherMouseDown
        up = .otherMouseUp
    default:
        down = .leftMouseDown
        up = .leftMouseUp
    }
    for step in 1...count {
        guard let downEvent = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: location, mouseButton: button),
              let upEvent = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: location, mouseButton: button) else {
            fail("click event failed")
        }
        downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(step))
        upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(step))
        downEvent.post(tap: .cghidEventTap)
        upEvent.post(tap: .cghidEventTap)
    }
}

let keyCodes: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f5": 96, "a": 0, "c": 8, "v": 9, "l": 37, "t": 17, "w": 13, "r": 15, "f": 3,
]

func flags(from names: [String]) -> CGEventFlags {
    var result: CGEventFlags = []
    for name in names {
        switch name {
        case "cmd", "command", "super": result.insert(.maskCommand)
        case "shift": result.insert(.maskShift)
        case "opt", "option", "alt": result.insert(.maskAlternate)
        case "ctrl", "control": result.insert(.maskControl)
        default: break
        }
    }
    return result
}

func tapKey(_ name: String) {
    let parts = name.lowercased().split(separator: "+").map(String.init)
    let keyName = parts.last ?? name
    let mods = flags(from: Array(parts.dropLast()))
    guard let code = keyCodes[keyName] else { fail("unsupported key \(name)") }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        fail("key event failed")
    }
    down.flags = mods
    up.flags = mods
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func typeText(_ text: String) {
    for scalar in text.utf16 {
        var value = scalar
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            fail("type event failed")
        }
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &value)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &value)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

func screenshot(path: String, maxWidth: Int) {
    let (dw, dh, scale) = displaySize()
    let temp = path + ".full.png"
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-t", "png", temp]
    do {
        try capture.run()
        capture.waitUntilExit()
    } catch {
        fail(error.localizedDescription)
    }
    guard capture.terminationStatus == 0, let full = NSImage(contentsOfFile: temp) else {
        fail("screenshot failed — grant Screen Recording to NP / Electron")
    }
    try? FileManager.default.removeItem(atPath: temp)
    let targetW = min(CGFloat(maxWidth), dw)
    let targetH = targetW * (dh / dw)
    let out = NSImage(size: NSSize(width: targetW, height: targetH))
    out.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .medium
    full.draw(in: NSRect(x: 0, y: 0, width: targetW, height: targetH))
    out.unlockFocus()
    guard let tiff = out.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.62]) else {
        fail("jpeg encode failed")
    }
    do {
        try jpeg.write(to: URL(fileURLWithPath: path))
    } catch {
        fail(error.localizedDescription)
    }
    reply([
        "ok": true,
        "path": path,
        "width": Int(targetW.rounded()),
        "height": Int(targetH.rounded()),
        "display_width": Int(dw.rounded()),
        "display_height": Int(dh.rounded()),
        "scale": scale,
        "trusted": trusted(),
    ])
}

func listWindows() -> [[String: Any]] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    return info.compactMap { row in
        let name = String(row[kCGWindowName as String] as? String ?? "")
        let owner = String(row[kCGWindowOwnerName as String] as? String ?? "")
        let layer = row[kCGWindowLayer as String] as? Int ?? 0
        if owner.isEmpty || layer != 0 { return nil }
        var bounds = [String: Int]()
        if let raw = row[kCGWindowBounds as String] as? [String: Any] {
            bounds = [
                "x": Int(raw["X"] as? Double ?? 0),
                "y": Int(raw["Y"] as? Double ?? 0),
                "w": Int(raw["Width"] as? Double ?? 0),
                "h": Int(raw["Height"] as? Double ?? 0),
            ]
        }
        return ["app": owner, "title": name, "bounds": bounds]
    }
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let argv = args()
let (dw, dh, scale) = displaySize()
let mouseLoc = NSEvent.mouseLocation
let quartzY = dh - mouseLoc.y

switch command {
case "info":
    let front = NSWorkspace.shared.frontmostApplication
    reply([
        "ok": true,
        "display_width": Int(dw.rounded()),
        "display_height": Int(dh.rounded()),
        "scale": scale,
        "mouse_x": Int(mouseLoc.x.rounded()),
        "mouse_y": Int(quartzY.rounded()),
        "front_app": front?.localizedName ?? "",
        "trusted": trusted(),
    ])
case "screenshot":
    guard let path = argv["path"], !path.isEmpty else { fail("path required") }
    screenshot(path: path, maxWidth: int(argv["max"]) ?? 1280)
case "click":
    click(at: point(argv), button: .left, count: 1)
    reply(["ok": true])
case "dblclick":
    click(at: point(argv), button: .left, count: 2)
    reply(["ok": true])
case "rightclick":
    click(at: point(argv), button: .right, count: 1)
    reply(["ok": true])
case "move":
    mouse(.mouseMoved, at: point(argv), button: .left)
    reply(["ok": true])
case "drag":
    guard let x2 = num(argv["x2"]), let y2 = num(argv["y2"]) else { fail("x2 and y2 required") }
    let start = point(argv)
    let end = CGPoint(x: x2, y: y2)
    mouse(.leftMouseDown, at: start, button: .left)
    mouse(.leftMouseDragged, at: end, button: .left)
    mouse(.leftMouseUp, at: end, button: .left)
    reply(["ok": true])
case "scroll":
    let location = CGEvent(source: nil)?.location ?? CGPoint(x: dw / 2, y: dh / 2)
    if let x = num(argv["x"]), let y = num(argv["y"]) {
        mouse(.mouseMoved, at: CGPoint(x: x, y: y), button: .left)
    }
    let amount = Int32(int(argv["amount"]) ?? 3)
    let direction = (argv["direction"] ?? "down").lowercased()
    var dy: Int32 = 0
    var dx: Int32 = 0
    switch direction {
    case "up": dy = amount
    case "down": dy = -amount
    case "left": dx = amount
    case "right": dx = -amount
    default: fail("direction must be up|down|left|right")
    }
    guard let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .line,
        wheelCount: 2,
        wheel1: dy,
        wheel2: dx,
        wheel3: 0
    ) else { fail("scroll event failed") }
    event.location = CGPoint(x: num(argv["x"]) ?? location.x, y: num(argv["y"]) ?? location.y)
    event.post(tap: .cghidEventTap)
    reply(["ok": true])
case "type":
    guard let text = argv["text"] else { fail("text required") }
    typeText(text)
    reply(["ok": true])
case "key":
    guard let key = argv["key"] else { fail("key required") }
    tapKey(key)
    reply(["ok": true])
case "open":
    guard let target = argv["target"], !target.isEmpty else { fail("target required") }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    if target.contains("://") || target.hasPrefix("/") || target.contains(".") {
        process.arguments = [target]
    } else {
        process.arguments = ["-a", target]
    }
    do {
        try process.run()
        process.waitUntilExit()
        reply(["ok": process.terminationStatus == 0, "target": target])
    } catch {
        fail(error.localizedDescription)
    }
case "focus":
    guard let name = argv["app"], !name.isEmpty else { fail("app required") }
    let apps = NSWorkspace.shared.runningApplications
    if let match = apps.first(where: { $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame }) {
        match.activate()
        reply(["ok": true, "app": match.localizedName ?? name])
    } else {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", name]
        try? process.run()
        process.waitUntilExit()
        reply(["ok": process.terminationStatus == 0, "app": name])
    }
case "windows":
    reply(["ok": true, "windows": listWindows()])
default:
    fail("unknown command")
}
