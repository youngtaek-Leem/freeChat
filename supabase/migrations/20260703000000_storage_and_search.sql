-- =====================================================================
-- freeChat 2차 마이그레이션 (2026-07-03)
-- 적용 방법: 20260702000000_scale_hardening.sql 실행 후 이 파일 실행
--
--  1) 프로필 검색 pg_trgm 인덱스 — ilike '%검색어%' 풀스캔 제거
--  2) chat-images Storage 정책 — 방 참가자만 접근 가능
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 검색 인덱스 (Discovery 의 username/keywords/bio ilike 검색용)
-- ---------------------------------------------------------------------
create extension if not exists pg_trgm;

create index if not exists idx_profiles_username_trgm
  on public.profiles using gin (username gin_trgm_ops);
create index if not exists idx_profiles_keywords_trgm
  on public.profiles using gin (keywords gin_trgm_ops);
create index if not exists idx_profiles_bio_trgm
  on public.profiles using gin (bio gin_trgm_ops);

-- ---------------------------------------------------------------------
-- 2. Storage 정책 — chat-images 버킷
--    경로 규칙: "{roomId}/..." 또는 "files/{roomId}/..."
--    roomId = "{uid1}_{uid2}" 이므로 경로에 본인 uid 가 포함된 경우에만
--    업로드/열람(signed URL 발급)/삭제를 허용한다.
--    AI 에이전트(agent_bridge)는 service_role 키라 정책을 우회한다.
--
--    ⚠️ Dashboard > Storage > Policies 에 기존의 더 넓은 정책
--       (예: authenticated 전체 허용)이 있으면 그 정책이 우선 적용되므로
--       함께 삭제해야 이 제한이 실효성을 가진다.
-- ---------------------------------------------------------------------
drop policy if exists "chat-images participants insert" on storage.objects;
create policy "chat-images participants insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-images'
    and position(auth.uid()::text in name) > 0
  );

drop policy if exists "chat-images participants select" on storage.objects;
create policy "chat-images participants select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-images'
    and position(auth.uid()::text in name) > 0
  );

drop policy if exists "chat-images participants delete" on storage.objects;
create policy "chat-images participants delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-images'
    and position(auth.uid()::text in name) > 0
  );
