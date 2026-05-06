import sqlite3
import os
from pathlib import Path

class DatabaseManager:
    def __init__(self):
        self.db_path = self._get_icloud_db_path()
        self._init_db()

    def _get_icloud_db_path(self):
        """macOS iCloud Drive 경로를 찾아 DB 경로를 반환합니다."""
        home = Path.home()
        # iCloud Drive의 표준 경로
        icloud_drive = home / "Library/Mobile Documents/com~apple~CloudDocs"
        
        if icloud_drive.exists():
            # iCloud 내에 앱 전용 폴더 생성
            vault_folder = icloud_drive / "ConnectVault"
            vault_folder.mkdir(parents=True, exist_ok=True)
            return str(vault_folder / "vault.db")
        else:
            # iCloud를 사용할 수 없는 환경(Windows, Linux 또는 로그아웃 상태)일 경우 로컬 폴더 사용
            print("iCloud Drive를 찾을 수 없습니다. 로컬 저장소를 사용합니다.")
            return "vault.db"

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            # 1. 설정 테이블 (솔트 등 저장)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value BLOB
                )
            """)
            # 2. 패스워드 금고 테이블
            conn.execute("""
                CREATE TABLE IF NOT EXISTS vault (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service TEXT NOT NULL,
                    username TEXT NOT NULL,
                    encrypted_password BLOB NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

    def set_config(self, key, value):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, value))
            conn.commit()

    def get_config(self, key):
        with sqlite3.connect(self.db_path) as conn:
            res = conn.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
            return res[0] if res else None

    def add_password(self, service, username, encrypted_pw):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("INSERT INTO vault (service, username, encrypted_password) VALUES (?, ?, ?)",
                         (service, username, encrypted_pw))
            conn.commit()

    def get_all_passwords(self):
        with sqlite3.connect(self.db_path) as conn:
            return conn.execute("SELECT id, service, username, encrypted_password FROM vault").fetchall()

    def delete_password(self, entry_id):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM vault WHERE id = ?", (entry_id,))
            conn.commit()