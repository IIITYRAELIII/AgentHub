"""Thin stdlib bootstrap for a versioned, checksum-pinned ready Hub package.

No Git, npm, build, provider operation or automatic runtime stop. Ordinary
install/rollback never starts Hub. The explicit package-update mode waits for a
user-stopped legacy cohort, then delegates backup/install/start to RuntimeHost.
Copy only this file and its installation guide to Utilities at managed cutover.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import closing, contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sqlite3
import subprocess
import tempfile
import time
import urllib.parse
import urllib.error
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
    with windows_filesystem_path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def windows_filesystem_path(path: Path) -> Path:
    """Use Windows' extended namespace for owned extraction IO and cleanup."""
    if os.name != "nt":
        return path
    value = str(path.absolute())
    if value.startswith("\\\\?\\"):
        return Path(value)
    return Path("\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value)


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
        try:
            validate_source_url(newurl, redirect=True)
        except ValueError:
            if fp is not None:
                fp.close()
            raise
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ReleaseHTTPSConnection(http.client.HTTPSConnection):
    def putheader(self, header, *values):
        # Read the framed response before closing locally. Requesting early
        # peer closure stalls/truncates canonical release responses on some paths.
        if header.lower() == "connection" and values == ("close",):
            return
        super().putheader(header, *values)


class ReleaseHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        return self.do_open(ReleaseHTTPSConnection, request, context=self._context)


@contextmanager
def release_response(opener, request):
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        # An HTTPError owns the response before the with-statement can enter.
        error.close()
        raise
    with response:
        yield response


def download(url: str, target: Path, *, max_bytes=MAX_ARCHIVE_BYTES) -> None:
    validate_source_url(url)
    opener = urllib.request.build_opener(ReleaseHTTPSHandler(), AssetRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "AgentHub-ReadyPackage-Installer"})
    with release_response(opener, request) as response, windows_filesystem_path(target).open("xb") as out:
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
        if fp is not None:
            fp.close()
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
    with release_response(urllib.request.build_opener(ReleaseHTTPSHandler(), NoRedirect()), request) as response:
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


def fetch_release(release: str, scratch: Path, *, metadata=None, stage=lambda value: None) -> tuple[Path, str, dict]:
    metadata = release_metadata(release) if metadata is None else metadata
    asset = select_asset(metadata, PACKAGE_ASSET, MAX_ARCHIVE_BYTES)
    checksum_asset = select_asset(metadata, PACKAGE_ASSET+".json", MAX_METADATA_BYTES)
    checksum_file = scratch/"release.json"
    stage("descriptor-body")
    download(checksum_asset["browser_download_url"], checksum_file, max_bytes=MAX_METADATA_BYTES)
    if (windows_filesystem_path(checksum_file).stat().st_size != checksum_asset["size"]
            or "sha256:"+file_hash(checksum_file) != checksum_asset["digest"]):
        raise ValueError("Release descriptor SHA-256 or size mismatch")
    descriptor = json.loads(windows_filesystem_path(checksum_file).read_text(encoding="utf-8"))
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
    stage("archive-body")
    download(asset["browser_download_url"], archive, max_bytes=asset["size"])
    if windows_filesystem_path(archive).stat().st_size != asset["size"] or file_hash(archive) != descriptor["sha256"]:
        raise ValueError("Release ZIP SHA-256 or size mismatch")
    return archive, metadata["tag_name"], descriptor


def verify_release_descriptor(package: dict, extracted: Path, release: dict) -> None:
    if (any(package.get(key) != release.get(key) for key in ("releaseId", "sourceCommit", "version"))
            or file_hash(extracted/"package-manifest.json") != release["packageManifestSha256"]):
        raise ValueError("Extracted package differs from the selected release descriptor")
    if semantic_fields(package, descriptor=True) != semantic_fields(release, descriptor=True):
        raise ValueError("Extracted public version/build differs from release")


def extract_verified(archive: Path, expected_sha256: str, destination: Path) -> dict:
    archive = windows_filesystem_path(archive)
    if not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Ready archive is missing or exceeds its budget")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or file_hash(archive) != expected_sha256:
        raise ValueError("Ready package SHA-256 mismatch")
    destination = windows_filesystem_path(destination)
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


def read_update_original(runtime_root: Path, operation_id: str):
    """Internal authoritative absence is distinct from the public UNKNOWN projection."""
    _plain_chain(runtime_root/"data")
    _plain(runtime_root/"data/runtime.sqlite")
    with closing(sqlite3.connect((runtime_root/"data/runtime.sqlite").as_uri()+"?mode=ro", uri=True, timeout=0)) as database:
        row = database.execute("SELECT operation_json FROM maintenance_operations WHERE operation_id = ?", (operation_id,)).fetchone()
    if row is None:
        return None
    original = json.loads(row[0])
    if original.get("operationId") != operation_id or original.get("kind") != "restart":
        raise ValueError("Different original maintenance identity")
    return original


