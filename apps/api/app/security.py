import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

# Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1).
_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
_DUMMY = _hasher.hash("timing-equaliser")


def hash_password(pw: str) -> str:
    return _hasher.hash(pw)


def verify_password(hash_: str | None, pw: str) -> bool:
    try:
        return _hasher.verify(hash_ or _DUMMY, pw) and hash_ is not None
    except (VerifyMismatchError, InvalidHashError):
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    """Sessions and invite codes are stored hashed: a database leak does not leak live tokens."""
    return hashlib.sha256(token.encode()).hexdigest()


def password_policy_error(pw: str) -> str | None:
    if len(pw) < 10:
        return "password_too_short"
    if len(pw) > 256:
        return "password_too_long"
    return None


class RateLimiter:
    """Sliding-window limiter. In-process: with several API replicas, back it with Redis (ROADMAP)."""

    def __init__(self, limit: int, window_s: float):
        self.limit = limit
        self.window = window_s
        self.hits: dict[str, deque[float]] = defaultdict(deque)
        self.lock = threading.Lock()

    def hit(self, key: str) -> bool:
        t = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and t - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(t)
            return True

    def reset(self) -> None:
        with self.lock:
            self.hits.clear()
