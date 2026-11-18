"""Generate and verify invented PDF fixtures with local tools."""

import argparse
import csv
import io
import re
import subprocess
from dataclasses import dataclass
from itertools import groupby
from pathlib import Path
from tempfile import TemporaryDirectory

import pymupdf as pdf
from pypdf import PdfReader, PdfWriter

DPI = 300
WIDTH, HEIGHT = 324, 144
LABEL = pdf.Rect(50, 55, 280, 98)
ANCHORS = ("PUBLIC REFERENCE", "END OF SAMPLE")
MARKERS = ("VEXMORA", "ZENTHAVO", "LUMETAVO")
GERMAN_MARKER = "FALKURO VEXAL"


@dataclass(frozen=True)
class Fixture:
    markers: tuple[str, ...]
    scanned: bool
    language: str = "eng"
    anchors: tuple[str, str] = ANCHORS


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=30, check=True)
    if args[0] != "tesseract":
        require(not result.stderr, f"{args[0]} reported a PDF warning")
    return result.stdout.decode("utf-8")


def extract_text(path):
    return run("pdftotext", "-enc", "UTF-8", str(path), "-")


def raster(page):
    return page.get_pixmap(dpi=DPI, colorspace=pdf.csRGB, alpha=False, annots=False)


def ocr(pixels, fixture):
    tsv = run("tesseract", "stdin", "stdout", "-l", fixture.language, "--dpi", str(DPI),
              "--psm", "6", "tsv", data=pixels.tobytes("png"))
    return [row for row in csv.DictReader(io.StringIO(tsv), delimiter="\t") if row["text"]]


def ocr_matches(words, marker):
    """Match consecutive word boxes on the same OCR line."""
    tokens = marker.split()

    def line_id(row):
        return row["block_num"], row["par_num"], row["line_num"]

    for _, line in groupby(words, line_id):
        rows = list(line)
        for i in range(len(rows) - len(tokens) + 1):
            candidate = rows[i:i + len(tokens)]
            if [row["text"].upper() for row in candidate] == tokens:
                yield candidate


def check_ocr(words, fixture, expected=None):
    text = " ".join(row["text"] for row in words).upper()
    require(all(anchor in text for anchor in fixture.anchors), "OCR missed unchanged text")
    if expected:
        require(len(list(ocr_matches(words, expected))) == 1, "OCR missed fixture identifier")
    forbidden = set(" ".join((*MARKERS, GERMAN_MARKER)).split()) - set((expected or "").split())
    require(not set(re.findall(r"\w+", text)) & forbidden, "OCR identifier token remained")


def check_label(pixels, bounds, *, blank):
    """Check a fixture label independently of its detected bounding box."""
    area = (LABEL * pdf.Matrix(pixels.width / bounds.width,
                               pixels.height / bounds.height)).irect
    data = pixels.samples
    white = bytes([255]) * (area.width * 3)
    rows = (
        data[y * pixels.stride + area.x0 * 3:y * pixels.stride + area.x1 * 3]
        for y in range(area.y0, area.y1)
    )
    require(all(row == white for row in rows) == blank, "labeled pixels were unexpected")


def make_source(path, fixture):
    markers = fixture.markers
    with pdf.open() as source, pdf.open() as typeset:
        for marker in markers:
            page = typeset.new_page(width=WIDTH, height=HEIGHT)
            page.insert_text((54, 36), fixture.anchors[0], fontsize=14)
            page.insert_text((54, 87), marker, fontsize=27)
            page.insert_text((54, 124), fixture.anchors[1], fontsize=14)
            if fixture.scanned:
                image_page = source.new_page(width=WIDTH, height=HEIGHT)
                image_page.insert_image(image_page.rect, pixmap=raster(page))
        document = source if fixture.scanned else typeset
        document.set_metadata({"author": markers[0]})
        document.set_xml_metadata(
            '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
            '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" '
            f'dc:description="{markers[-1]}"/></rdf:RDF></x:xmpmeta>'
        )
        document.save(path, deflate=True)


