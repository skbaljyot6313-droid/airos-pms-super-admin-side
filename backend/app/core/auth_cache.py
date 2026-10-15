"""Short-TTL in-process cache for `get_current_user` (B-05).

Every authenticated request used to pay a full remote-DB round trip just
to reload the same users row. Caching a detached User snapshot removes
that per-request RTT for warm traffic while keeping the authorization
fields (is_active/role/company_id/property_id) bounded-fresh.

Consistency contract
--------------------
* In-process mutations (deactivate/reactivate, profile updates, password
  changes) MUST call `invalidate()` after writing — they do.
* Mutations by OTHER processes (the shared DB means the Employee Backend
  can flip is_active too) propagate within AUTH_CACHE_TTL_SECONDS —
  that is the documented maximum stale-authorization window, already far
  inside the 30-minute access-token lifetime.
* The cached User is stored DETACHED (expunged) and returned detached:
  endpoints only read column attrs + the eager-loaded `company`.
  `PATCH /me` re-fetches a persistent instance before mutating — a
  detached object passed to flush() would silently not persist, and a
  merged stale object would write back old attribute values.
"""

import time
import uuid

from app.core.config import settings
from app.models.user import User

_cache: dict[uuid.UUID, tuple[User, float]] = {}


def get(user_id: uuid.UUID) -> User | None:
    """Return the cached detached User when present and unexpired."""
    if settings.AUTH_CACHE_TTL_SECONDS <= 0:
        return None
    entry = _cache.get(user_id)
    if entry is None:
        return None
    user, expires_at = entry
    if expires_at <= time.monotonic():
        _cache.pop(user_id, None)
        return None
    return user


def put(user: User) -> None:
    """Cache a DETACHED User snapshot (caller must expunge first)."""
    if settings.AUTH_CACHE_TTL_SECONDS <= 0:
        return
    # Bound the map — user rows are few, but never grow unboundedly.
    if len(_cache) > 10_000:
        _cache.clear()
    _cache[user.id] = (user, time.monotonic() + settings.AUTH_CACHE_TTL_SECONDS)


def invalidate(user_id: uuid.UUID) -> None:
    _cache.pop(user_id, None)
