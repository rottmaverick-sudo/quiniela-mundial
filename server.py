from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from http import cookies
from pathlib import Path
from urllib.parse import urlparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
DB_PATH = DATA_DIR / "quiniela.sqlite"
DATABASE_URL = os.environ.get("DATABASE_URL", "")
SESSION_DAYS = 30


GROUPS = {
    "A": ["Mexico", "South Africa", "South Korea", "Czech Republic"],
    "B": ["Canada", "Bosnia and Herzegovina", "Qatar", "Switzerland"],
    "C": ["Brazil", "Morocco", "Haiti", "Scotland"],
    "D": ["United States", "Paraguay", "Australia", "Turkey"],
    "E": ["Germany", "Curacao", "Ivory Coast", "Ecuador"],
    "F": ["Netherlands", "Japan", "Sweden", "Tunisia"],
    "G": ["Belgium", "Egypt", "Iran", "New Zealand"],
    "H": ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"],
    "I": ["France", "Senegal", "Iraq", "Norway"],
    "J": ["Argentina", "Algeria", "Austria", "Jordan"],
    "K": ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
    "L": ["England", "Croatia", "Ghana", "Panama"],
}

GROUP_DATES = {
    "A": ["2026-06-11", "2026-06-18", "2026-06-24"],
    "B": ["2026-06-12", "2026-06-18", "2026-06-24"],
    "C": ["2026-06-13", "2026-06-19", "2026-06-24"],
    "D": ["2026-06-12", "2026-06-19", "2026-06-25"],
    "E": ["2026-06-14", "2026-06-20", "2026-06-25"],
    "F": ["2026-06-14", "2026-06-20", "2026-06-25"],
    "G": ["2026-06-15", "2026-06-21", "2026-06-26"],
    "H": ["2026-06-15", "2026-06-21", "2026-06-26"],
    "I": ["2026-06-16", "2026-06-22", "2026-06-26"],
    "J": ["2026-06-16", "2026-06-22", "2026-06-27"],
    "K": ["2026-06-17", "2026-06-23", "2026-06-27"],
    "L": ["2026-06-17", "2026-06-23", "2026-06-27"],
}

GROUP_PAIRINGS = [(0, 1), (2, 3), (0, 2), (3, 1), (3, 0), (1, 2)]


def starter_matches():
    matches = []
    number = 1
    for group, teams in GROUPS.items():
        dates = GROUP_DATES[group]
        for index, (home_index, away_index) in enumerate(GROUP_PAIRINGS):
            matchday = index // 2
            matches.append((
                f"g{group.lower()}-{index + 1}",
                number,
                f"Primera ronda - Grupo {group}",
                dates[matchday],
                "Por definir",
                teams[home_index],
                teams[away_index],
            ))
            number += 1
    return matches


class DbAdapter:
    def __init__(self):
        self.kind = "postgres" if DATABASE_URL else "sqlite"
        if self.kind == "postgres":
            if psycopg is None:
                raise RuntimeError("psycopg is required when DATABASE_URL is set")
            self.conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
        else:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            self.conn = sqlite3.connect(DB_PATH)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA foreign_keys = ON")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if exc_type:
            self.conn.rollback()
        else:
            self.conn.commit()
        self.conn.close()

    def sql(self, statement):
        if self.kind == "postgres":
            return statement.replace("?", "%s")
        return statement

    def execute(self, statement, params=()):
        return self.conn.execute(self.sql(statement), params)

    def executemany(self, statement, params):
        return self.conn.executemany(self.sql(statement), params)

    def executescript(self, script):
        if self.kind == "sqlite":
            return self.conn.executescript(script)
        for statement in script.split(";"):
            statement = statement.strip()
            if statement:
                self.conn.execute(statement)


def db():
    return DbAdapter()


def first_value(row):
    if isinstance(row, dict):
        return next(iter(row.values()))
    return row[0]


def integrity_error(error):
    if isinstance(error, sqlite3.IntegrityError):
        return True
    return psycopg is not None and isinstance(error, psycopg.errors.UniqueViolation)


def init_db():
    with db() as conn:
        username_unique = "UNIQUE COLLATE NOCASE" if conn.kind == "sqlite" else "UNIQUE"
        conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              username TEXT NOT NULL {username_unique},
              password_hash TEXT NOT NULL,
              is_admin INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS matches (
              id TEXT PRIMARY KEY,
              number INTEGER NOT NULL,
              phase TEXT NOT NULL,
              date TEXT NOT NULL,
              venue TEXT NOT NULL,
              home TEXT NOT NULL,
              away TEXT NOT NULL,
              real_home INTEGER,
              real_away INTEGER
            );

            CREATE TABLE IF NOT EXISTS picks (
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
              pick_home INTEGER,
              pick_away INTEGER,
              PRIMARY KEY (user_id, match_id)
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            """
        )
        count = first_value(conn.execute("SELECT COUNT(*) AS count FROM matches").fetchone())
        if count == 0:
            conn.executemany(
                """
                INSERT INTO matches (id, number, phase, date, venue, home, away)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                starter_matches(),
            )