def find_box(page, image, words, marker, *, scanned):
    if scanned:
        matches = list(ocr_matches(words, marker))
        require(len(matches) == 1, "scan identifier should match once")
        box = pdf.Rect()
        for word in matches[0]:
            x, y, width, height = (int(word[key]) for key in ("left", "top", "width", "height"))
            box |= pdf.Rect(x, y, x + width, y + height)
        box *= pdf.Matrix(
            page.rect.width / image.width, page.rect.height / image.height
        )
    else:
        hits = page.search_for(marker)
        require(len(hits) == 1, "text identifier should have one text box")
        box = hits[0]
    return box + (-2, -2, 2, 2)


def verify_flat(path, expected_rasters, fixture):
    require(not extract_text(path).strip(), "export contains extractable text")
    require(not run("pdfinfo", "-meta", str(path)).strip(), "export contains XMP")
    with pdf.open(path) as document:
        require(not document.is_repaired and not document.is_encrypted, "invalid export")
        require(document.page_count == len(expected_rasters), "export page count changed")
        require(set(document.xref_get_keys(-1)) <= {"Size", "Root", "ID"},
                "unexpected PDF trailer or document metadata")
        catalog = document.pdf_catalog()
        require(set(document.xref_get_keys(catalog)) == {"Type", "Pages"},
                "unexpected PDF catalog features")
        page_tree = int(document.xref_get_key(catalog, "Pages")[1].split()[0])
        allowed = {catalog, page_tree}
        require(set(document.xref_get_keys(page_tree)) == {"Type", "Count", "Kids"},
                "unexpected page tree features")
        for page, expected in zip(document, expected_rasters, strict=True):
            images = page.get_images(full=True)
            require(len(images) == 1, "expected exactly one embedded raster per page")
            xref, mask, *_, name, _filter, referrer = images[0]
            require(mask == referrer == 0, "unexpected mask or nested image")
            streams = page.get_contents()
            require(len(streams) == 1, "unexpected page content streams")
            content = page.read_contents().decode("ascii").split()
            require(content == ["q", str(WIDTH), "0", "0", str(HEIGHT), "0", "0",
                                "cm", f"/{name}", "Do", "Q"], "unexpected page drawing commands")
            require(set(document.xref_get_keys(page.xref)) <=
                    {"Type", "Parent", "MediaBox", "Rotate", "Resources", "Contents"},
                    "unexpected PDF page features")
            resources = int(document.xref_get_key(page.xref, "Resources")[1].split()[0])
            require(set(document.xref_get_keys(resources)) == {"XObject"} and
                    document.xref_get_key(resources, f"XObject/{name}") == ("xref", f"{xref} 0 R"),
                    "unexpected page resources")
            require(set(document.xref_get_keys(xref)) <= {
                "Type", "Subtype", "Width", "Height", "BitsPerComponent",
                "ColorSpace", "Length", "Filter", "DecodeParms",
            }, "unexpected image keys or metadata")
            require(document.xref_get_key(xref, "ColorSpace") == ("name", "/DeviceRGB"),
                    "expected plain RGB image data")
            allowed.update((page.xref, resources, xref, *streams))
            embedded = pdf.Pixmap(document, xref)
            require((embedded.width, embedded.height, embedded.n, embedded.samples) ==
                    (expected.width, expected.height, expected.n, expected.samples),
                    "embedded pixels differ from the redacted working page")
            check_label(embedded, page.rect, blank=True)
            check_ocr(ocr(embedded, fixture), fixture)
            check_ocr(ocr(raster(page), fixture), fixture)
        objects = {xref for xref in range(1, document.xref_length())
                   if document.xref_object(xref) != "null"}
        require(objects == allowed, "unexpected PDF objects")


def save_flat(export, output):
    # MuPDF adds catalog producer information even to a freshly built PDF.
    # Copy only the new raster pages into a writer with no Info dictionary.
    buffer = io.BytesIO(export.tobytes(garbage=4, deflate=True))
    writer = PdfWriter()
    writer.append_pages_from_reader(PdfReader(buffer, strict=True))
    writer.metadata = None
    writer.write(output)


