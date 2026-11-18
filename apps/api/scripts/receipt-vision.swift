import Foundation
import ImageIO
import Vision

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(input as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Double,
      let height = properties[kCGImagePropertyPixelHeight] as? Double,
      width * height <= 40_000_000 else {
    exit(1)
}
let exifOrientation = properties[kCGImagePropertyOrientation] as? UInt32 ?? 1
let orientation = CGImagePropertyOrientation(rawValue: exifOrientation) ?? .up
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-CA", "fr-CA"]
try VNImageRequestHandler(data: input, orientation: orientation).perform([request])
for (index, result) in (request.results ?? []).enumerated() {
    guard let candidate = result.topCandidates(1).first else { continue }
    let box = result.boundingBox
    // Use the Tesseract TSV shape so both engines share the same column reconstruction.
    let fields = [
        "5", "1", String(index + 1), "1", "1", "1",
        String(box.minX * 1000), String((1 - box.maxY) * 1000),
        String(box.width * 1000), String(box.height * 1000),
        String(candidate.confidence * 100),
        candidate.string.replacingOccurrences(of: "\n", with: " "),
    ]
    print(fields.joined(separator: "\t"))
}
