import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta
from typing import cast

from config import get_settings

PASSWORD_ALGORITHM = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 210000
PASSWORD_SALT_BYTES = 16


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(PASSWORD_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    )
    return f"{PASSWORD_ALGORITHM}${PASSWORD_ITERATIONS}${_b64encode(salt)}${_b64encode(digest)}"


def is_password_hash(value: str) -> bool:
    return value.startswith(f"{PASSWORD_ALGORITHM}$")


def verify_password(password: str, stored_value: str) -> bool:
    if not is_password_hash(stored_value):
        return hmac.compare_digest(password, stored_value)

    try:
        algorithm, iterations_text, salt_text, hash_text = stored_value.split("$", 3)
        if algorithm != PASSWORD_ALGORITHM:
            return False
        iterations = int(iterations_text)
        salt = _b64decode(salt_text)
        expected = _b64decode(hash_text)
    except (ValueError, TypeError):
        return False

    candidate = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        iterations,
    )
    return hmac.compare_digest(candidate, expected)


def create_access_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def get_token_expiration() -> datetime:
    ttl_seconds = cast(int, get_settings()["session_ttl_seconds"])
    return datetime.utcnow() + timedelta(seconds=ttl_seconds)
