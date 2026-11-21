"""Symmetric encryption for stored secrets (camera RTSP credentials).

Uses Fernet (AES-128-CBC + HMAC) from `cryptography`. The key is derived
from `JWT_SECRET_KEY` via SHA-256 → urlsafe-b64, so no extra secret needs
provisioning — rotating the JWT key rotates this too (a migration would
then be required; documented in deployment notes). `CAMERA_CREDENTIAL_KEY`
may be set to a dedicated Fernet key to decouple the two.
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings


def _fernet() -> Fernet:
    key = (settings.CAMERA_CREDENTIAL_KEY or "").strip()
    if not key:
        digest = hashlib.sha256(("airos-camera-creds|" + settings.JWT_SECRET_KEY).encode()).digest()
        key = base64.urlsafe_b64encode(digest).decode()
    return Fernet(key.encode())


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise ValueError("Stored credential could not be decrypted") from exc
