#!/usr/bin/env python3
"""Prepare and validate a local UI evidence archive; never capture images.

Only Python's standard library is used. PNG checks establish file integrity and
dimensions, not that an image is an authentic capture of the declared product.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import struct
import sys
import tempfile
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit


SCHEMA_VERSION = 1
SHA_RE = re.compile(r"[0-9a-fA-F]{40}\Z")
ID_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\Z")
PLACEHOLDER_RE = re.compile(r"(?::[a-zA-Z][a-zA-Z0-9_-]*|\[[a-zA-Z][a-zA-Z0-9_-]*\])\Z")
STATIC_SEGMENT_RE = re.compile(r"[a-zA-Z0-9_-]{1,80}\Z")
STATUSES = {"pending", "blocked", "captured", "not_applicable"}
DATA_SOURCES = {"synthetic", "public-readonly"}
ITEM_KEYS = {
    "caseId", "viewportId", "image", "fullPageImage", "status", "reason",
    "dataSource", "observed",
}
MAX_JSON_BYTES = 10 * 1024 * 1024
MAX_PNG_BYTES = 100 * 1024 * 1024
MAX_PIXEL_BYTES = 256 * 1024 * 1024
BANGKOK = timezone(timedelta(hours=7), "Asia/Bangkok")
IDENTITY_KEYS = ("schemaVersion", "version", "frontendSha", "backendSha", "phase", "source",
                 "createdAtUtc", "createdAtBangkok", "casesSha256", "expectedPairs")


class ArchiveError(Exception):
    """A user-actionable input or evidence error."""


def timestamps(prefix: str) -> dict[str, str]:
    moment = datetime.now(timezone.utc)
    return {f"{prefix}Utc": moment.isoformat(timespec="seconds").replace("+00:00", "Z"),
            f"{prefix}Bangkok": moment.astimezone(BANGKOK).isoformat(timespec="seconds")}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def object_no_duplicates(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ArchiveError(f"JSON contains a duplicate key: {key}")
        result[key] = value
    return result


def read_bytes(path: Path, limit: int) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise ArchiveError(f"Expected a regular file, not a symlink: {path}")
    if path.stat().st_size > limit:
        raise ArchiveError(f"File exceeds the {limit}-byte limit: {path}")
    return path.read_bytes()


def read_json(path: Path) -> tuple[object, bytes]:
    raw = read_bytes(path, MAX_JSON_BYTES)
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=object_no_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ArchiveError(f"Invalid UTF-8 JSON in {path}: {exc}") from exc
    return value, raw


def write_bytes(path: Path, raw: bytes) -> None:
    if path.is_symlink():
        raise ArchiveError(f"Refusing to write through a symlink: {path}")
    # A replacement is atomic; sealed archives never call this function.
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".archive-", delete=False) as temp:
        temporary = Path(temp.name)
        temp.write(raw)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def exact_keys(value: object, expected: set[str], label: str) -> dict:
    if not isinstance(value, dict):
        raise ArchiveError(f"{label} must be a JSON object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ArchiveError(f"{label} fields differ (missing={missing}, unexpected={extra})")
    return value


def clean_text(value: object, label: str, *, required: bool = True, max_length: int = 2000) -> str:
    if not isinstance(value, str) or len(value) > max_length:
        raise ArchiveError(f"{label} must be text of at most {max_length} characters")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ArchiveError(f"{label} cannot contain control characters")
    if required and not value.strip():
        raise ArchiveError(f"{label} cannot be empty")
    return value


def clean_id(value: object, label: str) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ArchiveError(f"{label} needs a 1-80 character ASCII identifier (letters, digits, _ or -)")
    return value


def clean_origin(value: object) -> str:
    text = clean_text(value, "source", max_length=500)
    try:
        parts = urlsplit(text)
        port = parts.port  # Validate port syntax and range.
        del port
    except ValueError as exc:
        raise ArchiveError(f"source is not a valid HTTP(S) origin: {exc}") from exc
    if (parts.scheme not in {"http", "https"} or not parts.hostname or
            parts.username is not None or parts.password is not None or
            parts.path not in {"", "/"} or parts.query or parts.fragment or
            "?" in text or "#" in text or "@" in text or "%" in text or "\\" in text or
            any(character.isspace() for character in text)):
        raise ArchiveError("source must be a sanitized HTTP(S) origin only, without path, credentials, query or fragment")
    return f"{parts.scheme}://{parts.netloc}".rstrip("/")


def clean_route(value: object, label: str) -> str:
    route = clean_text(value, label, max_length=500)
    if not route.startswith("/") or any(character in route for character in "?#%\\") or "//" in route:
        raise ArchiveError(f"{label} must be a sanitized local route template without URL, query or fragment")
    segments = route.strip("/").split("/") if route != "/" else []
    for index, segment in enumerate(segments):
        if not (STATIC_SEGMENT_RE.fullmatch(segment) or PLACEHOLDER_RE.fullmatch(segment)):
            raise ArchiveError(f"{label} has an invalid route segment; use :id or [id] for dynamic values")
        # Common capability/public-code routes require placeholders. This is
        # not a substitute for the operator's redaction review of other routes.
        if index and segments[index - 1] in {"p", "m", "rm", "manage", "share"}:
            if not PLACEHOLDER_RE.fullmatch(segment):
                raise ArchiveError(f"{label} includes a raw dynamic value; replace it with :code or [code]")
    return route


def validate_cases(value: object) -> dict:
    plan = exact_keys(value, {"viewports", "cases"}, "case plan")
    if not isinstance(plan["viewports"], list) or not plan["viewports"]:
        raise ArchiveError("viewports must be a nonempty array")
    if not isinstance(plan["cases"], list) or not plan["cases"]:
        raise ArchiveError("cases must be a nonempty array")
    viewport_ids = set()
    for viewport in plan["viewports"]:
        viewport = exact_keys(viewport, {"id", "width", "height"}, "viewport")
        identifier = clean_id(viewport["id"], "viewport.id")
        if identifier in viewport_ids:
            raise ArchiveError(f"Duplicate viewport id: {identifier}")
        viewport_ids.add(identifier)
        for dimension in ("width", "height"):
            number = viewport[dimension]
            if type(number) is not int or not 1 <= number <= 16384:
                raise ArchiveError(f"viewport {identifier}.{dimension} must be an integer from 1 to 16384")
    case_ids = set()
    for case in plan["cases"]:
        base_keys = {"id", "title", "route", "viewports", "fullPageRequired"}
        if not isinstance(case, dict) or not base_keys <= set(case) or set(case) - base_keys - {"captureType"}:
            raise ArchiveError("case needs id, title, route, viewports, fullPageRequired; only captureType is optional")
        identifier = clean_id(case["id"], "case.id")
        if identifier in case_ids:
            raise ArchiveError(f"Duplicate case id: {identifier}")
        case_ids.add(identifier)
        clean_text(case["title"], f"case {identifier}.title", max_length=500)
        clean_route(case["route"], f"case {identifier}.route")
        if type(case["fullPageRequired"]) is not bool:
            raise ArchiveError(f"case {identifier}.fullPageRequired must be a boolean")
        capture_type = case.get("captureType", "viewport")
        if capture_type not in {"viewport", "native-surface"}:
            raise ArchiveError(f"case {identifier}.captureType must be viewport or native-surface")
        if capture_type == "native-surface" and case["fullPageRequired"]:
            raise ArchiveError(f"native-surface case {identifier} cannot require a full-page image")
        if not isinstance(case["viewports"], list) or not case["viewports"]:
            raise ArchiveError(f"case {identifier}.viewports must be a nonempty array")
        selected = set()
        for viewport in case["viewports"]:
            clean_id(viewport, f"case {identifier}.viewport")
            if viewport not in viewport_ids or viewport in selected:
                raise ArchiveError(f"case {identifier} has an unknown or repeated viewport: {viewport}")
            selected.add(viewport)
    if len(expected_pairs(plan)) > 10000:
        raise ArchiveError("Case plan exceeds 10000 case/viewport combinations")
    return plan


def expected_pairs(plan: dict) -> list[tuple[str, str]]:
    return [(case["id"], viewport) for case in plan["cases"] for viewport in case["viewports"]]


def init_archive(args: argparse.Namespace) -> int:
    if not SHA_RE.fullmatch(args.frontend_sha):
        raise ArchiveError("frontend-sha must be the actual running frontend's full 40-character hexadecimal SHA")
    if args.backend_sha != "unknown" and not SHA_RE.fullmatch(args.backend_sha):
        raise ArchiveError("backend-sha must be a full 40-character hexadecimal SHA or unknown")
    version = clean_text(args.version, "version", max_length=100)
    source = clean_origin(args.source)
    plan, _ = read_json(Path(args.cases).expanduser())
    plan = validate_cases(plan)
    frozen = json_bytes(plan)
    scope_hash = digest(frozen)
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", version).strip("-")[:60] or "version"
    timestamp = datetime.now(BANGKOK).strftime("%Y%m%dT%H%M%S%f%z")
    run_name = f"{timestamp}-{slug}-{args.frontend_sha[:12].lower()}-{args.phase}-{uuid.uuid4().hex[:8]}"
    root = Path(args.root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    run_dir = root / run_name
    run_dir.mkdir(exist_ok=False)
    (run_dir / "images").mkdir()
    coverage = {
        "schemaVersion": SCHEMA_VERSION,
        "casesSha256": scope_hash,
        "items": [{
            "caseId": case_id, "viewportId": viewport_id, "image": None,
            "fullPageImage": None, "status": "pending", "reason": "",
            "dataSource": None, "observed": "",
        } for case_id, viewport_id in expected_pairs(plan)],
    }
    manifest = {
        "schemaVersion": SCHEMA_VERSION, **timestamps("createdAt"), "version": version,
        "frontendSha": args.frontend_sha.lower(), "backendSha": args.backend_sha.lower(),
        "phase": args.phase, "source": source, "casesSha256": scope_hash,
        "expectedPairs": [list(pair) for pair in expected_pairs(plan)],
        "complete": False, "sealed": False, "status": "incomplete",
        "counts": {"expected": len(coverage["items"]), "pending": len(coverage["items"]),
                   "captured": 0, "not_applicable": 0, "blocked": 0},
        "evidence": {},
        "limitations": ["This tool does not capture images or verify their authenticity.",
                        "Completeness means the frozen declared matrix is covered, not that every possible product state was discovered."],
    }
    write_bytes(run_dir / "cases.json", frozen)
    write_bytes(run_dir / "coverage.json", json_bytes(coverage))
    write_bytes(run_dir / "manifest.json", json_bytes(manifest))
    (run_dir / "cases.json").chmod(0o444)
    write_bytes(run_dir / "index.html", gallery(manifest, coverage, plan))
    refresh_root_index(root)
    print(run_dir)
    return 0


def local_image(run_dir: Path, value: object, label: str) -> tuple[Path, str]:
    text = clean_text(value, label, max_length=500)
    path = Path(text)
    if (path.is_absolute() or "\\" in text or "?" in text or "#" in text or
            any(part in {".", ".."} for part in text.split("/")) or
            not path.parts or path.parts[0] != "images" or path.suffix.lower() != ".png"):
        raise ArchiveError(f"{label} must be a relative PNG path inside images/, without path traversal")
    target = run_dir / path
    if target.is_symlink():
        raise ArchiveError(f"{label} cannot be a symlink")
    try:
        target.resolve(strict=True).relative_to(run_dir)
    except (ValueError, FileNotFoundError, RuntimeError) as exc:
        raise ArchiveError(f"{label} does not exist inside this archive: {text}") from exc
    for parent in target.parents:
        if parent == run_dir:
            break
        if parent.is_symlink():
            raise ArchiveError(f"{label} cannot pass through a symlink")
    return target, path.as_posix()


def validate_png(path: Path) -> tuple[int, int, str]:
    raw = read_bytes(path, MAX_PNG_BYTES)
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ArchiveError(f"Not a PNG file: {path.name}")
    offset = 8
    dimensions = None
    saw_idat = False
    ended_idat = False
    idat_ranges = []
    expected_pixel_bytes = None
    scanline_specs = []
    ended = False
    while offset < len(raw):
        if offset + 12 > len(raw):
            raise ArchiveError(f"Truncated PNG chunk: {path.name}")
        length = struct.unpack(">I", raw[offset:offset + 4])[0]
        kind = raw[offset + 4:offset + 8]
        end = offset + 12 + length
        if end > len(raw):
            raise ArchiveError(f"Truncated PNG data: {path.name}")
        content = raw[offset + 8:offset + 8 + length]
        expected_crc = struct.unpack(">I", raw[offset + 8 + length:end])[0]
        if zlib.crc32(kind + content) & 0xFFFFFFFF != expected_crc:
            raise ArchiveError(f"PNG CRC mismatch: {path.name}")
        if dimensions is None:
            if kind != b"IHDR" or length != 13:
                raise ArchiveError(f"PNG must begin with a 13-byte IHDR: {path.name}")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", content)
            allowed_depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
            if (not 1 <= width <= 16384 or not 1 <= height <= 1000000 or
                    depth not in allowed_depths.get(color, set()) or compression != 0 or filtering != 0 or interlace not in {0, 1}):
                raise ArchiveError(f"Invalid PNG IHDR: {path.name}")
            dimensions = (width, height)
            channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
            if interlace == 0:
                scanline_specs = [((width * channels * depth + 7) // 8, height)]
            else:
                for start_x, start_y, step_x, step_y in ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)):
                    pass_width = max(0, (width - start_x + step_x - 1) // step_x)
                    pass_height = max(0, (height - start_y + step_y - 1) // step_y)
                    if pass_width and pass_height:
                        scanline_specs.append(((pass_width * channels * depth + 7) // 8, pass_height))
            expected_pixel_bytes = sum((row_bytes + 1) * rows for row_bytes, rows in scanline_specs)
            if expected_pixel_bytes > MAX_PIXEL_BYTES:
                raise ArchiveError(f"PNG decoded data would exceed the {MAX_PIXEL_BYTES}-byte validation limit: {path.name}")
        elif kind == b"IHDR":
            raise ArchiveError(f"Duplicate PNG IHDR: {path.name}")
        if kind == b"IDAT":
            if ended_idat:
                raise ArchiveError(f"PNG IDAT chunks must be consecutive: {path.name}")
            saw_idat = True
            idat_ranges.append((offset + 8, offset + 8 + length))
        elif saw_idat:
            ended_idat = True
        if kind == b"IEND":
            if length != 0 or end != len(raw):
                raise ArchiveError(f"Invalid PNG IEND or trailing data: {path.name}")
            ended = True
            break
        offset = end
    if dimensions is None or not saw_idat or not ended:
        raise ArchiveError(f"PNG needs IHDR, IDAT and IEND chunks: {path.name}")
    decoded_bytes = 0
    decoder = zlib.decompressobj()
    spec_index = 0
    rows_left = scanline_specs[0][1]
    row_bytes_left = 0
    try:
        for begin, end in idat_ranges:
            for position in range(begin, end, 65536):
                pending = memoryview(raw)[position:min(position + 65536, end)]
                while pending:
                    output = decoder.decompress(pending, 65536)
                    decoded_bytes += len(output)
                    if decoded_bytes > expected_pixel_bytes or decoder.unused_data:
                        raise ArchiveError(f"PNG IDAT has excess decoded or trailing compressed data: {path.name}")
                    pixel_offset = 0
                    while pixel_offset < len(output):
                        if row_bytes_left == 0:
                            while rows_left == 0:
                                spec_index += 1
                                if spec_index >= len(scanline_specs):
                                    raise ArchiveError(f"PNG IDAT has excess scanlines: {path.name}")
                                rows_left = scanline_specs[spec_index][1]
                            if output[pixel_offset] > 4:
                                raise ArchiveError(f"PNG scanline has an invalid filter byte: {path.name}")
                            pixel_offset += 1
                            row_bytes_left = scanline_specs[spec_index][0]
                            rows_left -= 1
                        consumed = min(row_bytes_left, len(output) - pixel_offset)
                        row_bytes_left -= consumed
                        pixel_offset += consumed
                    remainder = decoder.unconsumed_tail
                    if remainder and len(remainder) == len(pending) and not output:
                        raise ArchiveError(f"PNG IDAT decoder made no progress: {path.name}")
                    pending = remainder
    except zlib.error as exc:
        raise ArchiveError(f"PNG IDAT is not a valid zlib stream: {path.name}: {exc}") from exc
    if not decoder.eof or decoded_bytes != expected_pixel_bytes:
        raise ArchiveError(f"PNG IDAT is truncated or has an incorrect decoded length: {path.name}")
    return dimensions[0], dimensions[1], digest(raw)


def validate_coverage(run_dir: Path, coverage: object, plan: dict, scope_hash: str) -> tuple[dict, dict]:
    coverage = exact_keys(coverage, {"schemaVersion", "casesSha256", "items"}, "coverage")
    if coverage["schemaVersion"] != SCHEMA_VERSION or coverage["casesSha256"] != scope_hash:
        raise ArchiveError("coverage schema or frozen cases hash has changed")
    if not isinstance(coverage["items"], list):
        raise ArchiveError("coverage.items must be an array")
    expected = set(expected_pairs(plan))
    seen = set()
    counts = {"expected": len(expected), **{status: 0 for status in sorted(STATUSES)}}
    cases_by_id = {case["id"]: case for case in plan["cases"]}
    viewports = {viewport["id"]: viewport for viewport in plan["viewports"]}
    images = {}
    for index, item in enumerate(coverage["items"]):
        item = exact_keys(item, ITEM_KEYS, f"coverage.items[{index}]")
        pair = (clean_id(item["caseId"], "coverage.caseId"), clean_id(item["viewportId"], "coverage.viewportId"))
        if pair not in expected or pair in seen:
            raise ArchiveError(f"Unexpected or duplicate coverage pair: {pair[0]} / {pair[1]}")
        seen.add(pair)
        capture_type = cases_by_id[pair[0]].get("captureType", "viewport")
        status = item["status"]
        if not isinstance(status, str) or status not in STATUSES:
            raise ArchiveError(f"Unknown status for {pair[0]} / {pair[1]}")
        counts[status] += 1
        clean_text(item["reason"], "coverage.reason", required=False)
        clean_text(item["observed"], "coverage.observed", required=False)
        if item["dataSource"] is not None and item["dataSource"] not in DATA_SOURCES:
            raise ArchiveError("dataSource must be synthetic, public-readonly or null")
        for field in ("image", "fullPageImage"):
            if item[field] is not None and not isinstance(item[field], str):
                raise ArchiveError(f"{field} must be a relative PNG path or null")
        if status == "not_applicable":
            if capture_type == "native-surface":
                clean_text(item["observed"], f"Evidence basis for not_applicable native-surface case {pair[0]} / {pair[1]}")
            clean_text(item["reason"], f"not_applicable reason for {pair[0]} / {pair[1]}")
            if item["image"] is not None or item["fullPageImage"] is not None:
                raise ArchiveError("not_applicable rows cannot contain screenshot paths")
        if status != "captured":
            continue
        clean_text(item["observed"], f"observed description for {pair[0]} / {pair[1]}")
        if capture_type == "native-surface":
            for field in ("os", "browser", "cssViewport", "dpr", "bounds"):
                if not re.search(r"\b" + field + r"\s*=\s*[^;；,，\s]", item["observed"], re.IGNORECASE):
                    raise ArchiveError(f"Native-surface observed needs os=, browser=, cssViewport=, dpr= and bounds= descriptions; missing {field}=")
            if item["fullPageImage"] is not None:
                raise ArchiveError("Native-surface rows use image only, not fullPageImage")
        if item["dataSource"] not in DATA_SOURCES:
            raise ArchiveError(f"captured row {pair[0]} / {pair[1]} needs synthetic or public-readonly dataSource")
        viewport = viewports[pair[1]]
        required_full_page = cases_by_id[pair[0]]["fullPageRequired"]
        if required_full_page and item["fullPageImage"] is None:
            raise ArchiveError(f"A full-page image is required for {pair[0]} / {pair[1]}")
        for field in ("image", "fullPageImage"):
            if field == "fullPageImage" and item[field] is None:
                continue
            path, relative = local_image(run_dir, item[field], f"{pair[0]} / {pair[1]} {field}")
            width, height, image_hash = validate_png(path)
            if capture_type == "viewport" and (width != viewport["width"] or (field == "image" and height != viewport["height"]) or (field == "fullPageImage" and height < viewport["height"])):
                mode = "exact viewport" if field == "image" else "viewport width and at least viewport height"
                raise ArchiveError(f"PNG dimensions {width}x{height} do not match {mode} {viewport['width']}x{viewport['height']}: {relative}")
            images[relative] = {"sha256": image_hash, "width": width, "height": height, "captureType": capture_type}
    missing = expected - seen
    if missing:
        labels = ", ".join(f"{case} / {viewport}" for case, viewport in sorted(missing)[:10])
        raise ArchiveError(f"Coverage is missing {len(missing)} frozen case/viewport pairs: {labels}")
    return counts, images


def gallery(manifest: dict, coverage: dict, plan: dict) -> bytes:
    escape = html.escape
    cases = {case["id"]: case for case in plan["cases"]}
    items = []
    for item in coverage["items"]:
        case = cases[item["caseId"]]
        images = []
        if item["status"] == "captured":
            for field, title in (("image", "Viewport"), ("fullPageImage", "Full page")):
                if item[field]:
                    url = quote(item[field], safe="/-_.")
                    images.append(f'<figure><a href="{url}"><img loading="lazy" src="{url}" alt="{escape(title)}"></a><figcaption>{escape(title)}: {escape(item[field])}</figcaption></figure>')
        items.append(f'''<article><h2>{escape(case["title"])} <small>{escape(item["viewportId"])}</small></h2>
<p><code>{escape(item["caseId"])}</code> · <code>{escape(case["route"])}</code> · <strong>{escape(item["status"])}</strong></p>
<p>Data source: {escape(item["dataSource"] or "unspecified")}</p>
<p>{escape(item["observed"])}</p><p>{escape(item["reason"])}</p>{"".join(images)}</article>''')
    status = "COMPLETE declared matrix" if manifest["complete"] else "INCOMPLETE declared matrix"
    result = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(manifest["version"])} UI evidence</title><style>
body{{max-width:1120px;margin:32px auto;padding:0 20px;font:16px/1.6 system-ui,sans-serif;color:#20242b;background:#f6f7f9}}
article,header{{background:white;border:1px solid #d6dce4;border-radius:10px;padding:20px;margin:20px 0}}
img{{max-width:100%;height:auto;border:1px solid #d6dce4}}figure{{margin:20px 0}}code,figcaption{{overflow-wrap:anywhere}}small{{font-size:16px;font-weight:normal}}h1,h2{{line-height:1.3}}
</style><header><h1>{escape(manifest["version"])} — {escape(manifest["phase"])}</h1><p><strong>{status}</strong></p>
<p>Source: {escape(manifest["source"])}</p><p>Frontend: <code>{escape(manifest["frontendSha"])}</code><br>Backend: <code>{escape(manifest["backendSha"])}</code></p>
<p>{escape(json.dumps(manifest["counts"], sort_keys=True))}</p>
<p>This tool checks local evidence files and the frozen declared matrix. It does not capture screenshots, verify their authenticity, or discover every possible product state.</p>
<p><a href="manifest.json">Manifest</a> · <a href="cases.json">Frozen cases</a> · <a href="coverage.json">Coverage</a></p></header>{"".join(items)}</html>'''
    return result.encode("utf-8")


def refresh_root_index(root: Path) -> None:
    """List every direct archive directory; never rewrite a historic package."""
    escape = html.escape
    rows = []
    for entry in sorted(root.iterdir(), key=lambda item: item.name, reverse=True):
        if entry.is_symlink() or not entry.is_dir() or not (entry / "manifest.json").is_file():
            continue
        link = quote(entry.name, safe="-_.") + "/index.html"
        try:
            manifest, _ = read_json(entry / "manifest.json")
            if not isinstance(manifest, dict):
                raise ArchiveError("Manifest is not an object")
            columns = [str(manifest.get(key, "unspecified")) for key in
                       ("version", "frontendSha", "backendSha", "phase", "createdAtBangkok")]
            status = "complete" if manifest.get("complete") is True else "incomplete"
            columns.append(status)
        except (ArchiveError, OSError, ValueError, TypeError) as exc:
            columns = [entry.name, "unknown", "unknown", "unknown", "unknown", f"invalid manifest: {exc}"]
        cells = "".join(f"<td>{escape(value)}</td>" for value in columns)
        rows.append(f'<tr>{cells}<td><a href="{link}">{escape(entry.name)}</a></td></tr>')
    content = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UI evidence archives</title><style>body{{margin:32px;font:16px/1.6 system-ui,sans-serif;color:#20242b}}table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid #d6dce4;padding:10px;text-align:left;overflow-wrap:anywhere}}.table{{overflow-x:auto}}</style>
<h1>UI evidence archives</h1><p>Reported declared-matrix status from each package's manifest. Image authenticity and product-wide coverage are not verified by this tool.</p>
<div class="table"><table><thead><tr><th>Version</th><th>Frontend SHA</th><th>Backend SHA</th><th>Phase</th><th>Created (Bangkok)</th><th>Status</th><th>Archive</th></tr></thead>
<tbody>{"".join(rows)}</tbody></table></div></html>'''
    write_bytes(root / "index.html", content.encode("utf-8"))


def finalize_archive(args: argparse.Namespace) -> int:
    supplied = Path(args.run_dir).expanduser()
    if supplied.is_symlink() or not supplied.is_dir():
        raise ArchiveError("run-dir must be an existing archive directory, not a symlink")
    run_dir = supplied.resolve()
    manifest, _ = read_json(run_dir / "manifest.json")
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ArchiveError("Unsupported or invalid manifest")
    for key in (*IDENTITY_KEYS, "status", "complete", "sealed", "counts", "evidence"):
        if key not in manifest:
            raise ArchiveError(f"Manifest is missing {key}")
    clean_text(manifest["version"], "manifest.version", max_length=100)
    clean_origin(manifest["source"])
    if not isinstance(manifest["frontendSha"], str) or not SHA_RE.fullmatch(manifest["frontendSha"]):
        raise ArchiveError("manifest.frontendSha needs the actual running frontend's full SHA")
    if manifest["backendSha"] != "unknown" and (not isinstance(manifest["backendSha"], str) or not SHA_RE.fullmatch(manifest["backendSha"])):
        raise ArchiveError("manifest.backendSha must be a full SHA or unknown")
    if manifest["phase"] not in {"baseline", "candidate", "production"}:
        raise ArchiveError("Invalid manifest phase")
    if type(manifest["complete"]) is not bool or type(manifest["sealed"]) is not bool:
        raise ArchiveError("manifest.complete and manifest.sealed must be booleans")
    if manifest["complete"] != manifest["sealed"] or manifest["status"] != ("complete" if manifest["complete"] else "incomplete"):
        raise ArchiveError("Manifest status, complete and sealed flags disagree")
    for key, suffix in (("createdAtUtc", "Z"), ("createdAtBangkok", "+07:00")):
        timestamp = clean_text(manifest[key], f"manifest.{key}", max_length=50)
        if not timestamp.endswith(suffix):
            raise ArchiveError(f"manifest.{key} must use its declared UTC or Bangkok timezone")
        try:
            datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ArchiveError(f"Invalid manifest.{key} timestamp") from exc
    plan, frozen = read_json(run_dir / "cases.json")
    plan = validate_cases(plan)
    scope_hash = digest(frozen)
    if scope_hash != manifest["casesSha256"]:
        raise ArchiveError("Frozen cases.json changed; create a new archive instead of changing its declared scope")
    if manifest["expectedPairs"] != [list(pair) for pair in expected_pairs(plan)]:
        raise ArchiveError("Manifest's frozen case/viewport matrix has changed")
    coverage, coverage_raw = read_json(run_dir / "coverage.json")
    counts, images = validate_coverage(run_dir, coverage, plan, scope_hash)
    complete = counts["pending"] == 0 and counts["blocked"] == 0
    identity = {key: manifest[key] for key in IDENTITY_KEYS}
    evidence = {"identitySha256": digest(json_bytes(identity)), "casesSha256": scope_hash,
                "coverageSha256": digest(coverage_raw), "images": images}
    if manifest["sealed"]:
        if not manifest["complete"] or not complete or manifest["counts"] != counts:
            raise ArchiveError("Sealed archive's complete coverage or counts changed")
        index_raw = read_bytes(run_dir / "index.html", MAX_JSON_BYTES * 10)
        evidence["indexSha256"] = digest(index_raw)
        if manifest["evidence"] != evidence:
            raise ArchiveError("Sealed archive evidence changed; preserve history and create a new archive")
        refresh_root_index(run_dir.parent)
        print(f"Verified sealed archive: {run_dir} (declared matrix complete; authenticity not verified)")
        return 0
    manifest.update({"complete": complete, "sealed": complete, "status": "complete" if complete else "incomplete", "counts": counts, **timestamps("finalizedAt")})
    index_raw = gallery(manifest, coverage, plan)
    evidence["indexSha256"] = digest(index_raw)
    manifest["evidence"] = evidence
    write_bytes(run_dir / "index.html", index_raw)
    write_bytes(run_dir / "manifest.json", json_bytes(manifest))
    refresh_root_index(run_dir.parent)
    print(f"{'Complete' if complete else 'Incomplete'} declared matrix: {run_dir}")
    print(f"Counts: {json.dumps(counts, sort_keys=True)}; image authenticity is not verified")
    return 0 if complete else 2


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Initialize and validate local UI evidence archives. Does not capture images or access browsers/production.")
    commands = result.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Freeze a declared case matrix in a new unique directory")
    init.add_argument("--root", required=True, help="Archive root, e.g. output/playwright/releases")
    init.add_argument("--version", required=True, help="Human version label")
    init.add_argument("--frontend-sha", required=True, help="Actual running frontend's full 40-character SHA")
    init.add_argument("--backend-sha", default="unknown", help="Actual running backend's full SHA, or unknown")
    init.add_argument("--phase", choices=["baseline", "candidate", "production"], required=True)
    init.add_argument("--source", required=True, help="Sanitized HTTP(S) origin, without path/query/fragment/credentials")
    init.add_argument("--cases", required=True, help="JSON plan containing viewports and cases")
    init.set_defaults(handler=init_archive)
    finalize = commands.add_parser("finalize", help="Validate coverage and PNG files; seal complete declared coverage (incomplete exit: 2)")
    finalize.add_argument("run_dir", help="Existing directory printed by init")
    finalize.set_defaults(handler=finalize_archive)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        return args.handler(args)
    except (ArchiveError, OSError, ValueError, TypeError, KeyError) as exc:
        print(f"Archive error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
