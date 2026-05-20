"""
Agent Bridge — Supabase ↔ agent_server relay
Polls pending_messages for AI Friend, relays to agent_server via WebSocket, posts response back.
"""
import asyncio
import json
import os
import ssl
import uuid
from datetime import datetime, timezone

import httpx
import websockets

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://cqhxbsyamdmdraiueaht.supabase.co")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
AI_AGENT_ID = "a04fce0a-02f8-4040-962a-22d7d98851f0"
AI_PREFIX = "_ai_:"
AGENT_WS = os.environ.get("AGENT_WS", "wss://localhost:3001/ws")

_room_ws: dict = {}


def _ssl_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _get_ws(room_id: str):
    ws = _room_ws.get(room_id)
    if ws:
        try:
            await asyncio.wait_for(ws.ping(), timeout=2)
            return ws
        except Exception:
            _room_ws.pop(room_id, None)
    ws = await websockets.connect(AGENT_WS, ssl=_ssl_ctx())
    _room_ws[room_id] = ws
    return ws


async def ask_agent(room_id: str, text: str) -> str:
    try:
        ws = await _get_ws(room_id)
        await ws.send(json.dumps({"type": "message", "content": text}))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=180)
            msg = json.loads(raw)
            if msg.get("type") == "message":
                return msg.get("content", "")
            if msg.get("type") == "error":
                return "오류가 발생했습니다."
    except Exception as e:
        _room_ws.pop(room_id, None)
        return f"Agent 연결 오류: {e}"


async def supabase_get(path: str, params: dict) -> list:
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{SUPABASE_URL}/rest/v1/{path}",
            params=params,
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            },
        )
        return r.json() if r.status_code == 200 else []


async def supabase_post(path: str, data: dict):
    async with httpx.AsyncClient() as c:
        await c.post(
            f"{SUPABASE_URL}/rest/v1/{path}",
            json=data,
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
        )


async def supabase_delete_ids(path: str, ids: list):
    id_list = ",".join(ids)
    async with httpx.AsyncClient() as c:
        await c.delete(
            f"{SUPABASE_URL}/rest/v1/{path}",
            params={"id": f"in.({id_list})"},
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            },
        )


async def poll_loop():
    print("[bridge] 시작됨. AI Friend 메시지 폴링 중...")
    while True:
        try:
            rows = await supabase_get("pending_messages", {
                "receiver_id": f"eq.{AI_AGENT_ID}",
                "select": "*",
                "order": "created_at.asc",
            })
            for row in rows:
                payload = row.get("encrypted_payload", "")
                text = payload[len(AI_PREFIX):] if payload.startswith(AI_PREFIX) else payload
                room_id = row["room_id"]
                user_id = row["sender_id"]

                print(f"[bridge] '{text[:60]}' → agent 처리 중...")
                await supabase_delete_ids("pending_messages", [row["id"]])

                response = await ask_agent(room_id, text)

                await supabase_post("pending_messages", {
                    "sender_id": AI_AGENT_ID,
                    "receiver_id": user_id,
                    "room_id": room_id,
                    "encrypted_payload": f"{AI_PREFIX}{response}",
                    "message_id": str(uuid.uuid4()),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                print(f"[bridge] 응답 전송 완료 ({len(response)}자)")

        except Exception as e:
            print(f"[bridge] 오류: {e}")

        await asyncio.sleep(2)


if __name__ == "__main__":
    if not SUPABASE_SERVICE_KEY:
        print("⚠️  SUPABASE_SERVICE_KEY 환경변수가 필요합니다.")
        print("   Supabase 대시보드 > Settings > API > service_role 키를 복사하세요.")
        print("   export SUPABASE_SERVICE_KEY=your_key_here")
        raise SystemExit(1)
    asyncio.run(poll_loop())
