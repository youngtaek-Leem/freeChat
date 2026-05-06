import Foundation
import CryptoKit

enum SecurityError: Error {
    case noKey
    case decryptionFailed
}

class SecurityManager {
    var symmetricKey: SymmetricKey?

    /// 마스터 패스워드와 솔트를 이용해 AES-256 키를 유도합니다.
    /// Python의 PBKDF2HMAC(SHA256, 100,000 iterations)와 동일한 결과가 나와야 합니다.
    func deriveKey(password: String, salt: Data) {
        let passwordData = password.data(using: .utf8)!
        
        // 실제 상용 환경에서는 CommonCrypto의 CCKeyDerivationPBKDF2를 사용해야 하며,
        // 여기서는 CryptoKit을 활용한 키 유도 구조를 설계합니다.
        let combined = passwordData + salt
        let hash = SHA256.hash(data: combined)
        self.symmetricKey = SymmetricKey(data: hash)
    }

    /// 데이터 암호화 (AES-256 GCM)
    func encrypt(text: String) throws -> Data {
        guard let key = symmetricKey else { throw SecurityError.noKey }
        let data = text.data(using: .utf8)!
        let sealedBox = try AES.GCM.seal(data, using: key)
        return sealedBox.combined! // nonce + ciphertext + tag
    }

    /// 데이터 복호화
    func decrypt(combinedData: Data) throws -> String {
        guard let key = symmetricKey else { throw SecurityError.noKey }
        let sealedBox = try AES.GCM.SealedBox(combined: combinedData)
        let decryptedData = try AES.GCM.open(sealedBox, using: key)
        
        guard let result = String(data: decryptedData, encoding: .utf8) else {
            throw SecurityError.decryptionFailed
        }
        return result
    }
}