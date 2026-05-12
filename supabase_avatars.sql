-- Run in Supabase SQL Editor
-- Creates a public 'avatars' bucket with RLS

-- 1. Create public bucket (if not already created via dashboard)
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 2. Allow authenticated users to upload/update their own avatar
DROP POLICY IF EXISTS "Users can upload own avatar" ON storage.objects;
CREATE POLICY "Users can upload own avatar"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND name = auth.uid()::text || '.jpg'
);

DROP POLICY IF EXISTS "Users can update own avatar" ON storage.objects;
CREATE POLICY "Users can update own avatar"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars'
  AND name = auth.uid()::text || '.jpg'
);

DROP POLICY IF EXISTS "Users can delete own avatar" ON storage.objects;
CREATE POLICY "Users can delete own avatar"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars'
  AND name = auth.uid()::text || '.jpg'
);

-- 3. Public read (bucket is public, so this is the storage-level policy)
DROP POLICY IF EXISTS "Anyone can read avatars" ON storage.objects;
CREATE POLICY "Anyone can read avatars"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'avatars');
