import os
from argon2 import PasswordHasher
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend

class SecurityManager:
    """
    Zero-Knowledge 보안 관리자.
    마스터 패스워드를 이용해 AES-256 GCM 키를 생성하고 데이터를 암호화합니다.
    """
    def __init__(self):
        self.key = None
        self.ph = PasswordHasher()

    def hash_password(self, password: str) -> str:
        """비밀번호 검증을 위한 해시 생성 (Argon2 ID hash string 반환)"""
        return self.ph.hash(password)

    def verify_password(self, hashed, password: str) -> bool:
        """해시와 입력 비밀번호 비교"""
        try:
            return self.ph.verify(hashed, password)
        except Exception:
            return False

    def derive_key(self, master_password: str, salt: bytes):
        """마스터 패스워드와 솔트를 이용해 32바이트 암호화 키 유도"""
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
            backend=default_backend()
        )
        self.key = kdf.derive(master_password.encode())
        return self.key

    def encrypt(self, data: str) -> bytes:
        """데이터 암호화 (AES-256 GCM)"""
        if not self.key:
            raise ValueError("먼저 마스터 패스워드로 키를 유도해야 합니다.")
        
        aesgcm = AESGCM(self.key)
        nonce = os.urandom(12)
        ciphertext = aesgcm.encrypt(nonce, data.encode(), None)
        # nonce + ciphertext 형태로 저장하여 복호화 시 사용
        return nonce + ciphertext

    def decrypt(self, encrypted_data: bytes) -> str:
        """데이터 복호화"""
        if not self.key:
            raise ValueError("먼저 마스터 패스워드로 키를 유도해야 합니다.")
        
        nonce = encrypted_data[:12]
        ciphertext = encrypted_data[12:]
        aesgcm = AESGCM(self.key)
        
        try:
            decrypted = aesgcm.decrypt(nonce, ciphertext, None)
            return decrypted.decode()
        except Exception:
            raise ValueError("복호화 실패: 마스터 패스워드가 틀렸거나 데이터가 손상되었습니다.")

    @staticmethod
    def generate_salt() -> bytes:
        return os.urandom(16)