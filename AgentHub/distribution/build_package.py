"""Package an ALREADY prepared runtime. No build/install/publication effects."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import zipfile

from install_release import REPOSITORY, file_hash, safe_name

ROOT = Path(__file__).resolve().parent


def regular(path: Path) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise ValueError("Package input must be a regular file")
    return path.read_bytes()


def build_package(prepared: Path, license_file: Path, notices_file: Path, source_commit: str, output: Path) -> dict:
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise ValueError("The reviewed exported source commit must be exact")
    if output.exists() or output.with_suffix(output.suffix+".json").exists():
        raise ValueError("Package output already exists")
    original = regular(prepared/"runtime-manifest.json")
    manifest = json.loads(original.decode("utf-8"))
    if manifest.get("publicationRevision") != source_commit:
        raise ValueError("Prepared runtime must bind the exact reviewed standalone publication revision; old Utilities OIDs cannot be relabeled")
    release_id = manifest.get("releaseId", "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", release_id):
        raise ValueError("Invalid prepared release identity")
    payload = {}
    for item in manifest["files"]:
        name = safe_name(item["path"])
        if name in payload or name == "runtime-manifest.json":
            raise ValueError("Duplicate prepared runtime entry")
        path = prepared.joinpath(*name.split("/"))
        # A regular final file does not make a reparse parent safe.
        current = path.parent
        while current != prepared:
            if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
                raise ValueError("Reparse package input refused")
            current = current.parent
        data = regular(path)
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("Prepared runtime integrity mismatch")
        payload["runtime/"+name] = data
    if "runtime/AgentHub.RuntimeHost.exe" not in payload or "runtime/agent-hub-main.mjs" not in payload:
        raise ValueError("Prepared Windows RuntimeHost/entry point missing")
    # Public distribution is a NEW immutable artifact. Do not mutate/relabel the
    # original prepared manifest or its release-operation receipt. Its private
    # machine sourceRoot is omitted only in this copied public artifact.
    manifest.pop("sourceRoot", None)
    manifest["distributionSource"] = {"repository": REPOSITORY, "commit": source_commit,
                                       "preparedManifestSha256": hashlib.sha256(original).hexdigest()}
    payload["runtime/runtime-manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2)+"\n").encode()
    payload["install-prepared.mjs"] = regular(ROOT/"install-prepared.mjs")
    payload["config.example.json"] = regular(ROOT/"config.example.json")
    payload["LICENSE"] = regular(license_file)
    payload["THIRD_PARTY_NOTICES.md"] = regular(notices_file)
    dependencies = []
    for name, data in sorted(payload.items()):
        if name.startswith("runtime/node_modules/") and name.endswith("/package.json"):
            package = json.loads(data.decode("utf-8"))
            directory = name[:-len("package.json")]
            notices = [{"path": p, "sha256": hashlib.sha256(b).hexdigest()} for p, b in payload.items()
                       if p.startswith(directory) and "/" not in p[len(directory):]
                       and re.match(r"(?:licen[cs]e|copying|notice|readme)(?:\.|$)", p[len(directory):], re.I)]
            dependencies.append({"name": package.get("name"), "version": package.get("version"),
                                 "license": package.get("license", "UNDECLARED"), "notices": notices})
    payload["DEPENDENCIES.json"] = (json.dumps({"schema": 1, "scope": "actually packaged runtime files",
                                               "packages": dependencies}, indent=2)+"\n").encode()
    descriptor = {"schema": 1, "repository": REPOSITORY, "platform": "win32-x64", "releaseId": release_id,
                  "version": manifest.get("releaseVersion", manifest.get("version")), "sourceCommit": source_commit,
                  "preparedManifestSha256": hashlib.sha256(original).hexdigest(),
                  "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                            for name, data in sorted(payload.items())]}
    payload["package-manifest.json"] = (json.dumps(descriptor, indent=2)+"\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as target, zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(payload.items()):
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)
    result = {"schema": 1, "asset": output.name, "bytes": output.stat().st_size,
              "sha256": file_hash(output), "releaseId": release_id, "sourceCommit": source_commit,
              "packageManifestSha256": hashlib.sha256(payload["package-manifest.json"]).hexdigest(),
              "publicApproval": False}
    output.with_suffix(output.suffix+".json").write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared-runtime", type=Path, required=True)
    parser.add_argument("--license", type=Path, required=True)
    parser.add_argument("--notices", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build_package(args.prepared_runtime.resolve(), args.license, args.notices,
                                   args.source_commit, args.output), indent=2))


if __name__ == "__main__":
    main()
