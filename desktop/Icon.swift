import AppKit

let folder = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let scale = CGFloat(size) / 1024
    let transform = NSAffineTransform()
    transform.scale(by: scale)
    transform.concat()
    NSColor(calibratedRed: 0.18, green: 0.20, blue: 0.40, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 30, y: 30, width: 964, height: 964), xRadius: 205, yRadius: 205).fill()
    NSColor(calibratedRed: 0.91, green: 0.94, blue: 1.0, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 200, y: 180, width: 624, height: 650), xRadius: 45, yRadius: 45).fill()
    for row in 0..<3 { for col in 0..<3 {
        let color = (row + col) % 2 == 0 ? NSColor(calibratedRed: 0.91, green: 0.48, blue: 0.27, alpha: 1) : NSColor(calibratedRed: 0.08, green: 0.63, blue: 0.52, alpha: 1)
        color.setFill()
        NSBezierPath(roundedRect: NSRect(x: 270 + col * 172, y: 350 + row * 146, width: 132, height: 104), xRadius: 18, yRadius: 18).fill()
    } }
    NSColor(calibratedRed: 0.18, green: 0.20, blue: 0.40, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 444, y: 180, width: 136, height: 142), xRadius: 16, yRadius: 16).fill()
    NSGraphicsContext.restoreGraphicsState()
    let data = bitmap.representation(using: .png, properties: [:])!
    let base = size == 1024 ? "icon_512x512@2x.png" : "icon_\(size)x\(size).png"
    if size != 64 { try data.write(to: URL(fileURLWithPath: folder + "/" + base)) }
    if [32, 64, 256, 512].contains(size) { try data.write(to: URL(fileURLWithPath: folder + "/icon_\(size / 2)x\(size / 2)@2x.png")) }
}