def hash_password(password, salt=None):
    salt_bytes = base64.b64decode(salt) if salt else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, 200_000)
    return f"{base64.b64encode(salt_bytes).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password, stored):
    salt, expected = stored.split("$", 1)
    candidate = hash_password(password, salt).split("$", 1)[1]
    return hmac.compare_digest(candidate, expected)


def score_match(match, pick):
    if pick is None:
        return 0
    values = [pick["pick_home"], pick["pick_away"], match["real_home"], match["real_away"]]
    if any(value is None for value in values):
        return 0
    ph, pa, rh, ra = values
    if ph == rh and pa == ra:
        return 3
    return 1 if outcome(ph, pa) == outcome(rh, ra) else 0


def outcome(home, away):
    if home == away:
        return "draw"
    return "home" if home > away else "away"


def row_to_match(row):
    return {
        "id": row["id"],
        "number": row["number"],
        "phase": row["phase"],
        "date": row["date"],
        "venue": row["venue"],
        "home": row["home"],
        "away": row["away"],
        "realHome": row["real_home"] if row["real_home"] is not None else "",
        "realAway": row["real_away"] if row["real_away"] is not None else "",
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            self.api_state()
            return
        if path == "/api/me":
            self.api_me()
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/register":
            self.api_register()
            return
        if path == "/api/login":
            self.api_login()
            return
        if path == "/api/logout":
            self.api_logout()
            return
        if path == "/api/matches":
            self.api_add_match()
            return
        if path == "/api/admin/reset-group-stage":
            self.api_reset_group_stage()
            return
        self.send_error(404)

    def do_PATCH(self):
        path = urlparse(self.path).path
        if path.startswith("/api/picks/"):
            self.api_save_pick(path.rsplit("/", 1)[-1])
            return
        if path.startswith("/api/matches/"):
            self.api_update_match(path.rsplit("/", 1)[-1])
            return
        if path == "/api/settings":
            self.api_settings()
            return
        self.send_error(404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/matches/"):
            self.api_delete_match(path.rsplit("/", 1)[-1])
            return
        self.send_error(404)

    def current_user(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie"))
        token = jar.get("qm_session")
        if not token:
            return None
        now = int(time.time())
        with db() as conn:
            row = conn.execute(
                """
                SELECT users.* FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token = ? AND sessions.expires_at > ?
                """,
                (token.value, now),
            ).fetchone()
            return row

    def require_user(self):
        user = self.current_user()
        if not user:
            self.json({"error": "Necesitas iniciar sesion."}, 401)
        return user

    def require_admin(self):
        user = self.require_user()
        if user and not user["is_admin"]:
            self.json({"error": "Solo el administrador puede cambiar resultados o partidos."}, 403)
            return None
        return user

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def json(self, payload, status=200, headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def api_me(self):
        user = self.current_user()
        self.json({"user": public_user(user) if user else None})

    def api_register(self):
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        if len(username) < 2 or len(password) < 6:
            self.json({"error": "Usuario minimo 2 caracteres y contrasena minimo 6."}, 400)
            return

        with db() as conn:
            has_users = first_value(conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()) > 0
            user_id = secrets.token_hex(12)
            try:
                conn.execute(
                    "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user_id, username, hash_password(password), 0 if has_users else 1, int(time.time())),
                )
            except Exception as error:
                if integrity_error(error):
                    self.json({"error": "Ese usuario ya existe."}, 409)
                    return
                raise
        self.create_session(user_id)

    def api_login(self):
        data = self.read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        with db() as conn:
            user = conn.execute("SELECT * FROM users WHERE lower(username) = lower(?)", (username,)).fetchone()
        if not user or not verify_password(password, user["password_hash"]):
            self.json({"error": "Usuario o contrasena incorrectos."}, 401)
            return
        self.create_session(user["id"])

    def create_session(self, user_id):
        token = secrets.token_urlsafe(32)
        expires_at = int(time.time()) + SESSION_DAYS * 24 * 60 * 60
        with db() as conn:
            conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", (token, user_id, expires_at))
            user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        self.json(
            {"user": public_user(user)},
            headers={"Set-Cookie": f"qm_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_DAYS * 24 * 60 * 60}"},
        )

    def api_logout(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie"))
        token = jar.get("qm_session")
        if token:
            with db() as conn:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token.value,))
        self.json({"ok": True}, headers={"Set-Cookie": "qm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"})

    def api_state(self):
        user = self.current_user()
        with db() as conn:
            matches = conn.execute("SELECT * FROM matches ORDER BY number").fetchall()
            picks = conn.execute("SELECT * FROM picks").fetchall()
            users = conn.execute("SELECT id, username, is_admin FROM users ORDER BY username").fetchall()
            settings = {row["key"]: row["value"] for row in conn.execute("SELECT * FROM settings").fetchall()}

        pick_map = {(row["user_id"], row["match_id"]): row for row in picks}
        board = []
        for player in users:
            points = exact = trend = 0
            for match in matches:
                value = score_match(match, pick_map.get((player["id"], match["id"])))
                points += value
                exact += 1 if value == 3 else 0
                trend += 1 if value == 1 else 0
            board.append({"id": player["id"], "name": player["username"], "isAdmin": bool(player["is_admin"]), "points": points, "exact": exact, "trend": trend})
        board.sort(key=lambda item: (-item["points"], -item["exact"], item["name"].lower()))

        my_picks = {}
        if user:
            for row in picks:
                if row["user_id"] == user["id"]:
                    my_picks[row["match_id"]] = {
                        "home": row["pick_home"] if row["pick_home"] is not None else "",
                        "away": row["pick_away"] if row["pick_away"] is not None else "",
                    }

        self.json({
            "user": public_user(user) if user else None,
            "matches": [row_to_match(row) for row in matches],
            "picks": my_picks,
            "leaderboard": board,
            "settings": settings,
        })

    def api_save_pick(self, match_id):
        user = self.require_user()
        if not user:
            return
        data = self.read_json()
        home = number_or_none(data.get("home"))
        away = number_or_none(data.get("away"))
        with db() as conn:
            conn.execute(
                """
                INSERT INTO picks (user_id, match_id, pick_home, pick_away)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, match_id) DO UPDATE SET pick_home = excluded.pick_home, pick_away = excluded.pick_away
                """,
                (user["id"], match_id, home, away),
            )
        self.json({"ok": True})

    def api_update_match(self, match_id):
        if not self.require_admin():
            return
        data = self.read_json()
        allowed = {
            "phase": "phase",
            "date": "date",
            "venue": "venue",
            "home": "home",
            "away": "away",
            "realHome": "real_home",
            "realAway": "real_away",
        }
        fields = []
        values = []
        for key, column in allowed.items():
            if key in data:
                fields.append(f"{column} = ?")
                values.append(number_or_none(data[key]) if key in ("realHome", "realAway") else str(data[key]).strip())
        if fields:
            values.append(match_id)
            with db() as conn:
                conn.execute(f"UPDATE matches SET {', '.join(fields)} WHERE id = ?", values)
        self.json({"ok": True})

    def api_add_match(self):
        if not self.require_admin():
            return
        data = self.read_json()
        match_id = secrets.token_hex(8)
        with db() as conn:
            next_number = first_value(conn.execute("SELECT COALESCE(MAX(number), 0) + 1 AS next_number FROM matches").fetchone())
            conn.execute(
                """
                INSERT INTO matches (id, number, phase, date, venue, home, away)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    match_id,
                    next_number,
                    data.get("phase", "Grupos"),
                    data.get("date", "2026-06-11"),
                    data.get("venue", "Por definir"),
                    data.get("home", "Equipo"),
                    data.get("away", "Equipo"),
                ),
            )
        self.json({"id": match_id}, 201)

    def api_delete_match(self, match_id):
        if not self.require_admin():
            return
        with db() as conn:
            conn.execute("DELETE FROM matches WHERE id = ?", (match_id,))
        self.json({"ok": True})

    def api_reset_group_stage(self):
        if not self.require_admin():
            return
        with db() as conn:
            conn.execute("DELETE FROM picks")
            conn.execute("DELETE FROM matches")
            conn.executemany(
                """
                INSERT INTO matches (id, number, phase, date, venue, home, away)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                starter_matches(),
            )
        self.json({"ok": True, "matches": len(starter_matches())})

    def api_settings(self):
        if not self.require_admin():
            return
        data = self.read_json()
        with db() as conn:
            for key in ("resultsUrl",):
                if key in data:
                    conn.execute(
                        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (key, str(data[key]).strip()),
                    )
        self.json({"ok": True})


def public_user(user):
    return {"id": user["id"], "name": user["username"], "isAdmin": bool(user["is_admin"])}


def number_or_none(value):
    if value == "" or value is None:
        return None
    return max(0, int(value))


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Quiniela lista en http://localhost:{port}")
    server.serve_forever()
