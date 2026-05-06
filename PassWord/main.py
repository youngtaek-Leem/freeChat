import sys
import random
import string
import sqlite3
from PyQt6.QtWidgets import *
from PyQt6.QtCore import *
from PyQt6.QtGui import *

from security import SecurityManager
from database import DatabaseManager
from ui_components import DarkStyle

class PasswordManagerApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Connect Vault - Secure Password Manager")
        self.resize(900, 600)
        self.setStyleSheet(DarkStyle.SHEET)

        self.sec = SecurityManager()
        self.db = DatabaseManager() # 이제 내부에서 iCloud 경로를 자동으로 결정합니다.
        
        self.init_auth_ui()

    def init_auth_ui(self):
        """로그인/마스터 비밀번호 설정 화면"""
        self.central_widget = QWidget()
        self.setCentralWidget(self.central_widget)
        self.layout = QVBoxLayout(self.central_widget)
        self.layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.auth_container = QFrame()
        self.auth_container.setFixedWidth(400)
        self.auth_container.setStyleSheet(f"background-color: {DarkStyle.PANEL_BG}; border-radius: 15px; padding: 20px;")
        
        auth_layout = QVBoxLayout(self.auth_container)
        
        title = QLabel("Connect Vault")
        title.setStyleSheet("font-size: 24px; font-weight: bold; margin-bottom: 20px;")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        self.pw_input = QLineEdit()
        self.pw_input.setPlaceholderText("마스터 패스워드 입력")
        self.pw_input.setEchoMode(QLineEdit.EchoMode.Password)
        
        self.login_btn = QPushButton("금고 열기")
        self.login_btn.clicked.connect(self.handle_auth)
        
        self.setup_btn = QPushButton("비밀번호 설정/변경")
        self.setup_btn.setStyleSheet("background-color: #444; color: #aaa;")
        self.setup_btn.clicked.connect(self.handle_setup_password)
        
        auth_layout.addWidget(title)
        auth_layout.addWidget(self.pw_input)
        auth_layout.addWidget(self.login_btn)
        auth_layout.addWidget(self.setup_btn)
        
        self.layout.addWidget(self.auth_container)

    def handle_auth(self):
        password = self.pw_input.text()
        if not password:
            QMessageBox.warning(self, "오류", "비밀번호를 입력하세요.")
            return

        salt = self.db.get_config("master_salt")
        hashed_pw = self.db.get_config("master_hash")
        
        if salt is None or hashed_pw is None:
            QMessageBox.warning(self, "알림", "먼저 비밀번호를 설정해주세요.")
            return

        # DB에서 가져온 hashed_pw가 bytes일 경우 decode, 아니면 그대로 사용
        stored_hash = hashed_pw.decode() if isinstance(hashed_pw, bytes) else hashed_pw
        
        if self.sec.verify_password(stored_hash, password):
            self.sec.derive_key(password, salt)
            self.enter_vault()
        else:
            QMessageBox.critical(self, "인증 실패", "마스터 패스워드가 틀렸습니다.")

    def handle_setup_password(self):
        """비밀번호 설정 및 변경 (데이터 초기화)"""
        password = self.pw_input.text()
        if not password:
            QMessageBox.warning(self, "오류", "설정할 비밀번호를 입력창에 먼저 입력하세요.")
            return

        reply = QMessageBox.question(self, "비밀번호 설정", 
                                    "새로운 마스터 비밀번호를 설정합니다.\n이 작업 시 기존의 모든 저장 데이터는 삭제됩니다. 계속하시겠습니까?")
        
        if reply == QMessageBox.StandardButton.Yes:
            # 1. 데이터 초기화 (설정된 iCloud/로컬 경로의 DB 사용)
            with sqlite3.connect(self.db.db_path) as conn:
                conn.execute("DELETE FROM vault")
                conn.commit()
            
            # 2. 새로운 보안 설정 저장
            new_salt = self.sec.generate_salt()
            new_hash = self.sec.hash_password(password) # .encode() 제거: 문자열 그대로 저장
            
            self.db.set_config("master_salt", new_salt)
            self.db.set_config("master_hash", new_hash)
            
            # 3. 현재 세션 키 유도
            self.sec.derive_key(password, new_salt)
            
            QMessageBox.information(self, "완료", "비밀번호가 설정되었습니다. 금고가 초기화되었습니다.")
            self.enter_vault()

    def enter_vault(self):
        """인증 성공 후 메인 금고 화면으로 전환"""
        self.central_widget = QWidget()
        self.setCentralWidget(self.central_widget)
        main_layout = QHBoxLayout(self.central_widget)
        
        # --- 사이드바 ---
        sidebar = QFrame()
        sidebar.setFixedWidth(200)
        sidebar.setStyleSheet(f"background-color: #181818; border-right: 1px solid #333;")
        side_layout = QVBoxLayout(sidebar)
        
        add_btn = QPushButton("+ 항목 추가")
        add_btn.clicked.connect(self.show_add_dialog)
        
        gen_btn = QPushButton("비밀번호 생성기")
        gen_btn.clicked.connect(self.generate_random_pw)
        
        lock_btn = QPushButton("금고 잠그기")
        lock_btn.clicked.connect(self.init_auth_ui) # 단순 재시작
        
        side_layout.addWidget(add_btn)
        side_layout.addWidget(gen_btn)
        side_layout.addStretch()
        side_layout.addWidget(lock_btn)
        
        # --- 메인 리스트 ---
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["서비스", "사용자", "비밀번호", "작업"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        
        main_layout.addWidget(sidebar)
        main_layout.addWidget(self.table)
        
        self.refresh_vault()

    def refresh_vault(self):
        self.table.setRowCount(0)
        entries = self.db.get_all_passwords()
        for row_idx, (entry_id, service, username, enc_pw) in enumerate(entries):
            self.table.insertRow(row_idx)
            
            try:
                dec_pw = self.sec.decrypt(enc_pw)
            except:
                dec_pw = "복호화 오류"
                
            self.table.setItem(row_idx, 0, QTableWidgetItem(service))
            self.table.setItem(row_idx, 1, QTableWidgetItem(username))
            
            # 비밀번호 셀
            pw_item = QTableWidgetItem("••••••••")
            pw_item.setData(Qt.ItemDataRole.UserRole, dec_pw)
            self.table.setItem(row_idx, 2, pw_item)
            
            # 작업 영역 (보기 버튼 + 삭제 버튼)
            action_widget = QWidget()
            action_layout = QHBoxLayout(action_widget)
            action_layout.setContentsMargins(0, 0, 0, 0)
            action_layout.setSpacing(5)
            
            view_btn = QPushButton("보기")
            view_btn.setFixedWidth(50)
            view_btn.clicked.connect(lambda checked, r=row_idx: self.toggle_password_visibility(r))
            
            del_btn = QPushButton("삭제")
            del_btn.setFixedWidth(50)
            del_btn.clicked.connect(lambda checked, eid=entry_id: self.delete_entry(eid))
            
            action_layout.addWidget(view_btn)
            action_layout.addWidget(del_btn)
            self.table.setCellWidget(row_idx, 3, action_widget)

    def toggle_password_visibility(self, row):
        item = self.table.item(row, 2)
        real_pw = item.data(Qt.ItemDataRole.UserRole)
        
        if item.text() == "••••••••":
            item.setText(real_pw)
        else:
            item.setText("••••••••")

    def show_add_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("새 항목 추가")
        dialog.setFixedWidth(300)
        dialog.setStyleSheet(DarkStyle.SHEET)
        
        layout = QVBoxLayout(dialog)
        
        service_in = QLineEdit(); service_in.setPlaceholderText("서비스 (예: Google)")
        user_in = QLineEdit(); user_in.setPlaceholderText("사용자 ID")
        pw_in = QLineEdit(); pw_in.setPlaceholderText("비밀번호")
        pw_in.setEchoMode(QLineEdit.EchoMode.Password)
        
        save_btn = QPushButton("저장")
        def save():
            if service_in.text() and pw_in.text():
                enc_pw = self.sec.encrypt(pw_in.text())
                self.db.add_password(service_in.text(), user_in.text(), enc_pw)
                self.refresh_vault()
                dialog.accept()
        
        save_btn.clicked.connect(save)
        
        layout.addWidget(QLabel("서비스"))
        layout.addWidget(service_in)
        layout.addWidget(QLabel("사용자 ID"))
        layout.addWidget(user_in)
        layout.addWidget(QLabel("비밀번호"))
        layout.addWidget(pw_in)
        layout.addWidget(save_btn)
        
        dialog.exec()

    def generate_random_pw(self):
        chars = string.ascii_letters + string.digits + "!@#$%^&*()"
        pw = ''.join(random.choice(chars) for _ in range(16))
        QMessageBox.information(self, "생성된 비밀번호", f"추천 비밀번호:\n\n{pw}\n\n복사하여 사용하세요.")

    def delete_entry(self, entry_id):
        self.db.delete_password(entry_id)
        self.refresh_vault()

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = PasswordManagerApp()
    window.show()
    sys.exit(app.exec())