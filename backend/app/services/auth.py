"""
AuthService — signup, login, token issue/refresh/revocation, profile.

Router → Service → Repository → SQLAlchemy.
"""

import uuid
import logging
from datetime import datetime, timezone

from fastapi import status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import auth_cache
from app.core.exceptions import AppError
from app.core.security import (
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    refresh_token_expiry,
    slugify_username,
    verify_password,
)
from app.core.verify_queue import dummy_hash, get_verify_queue
from app.models.user import User, UserRole
from app.models.audit import AuditEvent
from app.repositories.company import CompanyRepository
from app.repositories.refresh_token import RefreshTokenRepository
from app.repositories.user import UserRepository
from app.schemas.auth import AuthResponse, SignupRequest, company_to_out, user_to_out
from app.services.audit import AuditService


class AuthError(AppError):
    pass


class InvalidCredentials(AuthError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "INVALID_CREDENTIALS"
    message = "Invalid email/username or password."


class EmailAlreadyExists(AuthError):
    status_code = status.HTTP_409_CONFLICT
    code = "EMAIL_ALREADY_EXISTS"
    message = "An account with this email already exists."


class UsernameTaken(AuthError):
    status_code = status.HTTP_409_CONFLICT
    code = "USERNAME_TAKEN"
    message = "This username is already taken."


class AccountInactive(AuthError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "ACCOUNT_INACTIVE"
    message = "This account has been deactivated."


class InvalidRefreshToken(AuthError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "INVALID_REFRESH_TOKEN"
    message = "Session expired. Please sign in again."


class AuthService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.users = UserRepository(session)
        self.companies = CompanyRepository(session)
        self.tokens = RefreshTokenRepository(session)

    # ------------------------------------------------------------------
    # Tokens
    # ------------------------------------------------------------------
    async def _issue_tokens(self, user: User, *,
                            mark_login: bool = False) -> tuple[str, str]:
        access = create_access_token(
            user_id=str(user.id),
            company_id=str(user.company_id),
            role=user.role.value,
        )
        refresh = generate_refresh_token()
        if mark_login:
            # One round trip: the last-login UPDATE and the refresh-token
            # INSERT previously flushed as two statements (~1 extra remote
            # RTT per login under a measured pool-wait-dominated path).
            # The CTE keeps them atomic inside the existing commit.
            now = datetime.now(timezone.utc)
            await self.session.execute(
                text(
                    "WITH u AS ("
                    "  UPDATE users SET last_login_at = :now, "
                    "                   updated_at = :now "
                    "  WHERE id = :uid RETURNING id) "
                    "INSERT INTO refresh_tokens "
                    "  (id, user_id, token_hash, expires_at, revoked, created_at) "
                    "SELECT :tid, u.id, :th, :exp, false, :now FROM u"
                ),
                {
                    "now": now, "uid": user.id,
                    "tid": uuid.uuid4(),
                    "th": hash_refresh_token(refresh),
                    "exp": refresh_token_expiry(),
                },
            )
            user.last_login_at = now
        else:
            await self.tokens.create(
                user_id=user.id,
                token_hash=hash_refresh_token(refresh),
                expires_at=refresh_token_expiry(),
            )
        return access, refresh

    async def _auth_response(self, user: User, *,
                             mark_login: bool = False) -> AuthResponse:
        # Token row + any pending writes commit in a single transaction
        access, refresh = await self._issue_tokens(user, mark_login=mark_login)
        AuditService(self.session).record(
            user, entity_type="session", entity_id=user.id, entity_name=user.name,
            action="logged_in" if mark_login else "account_registered", property_id=user.property_id,
            detail={"category": "session", "actor_role": user.role.value, "outcome": "successful",
                    "http_status": 200 if mark_login else 201, "channel": "management_api",
                    "actor_identity_verified": True},
        )
        await self.session.commit()
        return AuthResponse(
            access_token=access,
            refresh_token=refresh,
            user=user_to_out(user),
            company=company_to_out(user.company),
        )

    async def _unique_username(self, seed: str) -> str:
        base = slugify_username(seed)
        candidate = base
        n = 1
        while await self.users.username_exists(candidate):
            n += 1
            candidate = f"{base}.{n}"
        return candidate

    # ------------------------------------------------------------------
    # Signup — company + initial SUPER_ADMIN in one transaction
    # ------------------------------------------------------------------
    async def signup(self, payload: SignupRequest) -> AuthResponse:
        if await self.users.get_by_email(payload.email):
            raise EmailAlreadyExists()

        username = await self._unique_username(payload.email.split("@")[0])
        # Display name from the email local part until the user edits it
        name = " ".join(
            p.capitalize() for p in slugify_username(payload.email.split("@")[0]).split(".")
        )

        # The session autobegins — both creates flush into one transaction
        # and commit atomically. A failure anywhere rolls back both rows.
        company = await self.companies.create(
            company_name=payload.company_name.strip(),
            brand_name=payload.brand_name.strip(),
            address=payload.address.strip(),
            pin_code=payload.pin_code,
            email=payload.email,
            phone_number=payload.phone,
        )
        try:
            user = await self.users.create(
                company_id=company.id,
                name=name,
                email=payload.email,
                username=username,
                password_hash=hash_password(payload.password),
                phone_number=payload.phone,
                role=UserRole.SUPER_ADMIN,
                job_title="Administrator",
            )
        except IntegrityError as exc:
            # Unique constraint fired (concurrent signup) — rolls back
            # both company and user so no orphan remains.
            raise EmailAlreadyExists() from exc

        # ensure the relationship is available for serialization
        user.company = company

        return await self._auth_response(user)

    # ------------------------------------------------------------------
    # Login — identifier may be email or username
    # ------------------------------------------------------------------
    async def _record_failed_attempt(self, user: User | None, action: str, error: AppError) -> None:
        self.session.add(AuditEvent(
            property_id=user.property_id if user else None, actor_user_id=None, actor_name=None,
            entity_type="session", entity_id=user.id if user else None,
            entity_name=user.name if user else None, action=action,
            detail={"category": "session", "company_uid": str(user.company_id) if user else None,
                    "target_account_name": user.name if user else None, "actor_identity_verified": False,
                    "outcome": "failed", "reason_code": error.code, "http_status": error.status_code,
                    "channel": "management_api"},
        ))
        try:
            await self.session.commit()
        except SQLAlchemyError:
            await self.session.rollback()
            logging.getLogger(__name__).warning("Authentication failure audit could not be persisted")

    async def login(self, identifier: str, password: str) -> AuthResponse:
        user = await self.users.get_by_identifier(identifier)
        # Release the DB connection before the CPU-bound verify — the
        # lookup tx is read-only, and measured pool checkout wait (p50
        # ~8.7s under burst) shows the conn held through the argon2 queue
        # is the serializer, not argon2 itself. expire_on_commit=False
        # keeps `user` usable; the token insert re-acquires later.
        await self.session.commit()
        # Uniform failure — never reveal which part was wrong. Unknown
        # accounts verify a dummy argon2 hash so they cost the same queue
        # slot + CPU as real users (no timing-based enumeration).
        password_hash = (
            user.password_hash if user is not None else dummy_hash())
        try:
            ok = await get_verify_queue().verify(verify_password, password, password_hash)
        except AppError as error:
            await self._record_failed_attempt(user, "login_failed", error)
            raise
        if user is None or not ok:
            error = InvalidCredentials()
            await self._record_failed_attempt(user, "login_failed", error)
            raise error
        if not user.is_active:
            error = AccountInactive()
            await self._record_failed_attempt(user, "login_failed", error)
            raise error

        auth_cache.invalidate(user.id)
        return await self._auth_response(user, mark_login=True)

    # ------------------------------------------------------------------
    # Refresh / logout
    # ------------------------------------------------------------------
    async def refresh(self, refresh_token: str) -> str:
        stored = await self.tokens.get_valid(hash_refresh_token(refresh_token))
        if stored is None:
            error = InvalidRefreshToken()
            await self._record_failed_attempt(None, "refresh_failed", error)
            raise error
        user = await self.users.get_by_id(stored.user_id)
        if user is None or not user.is_active:
            error = InvalidRefreshToken()
            await self._record_failed_attempt(user, "refresh_failed", error)
            raise error
        AuditService(self.session).record(
            user, entity_type="session", entity_id=user.id, entity_name=user.name,
            action="session_refreshed", property_id=user.property_id,
            detail={"category": "session", "actor_role": user.role.value, "outcome": "successful",
                    "http_status": 200, "channel": "management_api", "actor_identity_verified": True},
        )
        await self.session.commit()
        return create_access_token(
            user_id=str(user.id),
            company_id=str(user.company_id),
            role=user.role.value,
        )

    async def logout(self, refresh_token: str | None) -> None:
        if refresh_token:
            stored = await self.tokens.get_valid(hash_refresh_token(refresh_token))
            if stored is None:
                return
            user = await self.users.get_by_id(stored.user_id)
            stored.revoked = True
            if user is not None:
                AuditService(self.session).record(
                    user, entity_type="session", entity_id=user.id, entity_name=user.name,
                    action="logged_out", property_id=user.property_id,
                    detail={"category": "session", "actor_role": user.role.value, "outcome": "successful",
                            "http_status": 204, "channel": "management_api", "actor_identity_verified": True},
                )
            await self.session.commit()
