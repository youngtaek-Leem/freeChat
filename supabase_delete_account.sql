-- Supabase SQL Editor에서 실행하세요
-- 계정 삭제 함수: 호출한 유저의 모든 데이터를 삭제합니다

CREATE OR REPLACE FUNCTION delete_user_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  -- 1. Storage 파일 삭제 (이 유저가 참여한 모든 채팅방의 이미지/파일)
  --    roomId 형식: {userId1}_{userId2} → 경로에 uid가 포함됨
  DELETE FROM storage.objects
  WHERE bucket_id = 'chat-images'
  AND name LIKE '%' || uid::text || '%';

  -- 2. 친구 관계 삭제 (상대방 목록에서도 제거됨)
  DELETE FROM connections
  WHERE requester_id = uid OR receiver_id = uid;

  -- 3. 미전달 메시지 삭제
  DELETE FROM pending_messages
  WHERE sender_id = uid OR receiver_id = uid;

  -- 4. 프로필 삭제
  DELETE FROM profiles
  WHERE id = uid;

  -- 5. 인증 계정 삭제
  DELETE FROM auth.users
  WHERE id = uid;
END;
$$;

-- 일반 유저가 이 함수를 호출할 수 있도록 권한 부여
GRANT EXECUTE ON FUNCTION delete_user_account() TO authenticated;
