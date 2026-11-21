"""Unit tests for upload signature validation (no DB, no storage)."""
import pytest

from app.api.v1.media import _OBJECT_KEY_RE, _matches_image_signature

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
WEBP = b"RIFF" + b"\x10\x00\x00\x00" + b"WEBP" + b"\x00" * 8
HEIC = b"\x00\x00\x00\x18" + b"ftyp" + b"heic" + b"\x00" * 8
GARBAGE = b"MZ" + b"\x90" * 20


@pytest.mark.parametrize(
    "data,ctype,ok",
    [
        (JPEG, "image/jpeg", True),
        (PNG, "image/png", True),
        (WEBP, "image/webp", True),
        (HEIC, "image/heic", True),
        (HEIC, "image/heif", True),
        (GARBAGE, "image/jpeg", False),
        (JPEG, "image/png", False),   # wrong type claim
        (GARBAGE, "image/heic", False),
        (b"", "image/jpeg", False),
    ],
)
def test_signature(data, ctype, ok):
    assert _matches_image_signature(data, ctype) is ok


@pytest.mark.parametrize(
    "key,ok",
    [
        ("a" * 32 + ".jpg", True),
        ("0f" * 16 + ".webp", True),
        ("../secret", False),
        ("a" * 32 + "/x.jpg", False),
        ("a" * 31 + ".jpg", False),
        ("A" * 32 + ".jpg", False),   # uppercase → not a uuid4 hex key
        ("", False),
    ],
)
def test_object_key_whitelist(key, ok):
    assert bool(_OBJECT_KEY_RE.fullmatch(key)) is ok
