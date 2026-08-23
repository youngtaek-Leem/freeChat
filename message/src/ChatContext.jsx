import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { supabase } from './supabaseClient';
import { cryptoUtils } from './utils/crypto';
import { dbUtils } from './utils/db';

const ChatContext = createContext();

const AI_PREFIX = '_ai_:';
const AI_STATUS_PREFIX = '_ai_status_:';

export const ChatProvider = ({ children }) => {
  const [unreadCounts, setUnreadCounts] = useState({});
  const [session, setSession] = useState(null);
  const activeRoomRef = useRef(null);
  const roomHandlerRef = useRef(null); // 활성 방(ChatRoom)이 등록한 이벤트 핸들러
  const privateKeyRef = useRef(null);
  const publicKeyCacheRef = useRef(new Map()); // userId → CryptoKey (public)
  const roomKeysCacheRef = useRef(new Map()); // roomId → { encKey, sigKey }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;

    const myId = session.user.id;
    let channel = null;
    let cancelled = false;

    // ── helpers ──────────────────────────────────────────────────────────────

    const getPublicKey = async (userId) => {
      if (publicKeyCacheRef.current.has(userId)) return publicKeyCacheRef.current.get(userId);
      const { data } = await supabase
        .from('profiles').select('public_key').eq('id', userId).single();
      if (!data?.public_key) return null;
      try {
        const key = await cryptoUtils.importPublicKey(data.public_key);
        publicKeyCacheRef.current.set(userId, key);
        return key;
      } catch { return null; }
    };

    const getKeysForRoom = async (roomId) => {
      if (roomKeysCacheRef.current.has(roomId)) return roomKeysCacheRef.current.get(roomId);
      if (!privateKeyRef.current) return null;
      const friendId = roomId.split('_').find(id => id !== myId);
      if (!friendId) return null;
      const friendPubKey = await getPublicKey(friendId);
      if (!friendPubKey) return null;
      const keys = await cryptoUtils.deriveRoomKeys(privateKeyRef.current, friendPubKey);
      roomKeysCacheRef.current.set(roomId, keys);
      return keys;
    };

    const forwardToRoom = (roomId, evt) => {
      if (activeRoomRef.current === roomId && roomHandlerRef.current) {
        roomHandlerRef.current(evt);
      }
    };

    // ── 단일 수신 경로 ────────────────────────────────────────────────────────
    // realtime broadcast(DB 트리거 발신)와 오프라인 sync 가 같은 row 를
    // 동일하게 처리한다. 반환값 true → pending row 삭제 가능.
    const processRow = async ({ eventName, sender, roomId, messageId, timestamp, encryptedText, sig }) => {
      if (!sender || !roomId) return true;
      // 발신자는 방의 상대 참가자여야 함 (RLS 가 sender_id 위조를 막으므로 이 검사로 인증됨)
      if (sender !== roomId.split('_').find(id => id !== myId)) return true;

      if (eventName === 'read_receipt') {
        await dbUtils.markMyMessagesAsRecipientRead(roomId, myId);
        forwardToRoom(roomId, { type: 'read' });
        return true;
      }

      if (eventName === 'message') {
        // AI 방 메시지 — 평문 (AI 채팅은 암호화 대상 아님)
        if (encryptedText?.startsWith(AI_STATUS_PREFIX)) {
          // 진행 상태 버블: 화면 표시용 임시 메시지, 저장하지 않음
          forwardToRoom(roomId, {
            type: 'ai_status',
            message: {
              messageId, roomId, sender,
              text: encryptedText.slice(AI_STATUS_PREFIX.length),
              timestamp, read: true, isStatus: true,
            },
          });
          return true;
        }
        if (encryptedText?.startsWith(AI_PREFIX)) {
          const isActive = activeRoomRef.current === roomId;
          const msg = {
            messageId, roomId, sender,
            text: encryptedText.slice(AI_PREFIX.length),
            timestamp, read: isActive,
          };
          await dbUtils.saveMessage(msg);
          if (isActive) forwardToRoom(roomId, { type: 'ai_message', message: msg });
          else setUnreadCounts(await dbUtils.getUnreadCounts());
          return true;
        }

        const keys = await getKeysForRoom(roomId);
        if (!keys) return false; // 키 미확보 → row 보존, 다음 sync 때 재시도
        // sig 없는 row 는 구버전 클라이언트 발신 — 과도기 허용
        if (sig && !await cryptoUtils.verify(keys.sigKey, { sender, roomId, messageId, encryptedText }, sig)) return true;
        const text = await cryptoUtils.decrypt(encryptedText, keys.encKey);
        const isActive = activeRoomRef.current === roomId;
        const msg = { messageId, roomId, sender, text, timestamp, read: isActive, recipientRead: false };
        await dbUtils.saveMessage(msg);
        if (isActive) forwardToRoom(roomId, { type: 'message', message: msg });
        else setUnreadCounts(await dbUtils.getUnreadCounts());
        return true;
      }

      if (eventName === 'delete_message') {
        const keys = await getKeysForRoom(roomId);
        if (!keys) return false;
        if (!sig || !await cryptoUtils.verify(keys.sigKey, { sender, roomId, messageId }, sig)) return true;
        await dbUtils.deleteMessage(messageId);
        forwardToRoom(roomId, { type: 'delete', messageId });
        setUnreadCounts(await dbUtils.getUnreadCounts());
        return true;
      }

      if (eventName === 'clear_chat') {
        const keys = await getKeysForRoom(roomId);
        if (!keys) return false;
        if (!sig || !await cryptoUtils.verify(keys.sigKey, { sender, roomId }, sig)) return true;
        await dbUtils.clearRoomMessages(roomId);
        forwardToRoom(roomId, { type: 'clear' });
        setUnreadCounts(await dbUtils.getUnreadCounts());
        return true;
      }

      return true; // 알 수 없는 이벤트 → 폐기
    };

    // ── main init ────────────────────────────────────────────────────────────

    const run = async () => {
      // 1. Init ECDH key pair
      let privateKey = await dbUtils.getSecret('ecdh_private_key');
      if (!privateKey) {
        const keyPair = await cryptoUtils.generateKeyPair();
        privateKey = keyPair.privateKey;
        const jwk = await cryptoUtils.exportPublicKey(keyPair.publicKey);
        await dbUtils.saveSecret('ecdh_private_key', privateKey);
        await dbUtils.saveSecret('ecdh_public_key_jwk', jwk);
        const { error } = await supabase.from('profiles').upsert({ id: myId, public_key: jwk });
        if (error) console.warn('[Auth] public_key upload failed — run SQL migration:', error.message);
      } else {
        // Re-upload on every login to keep Supabase in sync
        const jwk = await dbUtils.getSecret('ecdh_public_key_jwk');
        if (jwk) await supabase.from('profiles').upsert({ id: myId, public_key: jwk });
      }
      if (cancelled) return;
      privateKeyRef.current = privateKey;

      // 2. 밀린 pending row 동기화 (메시지 + 삭제/전체삭제/읽음확인 지시)
      //    최초 구독 시 + 재연결(SUBSCRIBED)마다 실행 — 소켓이 끊긴 사이
      //    (모바일 백그라운드 전환 등) 놓친 메시지를 즉시 회수한다.
      let syncing = false;
      const syncPending = async () => {
        if (syncing || cancelled) return;
        syncing = true;
        try {
          const { data, error } = await supabase
            .from('pending_messages').select('*')
            .eq('receiver_id', myId)
            .order('created_at', { ascending: true });
          if (!error && data?.length > 0) {
            const toDelete = [];
            for (const row of data) {
              try {
                const done = await processRow({
                  eventName: row.event || 'message',
                  sender: row.sender_id,
                  roomId: row.room_id,
                  messageId: row.message_id,
                  timestamp: row.timestamp,
                  encryptedText: row.encrypted_payload,
                  sig: row.sig,
                });
                if (done) toDelete.push(row.id);
              } catch (e) {
                // 키 불일치로 복호화 불가 → 더 이상 재시도 불필요, 삭제
                console.error('Failed to sync message (key mismatch, removing):', e);
                toDelete.push(row.id);
              }
            }
            if (toDelete.length > 0) {
              await supabase.from('pending_messages').delete().in('id', toDelete);
            }
            if (!cancelled) setUnreadCounts(await dbUtils.getUnreadCounts());
          }
        } catch (e) {
          console.error('Offline sync failed:', e);
        } finally {
          syncing = false;
        }
      };

      // 3. 개인 private 채널 구독 — broadcast 발신은 DB 트리거(realtime.send)만
      //    가능하고 클라이언트는 수신 전용.
      await supabase.realtime.setAuth(session.access_token);
      channel = supabase.channel(`user:${myId}`, {
        config: { private: true, broadcast: { self: false } },
      });
      channel.on('broadcast', { event: '*' }, async ({ event, payload }) => {
        if (!payload?.id) return;
        try {
          const done = await processRow({ eventName: event, ...payload });
          if (done) await supabase.from('pending_messages').delete().eq('id', payload.id);
        } catch (e) {
          // 복호화 실패 등 — row 는 남겨두고 다음 sync 에서 최종 판정
          console.error('[ChatContext] Broadcast processing error:', e);
        }
      }).subscribe((status) => {
        if (status === 'SUBSCRIBED') syncPending();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[ChatContext] Realtime channel status:', status);
        }
      });

      if (cancelled) return;

      // 4. Load unread counts
      const counts = await dbUtils.getUnreadCounts();
      if (!cancelled) setUnreadCounts(counts);
    };

    run();

    return () => {
      cancelled = true;
      roomKeysCacheRef.current.clear();
      if (channel) supabase.removeChannel(channel);
    };
  }, [session]);

  const markAsRead = async (roomId) => {
    await dbUtils.markRoomAsRead(roomId);
    setUnreadCounts(prev => { const n = { ...prev }; delete n[roomId]; return n; });
  };

  const setActiveRoom = (roomId, handler = null) => {
    activeRoomRef.current = roomId;
    roomHandlerRef.current = roomId ? handler : null;
    if (roomId) markAsRead(roomId);
  };

  return (
    <ChatContext.Provider value={{ unreadCounts, markAsRead, setActiveRoom }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => useContext(ChatContext);
