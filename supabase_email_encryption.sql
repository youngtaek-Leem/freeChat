-- ============================================================
-- STEP 1: 현재 profiles 테이블 email 컬럼 확인
-- 이것만 먼저 실행해서 email 컬럼이 있는지 확인하세요
-- ============================================================
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'email';


-- ============================================================
-- STEP 2: email 컬럼 삭제
-- STEP 1에서 email 컬럼이 확인된 후 아래를 실행하세요
-- (앱 코드는 이미 profiles에서 email을 조회하지 않도록 수정됨)
-- ============================================================
ALTER TABLE profiles DROP COLUMN IF EXISTS email;


-- ============================================================
-- STEP 3: RLS 활성화 및 정책 설정 (아직 없는 경우)
-- ============================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_profile" ON profiles;

CREATE POLICY "users_own_profile"
  ON profiles FOR ALL
  USING (auth.uid() = id);


-- ============================================================
-- STEP 4: 삭제 확인
-- ============================================================
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'profiles'
ORDER BY ordinal_position;
