import Foundation
import SQLite // SQLite.swift 라이브러리 필요

class DatabaseManager {
    var db: Connection?
    
    /// iCloud Drive 경로에서 vault.db 파일을 연결합니다.
    func connectToiCloudDB() {
        let fileManager = FileManager.default
        if let icloudURL = fileManager.url(for: .cloudDocumentsFolder, in: .cloudStorageDirectory, appropriateFor: nil) {
            let vaultFolder = icloudURL.appendingPathComponent("ConnectVault")
            
            // 폴더가 없으면 생성
            if !fileManager.fileExists(atPath: vaultFolder.path) {
                try? fileManager.createDirectory(at: vaultFolder, withIntermediateDirectories: true)
            }
            
            let dbURL = vaultFolder.appendingPathComponent("vault.db")
            
            do {
                self.db = try Connection(dbURL.path)
                print("Connected to iCloud Vault DB: \(dbURL.path)")
            } catch {
                print("DB Connection Error: \(error)")
            }
        }
    }
    
    /// 모든 패스워드 항목을 가져옵니다.
    func getAllPasswords() -> [PasswordEntry] {
        var results: [PasswordEntry] = []
        guard let db = db else { return results }
        
        let vault = Table("vault")
        let id = Expression<Int64>("id")
        let service = Expression<String>("service")
        let username = Expression<String>("username")
        let encryptedPw = Expression<Data>("encrypted_password")
        
        do {
            for row in try db.prepare(vault) {
                results.append(PasswordEntry(
                    id: Int(row[id]),
                    service: row[service],
                    username: row[username],
                    encryptedPw: row[encryptedPw]
                ))
            }
        } catch {
            print("Fetch Error: \(error)")
        }
        return results
    }
    
    /// 마스터 솔트 및 해시 가져오기
    func getConfig(key: String) -> Data? {
        guard let db = db else { return nil }
        let config = Table("config")
        let keyCol = Expression<String>("key")
        let valueCol = Expression<Data>("value")
        
        do {
            if let row = try db.pluck(config.filter(keyCol == key)) {
                return row[valueCol]
            }
        } catch {
            print("Config Fetch Error: \(error)")
        }
        return nil
    }
}

struct PasswordEntry: Identifiable {
    let id: Int
    let service: String
    let username: String
    let encryptedPw: Data
}