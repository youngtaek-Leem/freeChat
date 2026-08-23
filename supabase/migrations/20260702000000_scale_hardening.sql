-- =====================================================================
-- freeChat 대규모 동접 대응 마이그레이션 (2026-07-02)
--
-- 적용 방법: Supabase Dashboard > SQL Editor 에서 전체 실행
--
-- ⚠️ 반드시 새 프론트엔드 배포와 같은 시점에 적용할 것.
--    이 마이그레이션은 클라이언트의 broadcast 직접 전송을 차단하므로
--    (realtime.messages RLS), 구버전 프론트의 "실시간" 전달이 멈춘다.
--    구버전 클라이언트도 메시지 자체는 pending_messages 경유로
--    다음 로그인 sync 때 정상 수신한다 (유실 없음, 지연만 발생).
--
-- 새 아키텍처:
--    보내기 = pending_messages INSERT 한 번 (sig 컬럼 포함)
--    전달   = AFTER INSERT 트리거가 realtime.send() 로
--             수신자의 private 채널 user:{receiver_id} 에 broadcast
--    수신자 = 자기 채널 하나만 구독, 처리 완료 후 row 삭제
--    오프라인 = row 가 남아 있다가 다음 로그인 sync 때 전달
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 컬럼 추가
--    sig   : E2E HMAC 서명 (기존에는 broadcast payload 에만 실려서
--            오프라인 경유 메시지는 서명 검증이 불가능했음)
--    event : row 종류 — message | delete_message | clear_chat | read_receipt
-- ---------------------------------------------------------------------
alter table public.pending_messages add column if not exists sig text;
alter table public.pending_messages add column if not exists event text not null default 'message';

-- ---------------------------------------------------------------------
-- 2. 인덱스 (조회 패턴: 수신자 sync / AI 방 폴링 / message_id 회수)
-- ---------------------------------------------------------------------
create index if not exists idx_pending_receiver_created
  on public.pending_messages (receiver_id, created_at);
create index if not exists idx_pending_room_id
  on public.pending_messages (room_id);
create index if not exists idx_pending_message_id
  on public.pending_messages (message_id);

-- ---------------------------------------------------------------------
-- 3. RLS — 발신자 위장 금지, 수신자 본인만 열람
--    (agent_bridge / agent_server 는 service_role 키라 RLS 를 우회함)
-- ---------------------------------------------------------------------
alter table public.pending_messages enable row level security;

drop policy if exists "sender inserts own rows" on public.pending_messages;
create policy "sender inserts own rows" on public.pending_messages
  for insert to authenticated
  with check (sender_id = auth.uid());

drop policy if exists "receiver reads own rows" on public.pending_messages;
create policy "receiver reads own rows" on public.pending_messages
  for select to authenticated
  using (receiver_id = auth.uid());

-- 수신자: 처리 완료 후 삭제 / 발신자: 미전달 메시지 회수(삭제 지시 등)
drop policy if exists "participants delete rows" on public.pending_messages;
create policy "participants delete rows" on public.pending_messages
  for delete to authenticated
  using (receiver_id = auth.uid() or sender_id = auth.uid());

-- update 정책 없음: 대기 메시지는 수정 불가

-- ---------------------------------------------------------------------
-- 4. INSERT → 수신자 개인 채널 broadcast 트리거 (전달 경로 단일화)
--    payload 키는 클라이언트(ChatContext.processRow)와 일치해야 한다.
-- ---------------------------------------------------------------------
create or replace function public.broadcast_pending_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform realtime.send(
    jsonb_build_object(
      'id',            new.id,
      'sender',        new.sender_id,
      'roomId',        new.room_id,
      'messageId',     new.message_id,
      'timestamp',     new."timestamp",
      'encryptedText', new.encrypted_payload,
      'sig',           new.sig
    ),
    coalesce(new.event, 'message'),
    'user:' || new.receiver_id::text,
    true  -- private channel
  );
  return new;
exception when others then
  -- broadcast 실패해도 insert 는 유지 (다음 로그인 sync 가 전달)
  return new;
end;
$$;

drop trigger if exists trg_broadcast_pending on public.pending_messages;
create trigger trg_broadcast_pending
  after insert on public.pending_messages
  for each row execute function public.broadcast_pending_message();

-- ---------------------------------------------------------------------
-- 5. Realtime Authorization — private 채널 수신 권한
--    본인의 user:{uid} 채널만 구독 가능. 클라이언트의 broadcast "전송"
--    정책은 만들지 않음 → 전송은 위 DB 트리거(realtime.send)로만 가능.
--    (임의 채널 도청·스팸·메타데이터 수집 차단)
-- ---------------------------------------------------------------------
drop policy if exists "users receive own channel" on realtime.messages;
create policy "users receive own channel" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() = 'user:' || (select auth.uid())::text
  );

-- ---------------------------------------------------------------------
-- 6. TTL — 30일 이상 미전달 row 자동 정리 (매일 04:00 UTC)
--    pg_cron 이 비활성화된 프로젝트면 NOTICE 만 출력하고 넘어감.
--    그 경우 Dashboard > Database > Extensions 에서 pg_cron 활성화 후
--    이 블록만 다시 실행할 것.
-- ---------------------------------------------------------------------
do $do$
begin
  create extension if not exists pg_cron;
  perform cron.schedule(
    'purge-stale-pending-messages',
    '0 4 * * *',
    $cmd$ delete from public.pending_messages where created_at < now() - interval '30 days' $cmd$
  );
exception when others then
  raise notice 'pg_cron 스케줄 등록 실패 — Extensions 에서 pg_cron 활성화 후 이 블록을 재실행하세요: %', sqlerrm;
end
$do$;

-- ---------------------------------------------------------------------
-- (참고) Storage 정책 — chat-images 버킷
-- 현재 버킷 정책은 대시보드에서 관리 중이라 여기서 강제하지 않는다.
-- 최소한 아래 수준으로 잠글 것을 권장 (경로 첫 세그먼트 = roomId 에
-- 본인 uid 가 포함된 경우에만 접근 허용):
--
-- create policy "participants only" on storage.objects
--   for all to authenticated
--   using (
--     bucket_id = 'chat-images'
--     and position(auth.uid()::text in (storage.foldername(name))[1]) > 0
--   );
-- ---------------------------------------------------------------------
