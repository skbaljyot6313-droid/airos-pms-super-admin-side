import gzip
import hashlib
from unittest.mock import MagicMock

import pytest

from scripts import firebase_deploy as deploy


def test_build_manifest_is_deterministic_and_content_addressed(tmp_path):
    (tmp_path / "index.html").write_text("<html>synthetic</html>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("synthetic")
    first, payloads = deploy.build_manifest(tmp_path)
    assert deploy.build_manifest(tmp_path) == (first, payloads)
    assert set(first) == {"/index.html", "/assets/app.js"}
    for path, digest in first.items():
        assert hashlib.sha256(payloads[digest]).hexdigest() == digest
        assert gzip.decompress(payloads[digest]) == (tmp_path / path.lstrip("/")).read_bytes()


def test_missing_build_cannot_replace_site(tmp_path):
    with pytest.raises(RuntimeError, match="index.html"):
        deploy.build_manifest(tmp_path)


def test_release_uses_finalized_version_query_parameter(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("synthetic")
    monkeypatch.setattr(deploy, "DIST", str(tmp_path))
    name = deploy.SITE + "/versions/synthetic"
    request = MagicMock(side_effect=[
        {"name": name},
        {"uploadUrl": "https://upload-firebasehosting.googleapis.com/upload/" + name + "/files", "uploadRequiredHashes": []},
        {},
        {"name": deploy.SITE + "/releases/synthetic"},
    ])
    monkeypatch.setattr(deploy, "req", request)
    deploy.main()
    assert request.call_args_list[2].args == ("PATCH", deploy.API + "/" + name + "?updateMask=status", {"status": "FINALIZED"})
    assert "versionName=sites%2Fairos-super-admin-dev%2Fversions%2Fsynthetic" in request.call_args.args[1]


@pytest.mark.parametrize("url", ["https://external.invalid/upload/", "https://upload-firebasehosting.googleapis.com/upload/sites/wrong-site/versions/test/files"])
def test_deployer_does_not_send_credentials_to_unexpected_upload_origin(url, tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("synthetic")
    monkeypatch.setattr(deploy, "DIST", str(tmp_path))
    request = MagicMock(side_effect=[{"name": deploy.SITE + "/versions/synthetic"}, {"uploadUrl": url}])
    monkeypatch.setattr(deploy, "req", request)
    with pytest.raises(RuntimeError, match="upload origin"):
        deploy.main()
    assert request.call_count == 2
