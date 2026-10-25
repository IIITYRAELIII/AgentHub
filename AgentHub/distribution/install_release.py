"""Thin stdlib bootstrap for a versioned, checksum-pinned ready Hub package.

No Git, npm, build, provider operation, runtime stop or automatic restart.
Copy only this file and its installation guide to Utilities at managed cutover.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile


MAX_ARCHIVE_BYTES = 2 * 1024**3
MAX_EXPANDED_BYTES = 4 * 1024**3
MAX_FILES = 100_000
MAX_METADATA_BYTES = 1024 * 1024
REPOSITORY = "IIITYRAELIII/AgentHub"
PACKAGE_ASSET = "AgentHub-win32-x64.zip"
ASSET_HOSTS = {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}
VERSION_SCHEME = "semver-build-v1"
_NUMBER = r"(?:0|[1-9][0-9]*)"
_SEMVER = re.compile(rf"({_NUMBER})\.({_NUMBER})\.({_NUMBER})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")


def semantic_fields(value: dict, *, descriptor=False) -> dict:
    """Validate the new explicit identity; old receipts are read without enrichment."""
    artifact = value.get("version") if descriptor else value.get("releaseVersion")
    scheme = value.get("versionScheme")
    if scheme is None and not (isinstance(artifact, str) and "+build." in artifact):
        if any(key in value for key in ("publicVersion", "buildNumber")):
            raise ValueError("Unrecognized version metadata")
        return {}
    public = value.get("publicVersion")
    build = value.get("buildNumber")
    match = _SEMVER.fullmatch(public) if isinstance(public, str) and len(public) <= 128 else None
    if (scheme != VERSION_SCHEME or not match or any(int(x) > 9007199254740991 for x in match.group(1, 2, 3))
            or type(build) is not int or not 1 <= build <= 2100000000
            or any(x.isdigit() and len(x) > 1 and x[0] == "0" for x in (match[4] or "").split("."))
            or artifact != f"{public}+build.{build}" or (not descriptor and value.get("version") != public)):
        raise ValueError("Semantic public/build/artifact identity mismatch")
    return {"versionScheme": VERSION_SCHEME, "publicVersion": public, "buildNumber": build}


def valid_artifact_version(value: str) -> bool:
    if not isinstance(value, str):
        return False
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+){2,3}", value):
        return True  # Historical immutable receipt grammar; not upgrade authority.
    match = re.fullmatch(r"(.+)\+build\.([1-9][0-9]*)", value)
    if not match:
        return False
    try:
        semantic_fields({"versionScheme": VERSION_SCHEME, "publicVersion": match[1],
                         "buildNumber": int(match[2]), "version": value}, descriptor=True)
        return True
    except ValueError:
        return False


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_name(value: str) -> str:
    if not value or "\\" in value or ":" in value or value.startswith("/"):
        raise ValueError("Unsafe package path")
    parts = value.split("/")
    if any(x in {"", ".", ".."} or x.endswith((".", " ")) or re.search(r"[\x00-\x1f]", x) for x in parts):
        raise ValueError("Unsafe package path")
    for part in parts:
        if re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part, re.I):
            raise ValueError("Windows device path refused")
    return PurePosixPath(value).as_posix()


def validate_source_url(url: str, *, redirect=False) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Only canonical HTTPS release assets are supported")
    if parsed.hostname == "github.com":
        if not parsed.path.startswith(f"/{REPOSITORY}/releases/download/") or parsed.query or parsed.fragment:
            raise ValueError("Only versioned AgentHub release assets are supported")
    elif not redirect or parsed.hostname not in ASSET_HOSTS:
        raise ValueError("Untrusted release redirect")
    return url


class AssetRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_source_url(newurl, redirect=True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url: str, target: Path, *, max_bytes=MAX_ARCHIVE_BYTES) -> None:
    validate_source_url(url)
    opener = urllib.request.build_opener(AssetRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "AgentHub-ReadyPackage-Installer"})
    with opener.open(request, timeout=30) as response, target.open("xb") as out:
        size = 0
        deadline = time.monotonic()+10*60
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes or time.monotonic() > deadline:
                raise ValueError("Ready package exceeds download budget")
            out.write(chunk)
        out.flush()
        os.fsync(out.fileno())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Release API redirects refused")


def release_metadata(release: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", release):
        raise ValueError("Use latest or an exact simple release tag")
    selector = "latest" if release == "latest" else "tags/"+release
    url = f"https://api.github.com/repos/{REPOSITORY}/releases/{selector}"
    request = urllib.request.Request(url, headers={
        "User-Agent": "AgentHub-ReadyPackage-Installer", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"})
    # Public anonymous endpoint only: no gh, environment token or credentials.
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        raw = response.read(MAX_METADATA_BYTES+1)
    if len(raw) > MAX_METADATA_BYTES:
        raise ValueError("Release metadata exceeds budget")
    metadata = json.loads(raw.decode("utf-8"))
    if not isinstance(metadata, dict):
        raise ValueError("Invalid release metadata")
    tag = metadata.get("tag_name", "")
    if (not isinstance(tag, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", tag)
            or (release != "latest" and tag != release)
            or metadata.get("draft") is not False or metadata.get("prerelease") is not False
            or not metadata.get("published_at")):
        raise ValueError("Only a published stable release is supported")
    return metadata


def select_asset(metadata: dict, name: str, max_bytes: int) -> dict:
    assets = metadata.get("assets")
    if not isinstance(assets, list) or len(assets) > 100:
        raise ValueError("Invalid release asset inventory")
    matches = [x for x in assets if isinstance(x, dict) and x.get("name") == name]
    if len(matches) != 1:
        raise ValueError("Required ready package asset is missing or ambiguous")
    asset = matches[0]
    url = f"https://github.com/{REPOSITORY}/releases/download/{metadata['tag_name']}/{name}"
    if (asset.get("browser_download_url") != url or asset.get("state") != "uploaded"
            or type(asset.get("size")) is not int or not 0 < asset["size"] <= max_bytes
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", asset.get("digest") or "")):
        raise ValueError("Release asset URL, digest, state or size is invalid")
    return asset


def fetch_release(release: str, scratch: Path) -> tuple[Path, str, dict]:
    metadata = release_metadata(release)
    asset = select_asset(metadata, PACKAGE_ASSET, MAX_ARCHIVE_BYTES)
    checksum_asset = select_asset(metadata, PACKAGE_ASSET+".json", MAX_METADATA_BYTES)
    checksum_file = scratch/"release.json"
    download(checksum_asset["browser_download_url"], checksum_file, max_bytes=MAX_METADATA_BYTES)
    if (checksum_file.stat().st_size != checksum_asset["size"]
            or "sha256:"+file_hash(checksum_file) != checksum_asset["digest"]):
        raise ValueError("Release descriptor SHA-256 or size mismatch")
    descriptor = json.loads(checksum_file.read_text(encoding="utf-8"))
    if (not isinstance(descriptor, dict) or descriptor.get("schema") != 1
            or descriptor.get("repository") != REPOSITORY or descriptor.get("platform") != "win32-x64"
            or descriptor.get("asset") != PACKAGE_ASSET or descriptor.get("bytes") != asset["size"]
            or "sha256:"+str(descriptor.get("sha256")) != asset["digest"]
            or not re.fullmatch(r"[0-9a-f]{40}", str(descriptor.get("sourceCommit")))
            or not re.fullmatch(r"[0-9a-f]{64}", str(descriptor.get("packageManifestSha256")))
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", str(descriptor.get("releaseId")))):
        raise ValueError("Release descriptor and published asset disagree")
    fields = semantic_fields(descriptor, descriptor=True)
    if fields and "-" in fields["publicVersion"]:
        raise ValueError("Prerelease is not eligible for stable discovery")
    if fields and metadata["tag_name"] != fields["publicVersion"]:
        raise ValueError("Published tag differs from public version")
    archive = scratch/"release.zip"
    download(asset["browser_download_url"], archive, max_bytes=asset["size"])
    if archive.stat().st_size != asset["size"] or file_hash(archive) != descriptor["sha256"]:
        raise ValueError("Release ZIP SHA-256 or size mismatch")
    return archive, metadata["tag_name"], descriptor


def verify_release_descriptor(package: dict, extracted: Path, release: dict) -> None:
    if (any(package.get(key) != release.get(key) for key in ("releaseId", "sourceCommit", "version"))
            or file_hash(extracted/"package-manifest.json") != release["packageManifestSha256"]):
        raise ValueError("Extracted package differs from the selected release descriptor")
    if semantic_fields(package, descriptor=True) != semantic_fields(release, descriptor=True):
        raise ValueError("Extracted public version/build differs from release")


def extract_verified(archive: Path, expected_sha256: str, destination: Path) -> dict:
    if not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Ready archive is missing or exceeds its budget")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or file_hash(archive) != expected_sha256:
        raise ValueError("Ready package SHA-256 mismatch")
    if destination.exists():
        raise ValueError("Extraction destination must not exist")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or len(entries) > MAX_FILES or sum(x.file_size for x in entries) > MAX_EXPANDED_BYTES:
            raise ValueError("Ready package exceeds expansion budget")
        names, folded = {}, set()
        for entry in entries:
            name = safe_name(entry.filename)
            mode = entry.external_attr >> 16
            if entry.is_dir() or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or entry.flag_bits & 1:
                raise ValueError("Directories, links, special or encrypted entries refused")
            if name.casefold() in folded:
                raise ValueError("Duplicate package path")
            folded.add(name.casefold())
            names[name] = entry
        for name in names:
            if any(parent.casefold() in folded for parent in [str(p) for p in PurePosixPath(name).parents if str(p) != "."]):
                raise ValueError("File/directory package collision")
        descriptor_entry = names.get("package-manifest.json")
        if not descriptor_entry or descriptor_entry.file_size > 8*1024**2:
            raise ValueError("Missing or oversized package descriptor")
        descriptor = json.loads(source.read(descriptor_entry).decode("utf-8"))
        version_fields = semantic_fields(descriptor, descriptor=True)
        if (descriptor.get("schema") != 1 or descriptor.get("repository") != REPOSITORY
                or descriptor.get("platform") != "win32-x64" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", descriptor.get("releaseId", ""))):
            raise ValueError("Unsupported ready package identity")
        records = descriptor.get("files")
        if not isinstance(records, list) or len(records) != len(names)-1:
            raise ValueError("Package inventory mismatch")
        indexed = {}
        for item in records:
            name = safe_name(item["path"])
            if name in indexed or name == "package-manifest.json" or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
                raise ValueError("Invalid package inventory")
            if type(item.get("bytes")) is not int or item["bytes"] < 0:
                raise ValueError("Invalid package length")
            indexed[name] = item
        if set(indexed) != set(names)-{"package-manifest.json"}:
            raise ValueError("Undeclared package content")
        required = {"install-prepared.mjs", "config.example.json", "LICENSE", "THIRD_PARTY_NOTICES.md",
                    "runtime/runtime-manifest.json", "runtime/AgentHub.RuntimeHost.exe"}
        if not required.issubset(names):
            raise ValueError("Incomplete Windows ready package")
        destination.mkdir(parents=True, exist_ok=False)
        owned_destination = destination.resolve(strict=True)
        try:
            for name, entry in names.items():
                target = destination.joinpath(*PurePosixPath(name).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                size = 0
                with source.open(entry) as incoming, target.open("xb") as outgoing:
                    while chunk := incoming.read(1024*1024):
                        size += len(chunk)
                        digest.update(chunk)
                        outgoing.write(chunk)
                if name in indexed and (size != indexed[name]["bytes"] or digest.hexdigest() != indexed[name]["sha256"]):
                    raise ValueError("Ready package file integrity mismatch")
            if version_fields:
                runtime = json.loads((destination/"runtime/runtime-manifest.json").read_text(encoding="utf-8"))
                if (semantic_fields(runtime) != version_fields or runtime.get("releaseVersion") != descriptor["version"]
                        or runtime.get("releaseId") != descriptor["releaseId"]
                        or runtime.get("publicationRevision") != descriptor.get("sourceCommit")):
                    raise ValueError("Package/runtime version identity mismatch")
        except BaseException:
            # Destination was exclusively created by this call and no child has
            # executed. Preserve the supplied archive; remove only our extraction.
            if destination.resolve(strict=True) != owned_destination or destination.is_symlink():
                raise RuntimeError("Extraction ownership changed; temporary files preserved")
            shutil.rmtree(owned_destination)
            raise
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url")
    source.add_argument("--archive", type=Path)
    source.add_argument("--release", help="Exact stable tag, or latest, from the public AgentHub release origin")
    parser.add_argument("--sha256", help="Required for --url/--archive; optional additional pin for --release")
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--scratch-root", type=Path, required=True, help="Private temporary area on the intended volume")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    if not args.release and not args.sha256:
        parser.error("--sha256 is required with --url or --archive")
    if args.sha256 and not re.fullmatch(r"[0-9a-f]{64}", args.sha256):
        parser.error("--sha256 must be 64 lowercase hexadecimal characters")
    if os.name != "nt":
        raise RuntimeError("Ready packages currently support Windows x64 only")
    if args.runtime_root.resolve().is_relative_to(args.scratch_root.resolve()):
        raise ValueError("Runtime must be outside the disposable package scratch root")
    args.scratch_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="agenthub-package-", dir=args.scratch_root) as temporary:
        scratch = Path(temporary)
        archive = args.archive
        selected = None
        checksum = args.sha256
        if args.release:
            archive, tag, selected = fetch_release(args.release, scratch)
            if checksum and checksum != selected["sha256"]:
                raise ValueError("Selected release differs from the additional SHA-256 pin")
            checksum = selected["sha256"]
            print(f"Selected {REPOSITORY} {tag}: {selected['releaseId']} SHA-256 {checksum}", flush=True)
        elif args.url:
            archive = scratch/"release.zip"
            download(args.url, archive)
        descriptor = extract_verified(archive, checksum, scratch/"verified")
        if selected:
            verify_release_descriptor(descriptor, scratch/"verified", selected)
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js runtime with node:sqlite is required; no npm or compiler is needed")
        subprocess.run([node, "-e", "require('node:sqlite')"], check=True, capture_output=True)
        # Explicit offline update only; the existing owner checks live/unknown
        # process evidence. No automatic start, stop, autostart or retry.
        result = subprocess.run([node, str(scratch/"verified/install-prepared.mjs"),
                                 "rollback" if args.rollback else "install", str(args.runtime_root.resolve())],
                                check=False, env={k: v for k, v in os.environ.items()
                                                  if not k.startswith("AGENT_HUB_PUBLICATION_")})
        if result.returncode:
            raise RuntimeError("Installation did not report success; inspect the existing runtime owner before retrying")
        print(f"Package {descriptor['releaseId']} processed. Runtime was not started.")


if __name__ == "__main__":
    main()
