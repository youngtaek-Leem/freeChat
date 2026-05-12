-- Supabase SQL Editor에서 실행하세요

-- 1. chat-images 버킷 생성 (비공개)
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-images', 'chat-images', false)
ON CONFLICT (id) DO NOTHING;

-- 2. 인증된 유저: 업로드 허용
CREATE POLICY "auth_upload_chat_images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'chat-images');

-- 3. 인증된 유저: 읽기 허용 (signed URL 생성용)
CREATE POLICY "auth_read_chat_images"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'chat-images');

-- 4. 인증된 유저: 삭제 허용 (열람 후 서버에서 삭제)
CREATE POLICY "auth_delete_chat_images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'chat-images');
