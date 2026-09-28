import AppKit
import Foundation

private let maximumItems = 256
private let maximumTypesPerItem = 256
private let maximumRepresentationBytes = 64 * 1024 * 1024
private let maximumTotalBytes = 256 * 1024 * 1024

private struct Representation {
    let type: NSPasteboard.PasteboardType
    let data: Data
}

private typealias Snapshot = [[Representation]]

private func emit(_ value: String) {
    FileHandle.standardOutput.write(Data((value + "\n").utf8))
}

private func capture(_ pasteboard: NSPasteboard) -> Snapshot? {
    let items = pasteboard.pasteboardItems ?? []
    guard items.count <= maximumItems else { return nil }

    var totalBytes = 0
    var snapshot: Snapshot = []
    snapshot.reserveCapacity(items.count)

    for item in items {
        let types = item.types
        guard types.count <= maximumTypesPerItem else { return nil }
        var representations: [Representation] = []
        representations.reserveCapacity(types.count)
        for type in types {
            guard let data = item.data(forType: type),
                  data.count <= maximumRepresentationBytes,
                  data.count <= maximumTotalBytes - totalBytes else {
                return nil
            }
            totalBytes += data.count
            representations.append(Representation(type: type, data: data))
        }
        snapshot.append(representations)
    }
    return snapshot
}

private func restore(_ snapshot: Snapshot, to pasteboard: NSPasteboard) -> Bool {
    pasteboard.clearContents()
    if !snapshot.isEmpty {
        let items = snapshot.map { representations -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for representation in representations {
                item.setData(representation.data, forType: representation.type)
            }
            return item
        }
        guard pasteboard.writeObjects(items) else { return false }
    }

    guard let restored = capture(pasteboard), restored.count == snapshot.count else {
        return false
    }
    for (expectedItem, actualItem) in zip(snapshot, restored) {
        guard expectedItem.count == actualItem.count else { return false }
        let actual = Dictionary(uniqueKeysWithValues: actualItem.map { ($0.type.rawValue, $0.data) })
        guard actual.count == expectedItem.count else { return false }
        for expected in expectedItem where actual[expected.type.rawValue] != expected.data {
            return false
        }
    }
    return true
}

let pasteboard = NSPasteboard.general
guard let snapshot = capture(pasteboard) else {
    exit(2)
}

emit("ready")
_ = readLine()
if restore(snapshot, to: pasteboard) {
    emit("restored")
    exit(0)
}
emit("restore-failed")
exit(3)
