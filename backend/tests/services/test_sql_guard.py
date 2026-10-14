import pytest
from sqlalchemy import text

from app.services.chat_service import create_readonly_engine, validate_readonly_sql


@pytest.mark.parametrize("query", [
    "DELETE FROM users",
    "UPDATE users SET role = 'admin'",
    "SELECT 1; DROP TABLE projects",
    "INSERT INTO projects (id) VALUES ('x')",
    "PRAGMA table_info(users)",
    "ATTACH DATABASE 'x.db' AS x",
    "WITH x AS (SELECT 1) DELETE FROM tasks",
    "SELECT hashed_password FROM users",
    "SELECT * FROM users",
    "SELECT u.* FROM users u JOIN projects p ON p.owner_id = u.id",
    "SELECT value FROM settings",
    "SELECT title FROM trips",
    "/* x */ DELETE FROM tasks",
])
def test_unsafe_or_reserved_queries_are_rejected(query):
    assert validate_readonly_sql(query) is not None


@pytest.mark.parametrize("query", [
    "SELECT name, code FROM projects WHERE status = 'active'",
    "SELECT COUNT(*) FROM users",
    "SELECT username, full_name, department FROM users",
    "WITH t AS (SELECT project_id, COUNT(*) c FROM tasks GROUP BY project_id) SELECT * FROM t",
    "SELECT text FROM tasks WHERE text LIKE '%update%';",
])
def test_plain_reads_are_allowed(query):
    assert validate_readonly_sql(query) is None


def test_readonly_engine_rejects_writes(tmp_path):
    db_file = tmp_path / "ro.db"
    from sqlalchemy import create_engine
    with create_engine(f"sqlite:///{db_file}").begin() as conn:
        conn.execute(text("CREATE TABLE t (x INTEGER)"))
        conn.execute(text("INSERT INTO t VALUES (1)"))

    engine = create_readonly_engine(f"sqlite:///{db_file}")
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM t")).scalar() == 1
    with pytest.raises(Exception):
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM t"))