def original_status(operation_id: str, original) -> dict:
    if original is None:
        return {"operationId": operation_id, "state": "unknown", "effectsReplayed": False}
    result = {"operationId": operation_id, "status": original.get("status"), "phase": original.get("phase"),
              "outcome": original.get("outcome"), "effectsReplayed": False}
    metadata = original.get("metadata") or {}
    envelope = metadata.get("packageHandoff") or {}
    binding = envelope.get("binding") or {}
    if (original.get("status") in {"requested", "blocked", "running"} and original.get("outcome") is None
            and metadata.get("packageInputSha256") and envelope.get("schema") == 1
            and binding.get("operationId") == operation_id
            and hashlib.sha256(json.dumps(binding, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
            == envelope.get("sha256")):
        result["handoff"] = {"action": "yield_current_turn", "reason": "public_package_restart",
                             "operationId": operation_id}
    return result


def update_status(runtime_root: Path, operation_id: str) -> dict:
    """Bounded read projection only; this never grants retry/install authority."""
    return original_status(operation_id, read_update_original(runtime_root, operation_id))


def _plain(path: Path, *, directory=False):
    value = windows_filesystem_path(path).lstat()
    if (stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400
            or not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode))
            or (not directory and value.st_nlink != 1)):
        raise ValueError("Linked, shared or nonregular update preparation path refused")
    return value


def _directory_identity(path: Path) -> dict:
    value = _plain(path, directory=True)
    return dict(path=str(path), dev=str(value.st_dev), ino=str(value.st_ino))


def _plain_chain(path: Path):
    for ancestor in reversed([path, *path.parents]):
        _plain(ancestor, directory=True)


def _read_record(path: Path) -> dict:
    before = _plain(path)
    if before.st_size > MAX_METADATA_BYTES:
        raise ValueError("Oversized update preparation record")
    body = windows_filesystem_path(path).read_bytes()
    after = _plain(path)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("Update preparation record changed during read")
    result = json.loads(body.decode("utf-8"))
    if not isinstance(result, dict):
        raise ValueError("Invalid update preparation record")
    return result


def _write_record(path: Path, value: dict):
    # Exclusive publication: a process crash can leave a partial record, which
    # refuses rather than being repaired, adopted or interpreted as absence.
    with windows_filesystem_path(path).open("x", encoding="utf-8") as output:
        json.dump(value, output, sort_keys=True, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())


@contextmanager
def _preparation_lock(cache: Path):
    lock = windows_filesystem_path(cache/"preparation.lock")
    if not lock.exists():
        with lock.open("xb") as output:
            output.write(b"0")
            output.flush()
            os.fsync(output.fileno())
    before = _plain(lock)
    with lock.open("r+b") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size) != (before.st_dev, before.st_ino, 1) or opened.st_nlink != 1:
            raise ValueError("Update preparation lock changed")
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _transport_selection(release: str, installer_sha256: str) -> dict:
    metadata = release_metadata(release)
    selected = [select_asset(metadata, name, limit) for name, limit in [
        (PACKAGE_ASSET, MAX_ARCHIVE_BYTES), (PACKAGE_ASSET+".json", MAX_METADATA_BYTES),
        ("install_release.py", MAX_METADATA_BYTES)]]
    # Store only canonical public identities, never expiring redirect URLs or
    # unrelated API/body/authentication fields.
    assets = [{key: asset[key] for key in ("name", "state", "size", "digest", "browser_download_url")} for asset in selected]
    if assets[2]["digest"] != "sha256:"+installer_sha256:
        raise ValueError("Executing installer differs from the selected public asset")
    return dict(tag_name=metadata["tag_name"], assets=assets)


