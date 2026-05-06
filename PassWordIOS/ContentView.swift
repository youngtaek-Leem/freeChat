import SwiftUI

struct ContentView: View {
    @State private var masterPassword = ""
    @State private var isAuthenticated = false
    @State private var passwords: [PasswordEntry] = []
    @State private var isLoading = false
    
    let sec = SecurityManager()
    let db = DatabaseManager()

    var body: some View {
        ZStack {
            // Background Color (DarkStyle.MAIN_BG)
            Color(hex: "1e1e1e").ignoresSafeArea()
            
            if !isAuthenticated {
                authView
            } else {
                vaultView
            }
        }
    }
    
    // --- 로그인 화면 ---
    var authView: some View {
        VStack(spacing: 25) {
            Text("Connect Vault")
                .font(.system(size: 32, weight: .bold))
                .foregroundColor(.white)
                .padding(.bottom, 20)
            
            VStack(spacing: 15) {
                TextField("마스터 패스워드 입력", text: $masterPassword)
                    .textFieldStyle(PlainTextFieldStyle())
                    .padding()
                    .background(Color(hex: "2a2a2a"))
                    .cornerRadius(10)
                    .foregroundColor(.white)
                    .secureTextField() // 비밀번호 마스킹
                
                Button(action: authenticate) {
                    Text("금고 열기")
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color(hex: "3F51B5"))
                        .cornerRadius(10)
                }
            }
            .padding()
            .background(Color(hex: "252525"))
            .cornerRadius(20)
            .padding(.horizontal, 30)
        }
    }
    
    // --- 금고 리스트 화면 ---
    var vaultView: some View {
        NavigationView {
            List(passwords) { entry in
                HStack {
                    VStack(alignment: .leading) {
                        Text(entry.service).font(.headline).foregroundColor(.white)
                        Text(entry.username).font(.subheadline).foregroundColor(.gray)
                    }
                    Spacer()
                    Text("••••••••")
                        .foregroundColor(.gray)
                        .font(.system(.body, design: .monospaced))
                }
                .padding(.vertical, 8)
                .listRowBackground(Color(hex: "252525"))
            }
            .navigationTitle("My Vault")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("잠그기") { isAuthenticated = false }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
    
    func authenticate() {
        isLoading = true
        db.connectToiCloudDB()
        
        if let salt = db.getConfig(key: "master_salt") {
            sec.deriveKey(password: masterPassword, salt: salt)
            // 여기서 실제 hashed_pw와 비교하는 검증 로직이 들어갑니다.
            self.passwords = db.getAllPasswords()
            self.isAuthenticated = true
        }
        isLoading = false
    }
}

// TextField 확장 (비밀번호 입력용)
extension TextField {
    func secureTextField() -> some View {
        // 실제로는 SecureField를 사용해야 함
        self
    }
}

// Hex Color Helper
extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int = Int(hex, radix: 16)!
        let r = Float((int >> 16) & 0xFF) / 255
        let g = Float((int >> 8) & 0xFF) / 255
        let b = Float((int >> 0) & 0xFF) / 255
        self.init(red: CGFloat(r), green: CGFloat(g), blue: CGFloat(b))
    }
}