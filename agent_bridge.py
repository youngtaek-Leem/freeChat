"""
Agent Bridge — Supabase ↔ agent_server relay
Polls pending_messages for AI Friend, relays to agent_server via WebSocket, posts response back.
Progress updates are sent as _ai_status_: prefixed messages.
"""
import asyncio
import base64
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
IMG_PREFIX = "_img_:"
FILE_PREFIX = "_file_:"
STATUS_PREFIX = "_ai_status_:"

_MIME_MAP = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "gif": "image/gif", "webp": "image/webp", "heic": "image/heic",
}

def _mime_from_path(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return _MIME_MAP.get(ext, "image/jpeg")

AGENT_WS = os.environ.get("AGENT_WS", "ws://localhost:3001/ws")

TOOL_ICONS = {
    "web_search": "🔍 웹 검색 중...",
    "fetch_webpage": "🌐 웹페이지 읽는 중...",
    "execute_shell": "💻 명령 실행 중...",
    "list_files": "📁 파일 목록 조회 중...",
    "read_file": "📄 파일 읽는 중...",
    "write_file": "✏️ 파일 쓰는 중...",
    "delete_file": "🗑️ 파일 삭제 중...",
    "copy_file": "📋 파일 복사 중...",
    "move_file": "📦 파일 이동 중...",
    "run_python": "🐍 Python 실행 중...",
    "browser_navigate": "🌐 브라우저 탐색 중...",
    "browser_click": "🖱️ 브라우저 클릭 중...",
    "browser_fill": "⌨️ 브라우저 입력 중...",
    "browser_get_text": "📝 텍스트 읽는 중...",
    "browser_screenshot": "📸 화면 캡처 중...",
    "take_screenshot": "📸 화면 캡처 중...",
    "open_url": "🔗 URL 여는 중...",
    "control_app": "🖥️ 앱 제어 중...",
    "find_app": "🔎 앱 찾는 중...",
}

_room_ws: dict = {}
_status_ids: dict = {}  # room_id -> status message_id


async def download_storage_file(file_path: str) -> dict | None:
    """Download a file from Supabase storage, return {data: base64, mime_type}."""
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{SUPABASE_URL}/storage/v1/object/chat-images/{file_path}",
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            },
        )
        if r.status_code == 200:
            return {"data": base64.b64encode(r.content).decode(), "mime_type": _mime_from_path(file_path)}
        return None


async def _get_ws(room_id: str):
    ws = _room_ws.get(room_id)
    if ws:
        try:
            await asyncio.wait_for(ws.ping(), timeout=2)
            return ws
        except Exception:
            _room_ws.pop(room_id, None)
    use_ssl = AGENT_WS.startswith("wss://")
    ssl_ctx = None
    if use_ssl:
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE
    ws = await websockets.connect(AGENT_WS, ssl=ssl_ctx)
    _room_ws[room_id] = ws
    return ws


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


async def supabase_delete_by_message_id(message_id: str):
    async with httpx.AsyncClient() as c:
        await c.delete(
            f"{SUPABASE_URL}/rest/v1/pending_messages",
            params={"message_id": f"eq.{message_id}"},
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            },
        )


async def send_status(room_id: str, user_id: str, text: str):
    """Insert/replace status bubble for this room."""
    if room_id not in _status_ids:
        _status_ids[room_id] = str(uuid.uuid4())
    mid = _status_ids[room_id]
    await supabase_delete_by_message_id(mid)
    await supabase_post("pending_messages", {
        "sender_id": AI_AGENT_ID,
        "receiver_id": user_id,
        "room_id": room_id,
        "encrypted_payload": f"{STATUS_PREFIX}{text}",
        "message_id": mid,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


async def clear_status(room_id: str):
    """Remove status bubble."""
    if room_id in _status_ids:
        await supabase_delete_by_message_id(_status_ids.pop(room_id))


async def ask_agent(room_id: str, user_id: str, text: str, images: list | None = None) -> str | None:
    try:
        ws = await _get_ws(room_id)
        msg = {"type": "message", "text": text}
        if images:
            msg["images"] = images
        await ws.send(json.dumps(msg))
        accumulated = ""
        await send_status(room_id, user_id, "🤔 요청 분석 중...")
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=180)
            msg = json.loads(raw)
            t = msg.get("type")
            if t == "text":
                accumulated += msg.get("text", "")
            elif t == "done":
                await clear_status(room_id)
                return accumulated or None
            elif t == "error":
                await clear_status(room_id)
                print(f"[bridge] agent 오류 응답: {msg}")
                return None
            elif t == "thinking":
                await send_status(room_id, user_id, "🤔 " + (msg.get("message") or "요청 분석 중..."))
            elif t == "tool_start":
                label = TOOL_ICONS.get(msg.get("name", ""), "⚙️ 처리 중...")
                await send_status(room_id, user_id, label)
            elif t == "progress":
                icon = msg.get("icon", "⚙️")
                message = msg.get("message", "처리 중...")
                await send_status(room_id, user_id, f"{icon} {message}")
    except Exception as e:
        await clear_status(room_id)
        print(f"[bridge] ask_agent 오류: {e}")
        _room_ws.pop(room_id, None)
        return None


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
                if not payload.startswith(AI_PREFIX):
                    await supabase_delete_ids("pending_messages", [row["id"]])
                    continue

                text = payload[len(AI_PREFIX):]
                room_id = row["room_id"]
                user_id = row["sender_id"]

                # Resolve image/file attachments
                images = None
                prompt = text
                if text.startswith(IMG_PREFIX):
                    file_path = text[len(IMG_PREFIX):]
                    img = await download_storage_file(file_path)
                    if img:
                        images = [img]
                        prompt = "이미지를 분석해주세요."
                    else:
                        prompt = "이미지를 전송했지만 읽을 수 없습니다."
                elif text.startswith(FILE_PREFIX):
                    content = text[len(FILE_PREFIX):]
                    sep = content.find("|")
                    file_path = content[:sep] if sep != -1 else content
                    file_name = content[sep+1:] if sep != -1 else file_path.rsplit("/", 1)[-1]
                    img = await download_storage_file(file_path)
                    if img and img["mime_type"].startswith("image/"):
                        images = [img]
                        prompt = f"파일 '{file_name}'을 분석해주세요."
                    else:
                        prompt = f"파일 '{file_name}'이 전송되었습니다. (이미지가 아닌 파일은 직접 분석할 수 없습니다.)"

                print(f"[bridge] '{prompt[:60]}' → agent 처리 중...")
                response = await ask_agent(room_id, user_id, prompt, images)

                if response is None:
                    print("[bridge] agent 응답 없음, 재시도 예정")
                    continue

                await supabase_delete_ids("pending_messages", [row["id"]])
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