def prepare_update(args) -> None:
    # One retained transport, not another updater registry. All lifecycle writes
    # and effects belong to the existing maintenance/restart/Host owners.
    runtime = args.runtime_root.resolve(strict=True)
    scratch = args.scratch_root.resolve(strict=True)
    _plain_chain(runtime)
    _plain_chain(scratch)
    identity = hashlib.sha256((str(runtime)+"\0"+args.operation_id).encode()).hexdigest()[:32]
    cache = scratch/("agenthub-update-"+identity)
    preparation = cache/"preparation.json"
    if windows_filesystem_path(cache).exists() and not windows_filesystem_path(preparation).exists():
        # Historical unbound caches are immutable/readback-only. In particular,
        # absence of update-request.json never proves pre-dispatch ownership.
        _plain_chain(cache)
        prior_file = cache/"update-request.json"
        if windows_filesystem_path(prior_file).exists():
            prior = _read_record(prior_file)
            if (prior.get("tag") != args.release or prior.get("operationId") != args.operation_id
                    or Path(prior.get("runtimeRoot", "")).resolve() != runtime):
                raise ValueError("Original update selection changed; no new effects were submitted")
        print(json.dumps(update_status(runtime, args.operation_id)))
        return
    installer = Path(__file__).resolve(strict=True)
    _plain(installer)
    binding = dict(schema=1, kind="public-update-preparation-v1", runtime=_directory_identity(runtime),
                   scratch=_directory_identity(scratch), operationId=args.operation_id, release=args.release,
                   archiveSha256=args.sha256, installerSha256=file_hash(installer))
    if not windows_filesystem_path(cache).exists():
        original = read_update_original(runtime, args.operation_id)
        if original is not None:
            print(json.dumps(original_status(args.operation_id, original)))
            return
        windows_filesystem_path(cache).mkdir()
        _write_record(preparation, dict(binding=binding, cache=_directory_identity(cache)))
    _plain_chain(cache)
    with _preparation_lock(cache):
        record = _read_record(preparation)
        def assert_bound():
            _plain_chain(cache)
            if (record != dict(binding=binding, cache=_directory_identity(cache))
                    or _directory_identity(runtime) != binding["runtime"]
                    or args.runtime_root.resolve(strict=True) != runtime
                    or args.scratch_root.resolve(strict=True) != scratch
                    or _directory_identity(scratch) != binding["scratch"]
                    or file_hash(installer) != binding["installerSha256"]
                    or _read_record(preparation) != record):
                raise ValueError("Original update selection or physical preparation identity changed")
        assert_bound()
        original = read_update_original(runtime, args.operation_id)
        if (original is not None or windows_filesystem_path(cache/"dispatch-intent.json").exists()
                or windows_filesystem_path(cache/"update-request.json").exists()):
            # Neither absent SQL nor a lost subprocess reply can reopen this fence.
            print(json.dumps(original_status(args.operation_id, original)))
            return
        selected = _transport_selection(args.release, binding["installerSha256"])
        selection_file = cache/"selection.json"
        if windows_filesystem_path(selection_file).exists():
            if _read_record(selection_file) != selected:
                raise ValueError("Original public asset selection changed")
        else:
            if {child.name for child in windows_filesystem_path(cache).iterdir()} != {"preparation.json", "preparation.lock"}:
                raise ValueError("Original public asset selection is missing; retained transport cannot be adopted")
            _write_record(selection_file, selected)
        archive_pin = selected["assets"][0]["digest"].removeprefix("sha256:")
        if args.sha256 and args.sha256 != archive_pin:
            raise ValueError("Selected release differs from the additional SHA-256 pin")
        assert_bound()
        # Every explicit PRE-dispatch continuation gets its own exclusive child;
        # failed downloads and uncommitted extraction are never reused/overwritten.
        attempt = cache/Path(tempfile.mkdtemp(prefix="attempt-", dir=windows_filesystem_path(cache))).name
        _plain_chain(attempt)
        attempt_identity = _directory_identity(attempt)
        phase = "descriptor-body"
        def stage(value):
            nonlocal phase
            assert_bound()
            _plain_chain(attempt)
            if _directory_identity(attempt) != attempt_identity:
                raise ValueError("Update preparation attempt identity changed")
            phase = value
        try:
            archive, tag, descriptor = fetch_release(args.release, attempt, metadata=selected, stage=stage)
        except Exception as error:
            # No exception text, redirect URLs, headers or response bodies enter
            # this bounded transport record. It is evidence, not retry authority.
            code = type(error).__name__
            try:
                stage(phase)
                _write_record(attempt/"transport-result.json", dict(schema=1, operationId=args.operation_id,
                              phase=phase, outcome="interrupted", failureCode=code if code in
                              {"TimeoutError", "URLError", "HTTPError", "OSError", "ValueError", "JSONDecodeError"} else "Error"))
            except Exception as recording_error:
                error.add_note("Transport result was not saved: "+type(recording_error).__name__)
            raise
        stage("verified-assets")
        _write_record(attempt/"transport-result.json", dict(schema=1, operationId=args.operation_id,
                      phase="verified-assets", outcome="succeeded", archiveSha256=file_hash(archive),
                      descriptorSha256=file_hash(attempt/"release.json")))
        package = attempt/"verified"
        inner = extract_verified(archive, descriptor["sha256"], package)
        verify_release_descriptor(inner, package, descriptor)
        stage("verified-package")
        _plain_chain(package)
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js with node:sqlite is required")
        assert_bound()
        if _read_record(selection_file) != selected:
            raise ValueError("Original public asset selection changed")
        original = read_update_original(runtime, args.operation_id)
        if original is not None:
            print(json.dumps(original_status(args.operation_id, original)))
            return
        request = dict(schema=1, operationId=args.operation_id, runtimeRoot=str(runtime),
                       packageRoot=str(package.resolve()), tag=tag, archive=str(archive.resolve()),
                       descriptor=str((attempt/"release.json").resolve()), installer=str(installer))
        request_file = cache/"update-request.json"
        _write_record(request_file, request)
        _write_record(cache/"dispatch-intent.json", dict(schema=1, kind="package-bootstrap-dispatch-v1",
                      operationId=args.operation_id, preparationSha256=file_hash(preparation),
                      selectionSha256=file_hash(selection_file), requestSha256=file_hash(request_file)))
        assert_bound()
        entry = package/"runtime/src/runtime/runtime-package-handoff.mjs"
        print("Keep the retained package/backup until the original update completes. "
              "After yield_current_turn, finish this Hub turn so the admitted restart can proceed. "
              "Read the same original after restart.", flush=True)
        result = subprocess.run([node, str(entry), "bootstrap-start", str(request_file)], check=False)
        if result.returncode:
            raise RuntimeError("Update admission was not confirmed; retained original must be read, not re-launched")


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
    parser.add_argument("--inspect-package", action="store_true", help="Verify/extract public input only; no runtime effect")
    parser.add_argument("--prepare-update", action="store_true", help="Admit one exact package update through the existing runtime owner")
    parser.add_argument("--update-status", action="store_true", help="Read the exact original without replaying effects")
    parser.add_argument("--operation-id", help="Original stable identity for package update/readback")
    parser.add_argument("--project-root", type=Path, help="Selected project for a first installation; existing configuration is preserved")
    args = parser.parse_args()
    if not args.release and not args.sha256:
        parser.error("--sha256 is required with --url or --archive")
    if args.sha256 and not re.fullmatch(r"[0-9a-f]{64}", args.sha256):
        parser.error("--sha256 must be 64 lowercase hexadecimal characters")
    if sum((args.rollback, args.inspect_package, args.prepare_update, args.update_status)) > 1:
        parser.error("Choose one installer operation")
    if args.prepare_update or args.update_status:
        if not args.release or args.release == "latest" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", args.operation_id or ""):
            parser.error("Update requires an exact --release and original --operation-id")
    if args.project_root and (args.rollback or args.inspect_package or args.prepare_update or args.update_status):
        parser.error("--project-root belongs only to a first installation")
    if os.name != "nt":
        raise RuntimeError("Ready packages currently support Windows x64 only")
    if args.runtime_root.resolve().is_relative_to(args.scratch_root.resolve()):
        raise ValueError("Runtime must be outside the disposable package scratch root")
    if args.update_status:
        print(json.dumps(update_status(args.runtime_root.resolve(), args.operation_id)))
        return
    args.scratch_root.mkdir(parents=True, exist_ok=True)
    if args.prepare_update:
        prepare_update(args)
        return
    with tempfile.TemporaryDirectory(prefix="agenthub-package-", dir=windows_filesystem_path(args.scratch_root)) as temporary:
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
        if args.inspect_package:
            manifest = (scratch/"verified/runtime/runtime-manifest.json").read_bytes()
            print(json.dumps({"schema": 1, "kind": "verified-package-input", "releaseId": descriptor["releaseId"],
                              "packageManifestSha256": file_hash(scratch/"verified/package-manifest.json"),
                              "runtimeManifestSha256": hashlib.sha256(manifest).hexdigest(),
                              "runtimeManifestBase64": base64.b64encode(manifest).decode("ascii")}))
            return
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js runtime with node:sqlite is required; no npm or compiler is needed")
        subprocess.run([node, "-e", "require('node:sqlite')"], check=True, capture_output=True)
        # Python extraction/cleanup uses the extended filesystem namespace;
        # Node's entry-point resolver accepts the ordinary absolute spelling.
        entry = str(scratch/"verified/install-prepared.mjs")
        if os.name == "nt" and entry.startswith("\\\\?\\"):
            entry = "\\\\" + entry[8:] if entry.startswith("\\\\?\\UNC\\") else entry[4:]
        # Explicit offline update only; the existing owner checks live/unknown
        # process evidence. No automatic start, stop, autostart or retry.
        result = subprocess.run([node, entry,
                                 "rollback" if args.rollback else "install", str(args.runtime_root.resolve()),
                                 *(["--project-root", str(args.project_root.resolve())] if args.project_root else [])],
                                check=False, env={k: v for k, v in os.environ.items()
                                                  if not k.startswith("AGENT_HUB_PUBLICATION_")})
        if result.returncode:
            raise RuntimeError("Installation did not report success; inspect the existing runtime owner before retrying")
        print(f"Package {descriptor['releaseId']} processed. Runtime was not started.")


if __name__ == "__main__":
    main()
