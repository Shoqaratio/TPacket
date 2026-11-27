"""Server-side administration commands.

Super-administrator rights are never granted through the public API. Run on the server:

    python -m app.cli create-admin vous@exemple.fr --name "Votre nom"
    python -m app.cli promote-admin vous@exemple.fr
    python -m app.cli demote-admin vous@exemple.fr

The password of `create-admin` is read from TPACKET_ADMIN_PASSWORD, or asked interactively.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys

from sqlalchemy import func, select

from .db import SessionLocal
from .models import AuditLog, User
from .security import hash_password, password_policy_error

PASSWORD_ENV = "TPACKET_ADMIN_PASSWORD"


class CliError(Exception):
    pass


def _find(db, email: str) -> User | None:
    return db.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))


def _set_admin(email: str, value: bool) -> User:
    with SessionLocal() as db:
        u = _find(db, email)
        if u is None:
            raise CliError(f"aucun compte pour {email}")
        if u.is_superadmin != value:
            u.is_superadmin = value
            db.add(AuditLog(actor_id=None, action="admin.promote" if value else "admin.demote", target=u.id, data={"via": "cli"}))
            db.commit()
        db.refresh(u)
        db.expunge(u)
        return u


def promote(email: str) -> User:
    return _set_admin(email, True)


def demote(email: str) -> User:
    return _set_admin(email, False)


def create_admin(email: str, password: str, name: str = "Administrateur") -> tuple[User, bool]:
    """Creates a super-admin account, or promotes the existing one. Returns (user, created)."""
    email = email.strip().lower()
    if "@" not in email:
        raise CliError("adresse e-mail invalide")
    with SessionLocal() as db:
        if _find(db, email) is not None:
            created = False
        else:
            err = password_policy_error(password)
            if err:
                raise CliError(f"mot de passe refusé : {err}")
            u = User(email=email, password_hash=hash_password(password), display_name=name.strip()[:120] or "Administrateur", is_superadmin=True)
            db.add(u)
            db.flush()
            db.add(AuditLog(actor_id=None, action="admin.create", target=u.id, data={"via": "cli"}))
            db.commit()
            created = True
    return promote(email), created


def _read_password() -> str:
    pw = os.environ.get(PASSWORD_ENV)
    if pw:
        return pw
    if not sys.stdin.isatty():
        raise CliError(f"définissez {PASSWORD_ENV} ou lancez la commande dans un terminal")
    pw = getpass.getpass("Mot de passe : ")
    if getpass.getpass("Confirmation : ") != pw:
        raise CliError("les mots de passe ne correspondent pas")
    return pw


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m app.cli", description="Administration TPacket")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-admin", help="crée un super-administrateur (ou promeut le compte existant)")
    c.add_argument("email")
    c.add_argument("--name", default="Administrateur")
    sub.add_parser("promote-admin", help="donne les droits super-administrateur").add_argument("email")
    sub.add_parser("demote-admin", help="retire les droits super-administrateur").add_argument("email")
    args = p.parse_args(argv)
    try:
        if args.cmd == "create-admin":
            with SessionLocal() as db:
                exists = _find(db, args.email) is not None
            u, created = create_admin(args.email, "" if exists else _read_password(), args.name)
            print(f"{'Compte créé' if created else 'Compte existant promu'} : {u.email} (super-administrateur)")
        elif args.cmd == "promote-admin":
            print(f"{promote(args.email).email} est super-administrateur")
        else:
            print(f"{demote(args.email).email} n'est plus super-administrateur")
    except CliError as e:
        print(f"Erreur : {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
