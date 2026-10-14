#!/usr/bin/env python3
"""Build a deterministic Chrome Web Store ZIP with manifest.json at the root.

This packages the existing extension WITHOUT changing the Railway /extension/download
unpacked distribution. No store credentials or Chrome Web Store API calls required.
"""
from __future__ import annotations

import json
import shutil
import struct
import tempfile
import zlib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"
DIST = ROOT / "dist"
EXCLUDE = {"__pycache__", ".DS_Store", "Thumbs.db"}


def write_png(path: Path, size: int) -> None:
    # Tiny local icon. No external font or image dependencies.
    rows = []
    for y in range(size):
        line = bytearray()
        for x in range(size):
            # Teal background; geometric white HC emblem.
            a = int(size * .18)
            b = int(size * .82)
            stroke = max(1, size // 11)
            h = (a <= x < a + stroke or size//2-stroke <= x < size//2) and a <= y < b
            bar = a <= y < a + stroke and a <= x < size//2
            c = (size//2+stroke <= x < b and (a <= y < a+stroke or b-stroke <= y < b)) or (
                size//2 <= x < size//2+stroke and a <= y < b
            )
            if h or bar or c:
                line.extend((255, 255, 255, 255))
            else:
                line.extend((15, 106, 105, 255))
        rows.append(b"\x00" + bytes(line))
    raw = zlib.compress(b"".join(rows), 9)
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    path.write_bytes(png)


def build() -> Path:
    if not SOURCE.is_dir():
        raise RuntimeError("extension/ source directory missing")
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise RuntimeError("Chrome Web Store requires Manifest V3")
    if len(manifest.get("description", "")) > 132:
        raise RuntimeError("Chrome Web Store manifest description exceeds 132 characters")
    if len(manifest.get("name", "")) > 45:
        raise RuntimeError("Chrome Web Store manifest name exceeds 45 characters")
    version = manifest["version"]
    if not isinstance(version, str) or not all(p.isdigit() for p in version.split(".")):
        raise RuntimeError("Invalid manifest version")
    DIST.mkdir(parents=True, exist_ok=True)
    name = f"Hobby-Corner-Toolkit-CWS-v{version}.zip"
    target = DIST / name
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / "release"
        shutil.copytree(SOURCE, folder)
        icons = folder / "icons"
        icons.mkdir(exist_ok=True)
        for size in (16, 48, 128):
            write_png(icons / f"hc-{size}.png", size)
        manifest["icons"] = {str(n): f"icons/hc-{n}.png" for n in (16, 48, 128)}
        (folder / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        members = sorted(p for p in folder.rglob("*") if p.is_file())
        for p in members:
            if any(part.startswith(".") or part in EXCLUDE for part in p.relative_to(folder).parts):
                raise RuntimeError(f"Unexpected hidden/generated file: {p.name}")
            if p.suffix.lower() in {".pem", ".key", ".env", ".crx"}:
                raise RuntimeError(f"Private / packed extension file not allowed: {p.name}")
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for p in members:
                info = zipfile.ZipInfo(p.relative_to(folder).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                z.writestr(info, p.read_bytes())
    with zipfile.ZipFile(target) as z:
        names = set(z.namelist())
        if "manifest.json" not in names or "extension/manifest.json" in names:
            raise RuntimeError("Store package root layout invalid")
        for size in (16, 48, 128):
            if f"icons/hc-{size}.png" not in names:
                raise RuntimeError("Missing icon")
        if any(n.startswith("..") or n.startswith("/") for n in names):
            raise RuntimeError("Unsafe archive path")
        manifest = json.loads(z.read("manifest.json"))
        if manifest["version"] != version or manifest["manifest_version"] != 3:
            raise RuntimeError("Manifest mismatch")
    print(f"Chrome Web Store ZIP ready: {target} (version {version}, {len(names)} files)")
    return target


if __name__ == "__main__":
    build()