def prove(directory, stem, fixture):
    markers = fixture.markers
    scanned = fixture.scanned
    original = directory / f"{stem}-source.pdf"
    working = directory / f"{stem}-working.pdf"
    overlay = directory / f"{stem}-overlay.pdf"
    output = directory / f"{stem}-redacted.pdf"
    make_source(original, fixture)
    text = extract_text(original)
    require(not text.strip() if scanned else markers[0] in text, "wrong source text layer")
    require(markers[0] in run("pdfinfo", str(original)), "Info control missing")
    require(markers[-1] in run("pdfinfo", "-meta", str(original)), "XMP control missing")

    with pdf.open(original) as source, pdf.open(original) as control:
        for page, control_page, marker in zip(source, control, markers, strict=True):
            image = raster(page)
            check_label(image, page.rect, blank=False)
            words = ocr(image, fixture)
            check_ocr(words, fixture, marker)
            box = find_box(page, image, words, marker, scanned=scanned)

            control_page.draw_rect(box, color=None, fill=(1, 1, 1), overlay=True)
            overlay_image = raster(control_page)
            check_label(overlay_image, control_page.rect, blank=True)
            check_ocr(ocr(overlay_image, fixture), fixture)
            if scanned:
                hidden = pdf.Pixmap(control, control_page.get_images()[0][0])
                check_ocr(ocr(hidden, fixture), fixture, marker)

            page.add_redact_annot(box, fill=(1, 1, 1), cross_out=False)
            require(page.apply_redactions(images=pdf.PDF_REDACT_IMAGE_PIXELS,
                                          text=pdf.PDF_REDACT_TEXT_REMOVE),
                    "no redaction was applied")
        control.save(overlay)
        source.save(working, garbage=4, deflate=True)
    if not scanned:
        require(markers[0] in extract_text(overlay), "overlay text control failed")
    working_text = extract_text(working)
    require(not set(re.findall(r"\w+", working_text.upper())) &
            set(" ".join(markers).split()),
            "applied redaction left extractable identifiers")

    with pdf.open(working) as source, pdf.open() as export:
        expected = []
        for page in source:
            if scanned:
                images = page.get_images()
                require(len(images) == 1, "applied redaction left extra image references")
                redacted_scan = pdf.Pixmap(source, images[0][0])
                check_label(redacted_scan, page.rect, blank=True)
                check_ocr(ocr(redacted_scan, fixture), fixture)
            redacted = raster(page)
            check_label(redacted, page.rect, blank=True)
            fresh_page = export.new_page(width=page.rect.width, height=page.rect.height)
            xref = fresh_page.insert_image(fresh_page.rect, pixmap=redacted, keep_proportion=False)
            export.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
            expected.append(redacted)
        save_flat(export, output)
        verify_flat(output, expected, fixture)
    print(f"PASS {stem} ({len(markers)} page(s)) — source and overlay controls, "
          "applied redaction, flattened text/pixel/OCR/metadata checks")


def make_and_verify(directory, *, german):
    prove(directory, "text", Fixture(MARKERS[:1], scanned=False))
    prove(directory, "scan", Fixture(MARKERS[1:], scanned=True))
    if german:
        anchors = ("ÖFFENTLICHER AUSZUG", "ENDE DER PRÜFSEITE")
        for stem, scanned in (("german-text", False), ("german-scan", True)):
            prove(directory, stem, Fixture((GERMAN_MARKER,), scanned=scanned,
                                          language="deu", anchors=anchors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-dir", type=Path, help="retain invented PDFs in a new directory")
    parser.add_argument("--german", action="store_true",
                        help="also run German text and scan cases (requires deu)")
    args = parser.parse_args()
    if args.artifacts_dir:
        args.artifacts_dir.mkdir(mode=0o700)
        make_and_verify(args.artifacts_dir, german=args.german)
    else:
        with TemporaryDirectory(prefix="qs-213-") as name:
            make_and_verify(Path(name), german=args.german)


if __name__ == "__main__":
    main()
