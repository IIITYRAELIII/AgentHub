"""Offline, pinned source-history projection; never clones or pushes Utilities.

Keeps AgentHub/ to preserve release-owner path identities. Plan/audit output is
private evidence, not an artifact to put in the public repository.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path, PurePosixPath


WINDOWS_GIT_ARGS = json.loads((Path(__file__).resolve().parents[1] / "src/infrastructure/filesystem/git-invocation-policy.json").read_text(encoding="utf-8"))["win32"] if os.name == "nt" else []

PREFIXES = ("AgentHub/", "TelegramIntegration/")
EXCLUDED_PARTS = {"Bugs", "WIP", "node_modules", "__pycache__"}
EXCLUDED_ROOT_PARTS = {"data", "releases", "runtime", "models"}
SOURCE_CONFIG_SUFFIXES = {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"}
EXCLUDED_PREFIXES = ("AgentHub/docs/design/", "AgentHub/DesktopApp/attachments/")
PATTERNS = {
    "private-key": rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "github-token": rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b",
    "provider-key": rb"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b",
    "telegram-token": rb"\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b",
    "personal-windows-path": rb"[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?!test\b|example\b|user\b|Public\b|Default\b)[^\s\x00\"'<>]{2,}",
    "private-network": rb"\b(?:192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\b",
}
COMPILED = {key: re.compile(value, re.I) for key, value in PATTERNS.items()}


def git(root: Path, *args: str, data: bytes | None = None) -> bytes:
    return subprocess.run(["git", *WINDOWS_GIT_ARGS, "--no-optional-locks", "--no-replace-objects", "-C", str(root), *args],
                          input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, env=git_environment()).stdout


def git_environment() -> dict[str, str]:
    # Inherited index/object-directory overrides must never redirect an import
    # into the primary repository or copy hidden alternate object stores.
    return {**{k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")},
            "GIT_NO_REPLACE_OBJECTS": "1", "GIT_OPTIONAL_LOCKS": "0"}


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def projected_path(raw: bytes) -> bytes | None:
    # Native -z paths elsewhere; fast-export quotes non-ASCII names with Git's
    # C quoting. Parse octal bytes, not JSON's incompatible escape grammar.
    if raw.startswith(b'"'):
        if not raw.endswith(b'"'):
            raise ValueError("Invalid quoted Git path")
        raw = re.sub(rb"\\([0-7]{3}|[\\\"abfnrtv])", lambda m: bytes([int(m[1], 8)])
                     if m[1].isdigit() else {b"\\": b"\\", b'"': b'"', b"a": b"\a", b"b": b"\b",
                                           b"f": b"\f", b"n": b"\n", b"r": b"\r", b"t": b"\t", b"v": b"\v"}[m[1]], raw[1:-1])
    value = raw.decode("utf-8", "strict")
    # Keep the real rename history: the rename commit temporarily contains both
    # prefixes. Flattening them would overwrite four different historical files.
    if not value.startswith(PREFIXES):
        raise ValueError("Source projection escaped approved prefix")
    parts = PurePosixPath(value).parts
    if any(part in {".", ".."} for part in parts) or "\\" in value:
        raise ValueError("Unsafe exported path")
    canonical = "AgentHub/"+"/".join(parts[1:])
    if (any(part in EXCLUDED_PARTS for part in parts[1:])
            or parts[1] in EXCLUDED_ROOT_PARTS or canonical.startswith(EXCLUDED_PREFIXES)):
        return None
    name = parts[-1].lower()
    if ((name.startswith("config.") and name != "config.example.json"
         and PurePosixPath(name).suffix not in SOURCE_CONFIG_SUFFIXES)
            or (name.startswith(".env") and name != ".env.example")
            or name in {"config.json", "tgbottoken.txt"}):
        return None
    if name.endswith((".log", ".sqlite", ".sqlite-wal", ".sqlite-shm", ".token", ".secret", ".vsix")):
        return None
    return value.encode("utf-8")


class Objects:
    def __init__(self, root: Path):
        self.process = subprocess.Popen(["git", *WINDOWS_GIT_ARGS, "--no-replace-objects", "-C", str(root), "cat-file", "--batch"],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=git_environment())

    def get(self, oid: bytes) -> tuple[bytes, bytes]:
        self.process.stdin.write(oid+b"\n")
        self.process.stdin.flush()
        header = self.process.stdout.readline().strip().split()
        if len(header) != 3 or header[0] != oid:
            raise ValueError("Missing or invalid source object")
        size = int(header[2])
        body = self.process.stdout.read(size)
        if len(body) != size or self.process.stdout.read(1) != b"\n":
            raise ValueError("Truncated source object")
        actual = hashlib.sha1(header[1]+b" "+str(size).encode()+b"\0"+body).hexdigest().encode()
        if actual != oid:
            raise ValueError("Source object hash mismatch")
        return header[1], body

    def close(self):
        self.process.stdin.close()
        code = self.process.wait(timeout=30)
        self.process.stdout.close()
        self.process.stderr.close()
        if code:
            raise RuntimeError("Git object reader failed")


def scan(data: bytes) -> list[str]:
    return sorted(key for key, pattern in COMPILED.items() if pattern.search(data))


def export_commits(source: Path, pin: str):
    if not re.fullmatch(r"[0-9a-f]{40}", pin):
        raise ValueError("An exact SHA-1 commit is required")
    if git(source, "rev-parse", f"{pin}^{{commit}}").strip().decode() != pin:
        raise ValueError("Source pin mismatch")
    process = subprocess.Popen(["git", *WINDOWS_GIT_ARGS, "--no-replace-objects", "-C", str(source), "fast-export", "--no-data",
                                "--full-tree", "--show-original-ids", "--use-done-feature", pin, "--",
                                ":(top,literal)AgentHub", ":(top,literal)TelegramIntegration"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=git_environment())
    try:
        stream = process.stdout
        while line := stream.readline():
            if line in (b"feature done\n", b"done\n", b"\n"):
                continue
            if line.startswith(b"reset "):
                # Native initial reset has no following blank or from record.
                continue
            if not line.startswith(b"commit "):
                raise ValueError("Unexpected fast-export record")
            record = {"parents": [], "files": [], "excluded": []}
            while line := stream.readline():
                if line == b"\n":
                    break
                key, _, value = line.rstrip(b"\n").partition(b" ")
                if key == b"data":
                    size = int(value)
                    record["message"] = stream.read(size)
                    # fast-export's data is length-delimited; its commit message
                    # usually includes the trailing newline, with no extra LF.
                elif key in (b"mark", b"original-oid", b"author", b"committer", b"encoding"):
                    record[key.decode()] = value
                elif key in (b"from", b"merge"):
                    if not re.fullmatch(rb":[0-9]+", value):
                        raise ValueError("Unmapped external parent refused")
                    record["parents"].append(value)
                elif key == b"deleteall":
                    pass
                elif key == b"M":
                    mode, oid, name = value.split(b" ", 2)
                    if mode not in (b"100644", b"100755") or not re.fullmatch(rb"[0-9a-f]{40}", oid):
                        raise ValueError("Symlink, submodule or unknown object refused")
                    mapped = projected_path(name)
                    if mapped is None:
                        record["excluded"].append((name.decode("utf-8", "replace"), oid.decode()))
                    else:
                        record["files"].append((mode, oid, mapped))
                else:
                    raise ValueError(f"Unsupported export command: {key!r}")
            yield record
        if process.wait(timeout=60):
            raise RuntimeError("Native source export failed: "+process.stderr.read().decode("utf-8", "replace"))
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=30)
        process.stdout.close()
        process.stderr.close()


def plan(source: Path, pin: str, output: Path):
    output.mkdir(parents=True, exist_ok=False)
    reader = Objects(source)
    blobs, commits, excluded = {}, [], set()
    try:
        for record in export_commits(source, pin):
            files = record["files"]
            paths = [x[2] for x in files]
            if len(set(paths)) != len(paths):
                raise ValueError("Historical prefix collision at "+record["original-oid"].decode()+": "+
                                 repr([p.decode() for p in set(paths) if paths.count(p) > 1]))
            for mode, oid, name in files:
                key = oid.decode()
                if key not in blobs:
                    kind, data = reader.get(oid)
                    if kind != b"blob":
                        raise ValueError("File object is not a blob")
                    binary = b"\0" in data[:8192]
                    blobs[key] = {"oid": key, "sha256": digest(data), "bytes": len(data),
                                  "signals": scan(data), "binary": binary, "paths": []}
                path = name.decode()
                if path not in blobs[key]["paths"]:
                    blobs[key]["paths"].append(path)
            message = record["message"]
            commits.append({"oid": record["original-oid"].decode(), "mark": record["mark"].decode(),
                            "metadataSha256": digest(record["author"]+b"\n"+record["committer"]+b"\n"+message),
                            "messageSignals": scan(message), "fileCount": len(files),
                            "manifestSha256": digest(b"\n".join(sorted(m+b" "+o+b" "+n for m, o, n in files)))})
            excluded.update(record["excluded"])
    finally:
        reader.close()
    result = {"schema": 1, "pin": pin, "prefixes": PREFIXES, "commits": commits,
              "blobs": sorted(blobs.values(), key=lambda x: x["oid"]), "excluded": sorted(excluded),
              "metadataPolicy": "Keep reviewed subject only; drop bodies and original email; preserve timestamps and reviewed public attribution."}
    write_json(output/"plan.private.json", result)
    plan_hash = digest((output/"plan.private.json").read_bytes())
    write_json(output/"summary.json", {"schema": 1, "pin": pin, "planSha256": plan_hash,
                                     "commits": len(commits), "blobs": len(blobs),
                                     "bytes": sum(x["bytes"] for x in blobs.values()),
                                     "flaggedBlobs": sum(bool(x["signals"]) for x in blobs.values()),
                                     "binaryBlobs": sum(x["binary"] for x in blobs.values()),
                                     "excludedPathVersions": len(excluded), "publicApproval": False})
    print((output/"summary.json").read_text(encoding="utf-8"))


def extract(source: Path, plan_file: Path, decisions_file: Path, destination: Path):
    """Import only projected objects into a NEW private bare repository.

    No alternates, clone, fetch, original refs, notes, tags, config or hooks are
    copied. The caller must review this local result before any public push.
    """
    plan_bytes = plan_file.read_bytes()
    approved = json.loads(decisions_file.read_text(encoding="utf-8"))
    expected = json.loads(plan_bytes)
    if approved.get("planSha256") != digest(plan_bytes):
        raise ValueError("Decisions do not bind this exact history plan")
    blob_decisions = approved.get("blobs", {})
    metadata = approved.get("commits", {})
    for blob in expected["blobs"]:
        if blob["signals"] or blob["binary"]:
            choice = blob_decisions.get(blob["oid"], {})
            if choice.get("decision") not in ("allow", "exclude") or not choice.get("reason", "").strip():
                raise ValueError("Unreviewed flagged/binary blob: "+blob["oid"])
    for commit in expected["commits"]:
        choice = metadata.get(commit["oid"], {})
        if not isinstance(choice.get("subject"), str) or not choice["subject"].strip() or scan(choice["subject"].encode()):
            raise ValueError("Missing or unsafe reviewed commit subject")
        for key in ("author", "committer"):
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}", choice.get(key, "")):
                raise ValueError("Missing reviewed public attribution")
    if destination.exists():
        raise ValueError("Destination must not exist")
    if git(source, "rev-parse", "--show-object-format").strip() != b"sha1":
        raise ValueError("Only explicitly supported SHA-1 source repositories are accepted")
    destination.parent.mkdir(parents=True, exist_ok=True)
    git(destination.parent, "init", "--bare", "--initial-branch=main", str(destination))
    # Private local extraction only. There is deliberately no remote or push API.
    marks = destination.parent/(destination.name+".import-marks.private")
    errors = destination.parent/(destination.name+".import.stderr.private.log")
    expected_blobs = {x["oid"]: x for x in expected["blobs"]}
    expected_commits = {x["oid"]: x for x in expected["commits"]}
    reader = Objects(source)
    seen, mapping, projected = set(), {}, []
    aliases, manifests = {}, {}
    emitted = 0
    blob_mark = 1_000_000_000
    with errors.open("wb") as diagnostics:
        importer = subprocess.Popen(["git", *WINDOWS_GIT_ARGS, "-C", str(destination), "fast-import", "--quiet", "--done",
                                     "--export-marks="+str(marks)], stdin=subprocess.PIPE, stderr=diagnostics, env=git_environment())
        try:
            out = importer.stdin
            out.write(b"feature done\n")
            for record in export_commits(source, expected["pin"]):
                oid = record["original-oid"].decode()
                spec = expected_commits.get(oid)
                files = record["files"]
                manifest = digest(b"\n".join(sorted(m+b" "+o+b" "+n for m, o, n in files)))
                if not spec or spec["manifestSha256"] != manifest or spec["metadataSha256"] != digest(
                        record["author"]+b"\n"+record["committer"]+b"\n"+record["message"]):
                    raise ValueError("Source history changed from plan")
                retained = []
                for mode, blob, name in files:
                    key = blob.decode()
                    if blob_decisions.get(key, {}).get("decision") == "exclude":
                        continue
                    if blob not in seen:
                        kind, data = reader.get(blob)
                        if kind != b"blob" or digest(data) != expected_blobs[key]["sha256"]:
                            raise ValueError("Source blob changed from plan")
                        out.write(b"blob\nmark :"+str(blob_mark).encode()+b"\ndata "+str(len(data)).encode()+b"\n"+data+b"\n")
                        # Refer to native OID below, not this private temporary mark.
                        blob_mark += 1
                        seen.add(blob)
                    retained.append((mode, blob, name))
                parents = list(dict.fromkeys(aliases[p] for p in record["parents"] if aliases[p] is not None))
                signature = tuple(sorted(retained))
                mark = record["mark"]
                mapping[mark.decode()] = oid
                if not parents and not retained:
                    aliases[mark] = None
                    projected.append((mark.decode(), None, retained, "empty-root-after-exclusions"))
                    continue
                if len(parents) == 1 and manifests[parents[0]] == signature:
                    aliases[mark] = parents[0]
                    projected.append((mark.decode(), parents[0].decode(), retained, "unchanged-single-parent-projection"))
                    continue
                aliases[mark] = mark
                manifests[mark] = signature
                emitted += 1
                choice = metadata[oid]
                out.write(b"commit refs/heads/main\nmark "+record["mark"]+b"\n")
                for role in ("author", "committer"):
                    match = re.fullmatch(rb".* <[^<>\n]*> ([0-9]+ [+-][0-9]{4})", record[role])
                    if not match:
                        raise ValueError("Unsupported source identity")
                    public = choice[role].encode("ascii")
                    email = b"redacted@agent-hub.invalid"
                    out.write(role.encode()+b" "+public+b" <"+email+b"> "+match[1]+b"\n")
                subject = choice["subject"].strip().encode("utf-8")+b"\n"
                if b"\n" in subject[:-1] or b"\r" in subject or b"\0" in subject:
                    raise ValueError("Commit subject must be one reviewed line")
                out.write(b"data "+str(len(subject)).encode()+b"\n"+subject)
                for index, parent in enumerate(parents):
                    out.write((b"from " if index == 0 else b"merge ")+parent+b"\n")
                out.write(b"deleteall\n")
                for mode, blob, name in retained:
                    # UTF-8 bytes are quoted by JSON with ASCII escapes disabled.
                    # Git paths support literal UTF-8 plus only JSON's overlapping
                    # quote/backslash escapes; control characters refuse here.
                    if any(c < 32 for c in name):
                        raise ValueError("Control character in public path")
                    quoted = b'"'+name.replace(b"\\", b"\\\\").replace(b'"', b'\\"')+b'"'
                    out.write(b"M "+mode+b" "+blob+b" "+quoted+b"\n")
                out.write(b"\n")
                projected.append((mark.decode(), mark.decode(), retained, None))
            if len(projected) != len(expected_commits):
                raise ValueError("Commit coverage mismatch")
            if not projected or not projected[-1][2]:
                raise ValueError("Selected source projection is empty")
            # A filtered tail may alias an earlier retained parent. Explicitly
            # point main at the selected pin's alias, independent of stream order.
            out.write(b"reset refs/heads/main\nfrom "+aliases[record["mark"]]+b"\n\n")
            out.write(b"done\n")
            out.close()
            if importer.wait(timeout=120):
                raise RuntimeError("Native importer failed; private diagnostics retained")
        finally:
            if importer.poll() is None:
                importer.stdin.close()
                importer.terminate()
                importer.wait(timeout=30)
            reader.close()
    imported = dict(line.split() for line in marks.read_text(encoding="ascii").splitlines())
    # Every projected commit, not just HEAD, must retain exact modes, names and
    # native blob OIDs after the declared exclusions. Native Git owns trees.
    trees, verified, result = {}, set(), []
    for mark, canonical, files, reason in projected:
        if canonical is None:
            if files:
                raise ValueError("Nonempty projection lost its public identity")
            result.append({"oldCommit": mapping[mark], "newCommit": None, "newTree": None,
                           "files": 0, "projectionVerified": True, "prunedReason": reason})
            continue
        new_commit = imported[canonical]
        tree = git(destination, "rev-parse", new_commit+"^{tree}").strip().decode()
        wanted = sorted((m+b" blob "+o+b"\t"+n) for m, o, n in files)
        if tree not in trees:
            trees[tree] = sorted(x for x in git(destination, "ls-tree", "-rz", "--full-tree", new_commit).split(b"\0") if x)
        if trees[tree] != wanted:
            raise ValueError("Imported tree does not equal declared source projection")
        verified.add(tree)
        result.append({"oldCommit": mapping[mark], "newCommit": new_commit, "newTree": tree,
                       "files": len(files), "projectionVerified": True, "prunedReason": reason})
    git(destination, "fsck", "--strict", "--no-reflogs")
    tip = git(destination, "rev-parse", "refs/heads/main").strip().decode()
    selected = []
    for row in git(source, "ls-tree", "-rz", "--full-tree", expected["pin"], "--",
                   ":(top,literal)AgentHub", ":(top,literal)TelegramIntegration").split(b"\0"):
        if not row:
            continue
        header, name = row.split(b"\t", 1)
        mode, kind, blob = header.split()
        mapped = projected_path(name)
        if mapped is not None and blob_decisions.get(blob.decode(), {}).get("decision") != "exclude":
            selected.append(mode+b" "+kind+b" "+blob+b"\t"+mapped)
    actual_tip = sorted(x for x in git(destination, "ls-tree", "-rz", "--full-tree", tip).split(b"\0") if x)
    if sorted(selected) != actual_tip:
        raise ValueError("Selected source pin does not equal final imported projection")
    write_json(destination.parent/(destination.name+".mapping.private.json"),
               {"schema": 2, "pin": expected["pin"], "planSha256": digest(plan_bytes),
                "decisionsSha256": digest(decisions_file.read_bytes()), "commits": result,
                "publicCommits": emitted, "prunedCommits": len(projected)-emitted,
                "tip": tip, "selectedPinProjectionVerified": True,
                "inputRepositoryWrites": False, "reinterpretsOldReceipts": False, "publicApproval": False})
    print(json.dumps({"commits": len(result), "publicCommits": emitted, "treesVerified": len(verified),
                      "blobs": len(seen), "publicApproval": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("plan")
    command.add_argument("--source", type=Path, required=True)
    command.add_argument("--pin", required=True)
    command.add_argument("--output", type=Path, required=True)
    command = commands.add_parser("extract")
    command.add_argument("--source", type=Path, required=True)
    command.add_argument("--plan", type=Path, required=True)
    command.add_argument("--decisions", type=Path, required=True)
    command.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "plan":
        plan(args.source, args.pin, args.output)
    else:
        extract(args.source, args.plan, args.decisions, args.destination)


if __name__ == "__main__":
    main()
