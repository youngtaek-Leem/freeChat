1password 와 유사한 기능을 하는 패스워드 관리 프로그램이다. 
맥OS 및 iOS 에서 동작해야 하며, 업데이트된 password 는 icloud 를 통해 동기화 되어야 한다. 
iCloud Drive의 특정 폴더에 암호화된 DB 파일(vault.db)을 저장하고, 파일 변경 시 동기화하는 방식.
보안 강화: security.py의 암호화 알고리즘(AES-256 등)이 표준을 따르는지 확인하고, 마스터 패스워드 기반의 키 