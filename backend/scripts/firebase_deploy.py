"""Deploy frontend/dist to Firebase Hosting site airos-super-admin-dev via REST."""
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlencode

SITE = "sites/airos-super-admin-dev"
DIST = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
API = "https://firebasehosting.googleapis.com/v1beta1"


@lru_cache(maxsize=1)
def token():
    exe = shutil.which("gcloud") or "gcloud"
    result = subprocess.run([exe, "auth", "print-access-token"], capture_output=True, text=True, check=True)
    value = result.stdout.strip()
    if not value:
        raise RuntimeError("No authenticated deployment identity")
    return value


def req(method, url, body=None, raw=None, ct="application/json"):
    data = json.dumps(body).encode() if body is not None else raw
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token()}")
    request.add_header("x-goog-user-project", "final-airos-os")
    if data is not None:
        request.add_header("Content-Type", ct)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Hosting deployment request failed: HTTP {error.code}") from None


def build_manifest(directory):
    root = Path(directory)
    if not (root / "index.html").is_file():
        raise RuntimeError("A verified frontend build with index.html is required")
    files, payloads = {}, {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("Hosting build must not contain symlinks")
        if not path.is_file():
            continue
        data = gzip.compress(path.read_bytes(), mtime=0)
        digest = hashlib.sha256(data).hexdigest()
        files["/" + path.relative_to(root).as_posix()] = digest
        payloads[digest] = data
    return files, payloads


def main():
    files, payloads = build_manifest(DIST)
    print(f"{len(files)} build files verified")
    version = req("POST", f"{API}/{SITE}/versions", {"config": {
        "rewrites": [{"glob": "**", "path": "/index.html"}],
        "headers": [
            {"glob": "**", "headers": {"Cache-Control": "no-cache"}},
            {"glob": "/assets/**", "headers": {"Cache-Control": "public, max-age=31536000, immutable"}},
        ],
    }})
    name = version["name"]
    if not name.startswith(SITE + "/versions/"):
        raise RuntimeError("Unexpected Hosting target returned; release aborted")
    populated = req("POST", f"{API}/{name}:populateFiles", {"files": files})
    upload_url = populated["uploadUrl"]
    if not upload_url.startswith("https://upload-firebasehosting.googleapis.com/upload/" + SITE + "/versions/"):
        raise RuntimeError("Unexpected upload origin returned; release aborted")
    needed = set(populated.get("uploadRequiredHashes", []))
    if not needed.issubset(payloads):
        raise RuntimeError("Unexpected build hashes returned; release aborted")
    for digest in sorted(needed):
        req("POST", f"{upload_url}/{digest}", raw=payloads[digest], ct="application/octet-stream")
    print(f"{len(needed)} content-addressed assets uploaded")
    req("PATCH", f"{API}/{name}?updateMask=status", {"status": "FINALIZED"})
    release = req("POST", f"{API}/{SITE}/releases?{urlencode({'versionName': name})}", {"message": "Development shared-media fix"})
    print("released:", release["name"], "version:", name)


if __name__ == "__main__":
    main()
