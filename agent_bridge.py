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


_UPLOAD_MIME: dict[str, str] = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "gif": "image/gif", "webp": "image/webp",
    "pdf": "application/pdf",
    "zip": "application/zip",
    "txt": "text/plain", "md": "text/markdown", "csv": "text/csv",
    "json": "application/json",
    "mp4": "video/mp4", "mov": "video/quicktime",
    "mp3": "audio/mpeg", "wav": "audio/wav",
}


async def upload_file_to_storage(data: bytes, filename: str, storage_dir: str) -> str | None:
    """Upload raw bytes to Supabase storage, return the storage path."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mime = _UPLOAD_MIME.get(ext, "application/octet-stream")
    file_path = f"{storage_dir}/{uuid.uuid4()}_{filename}"
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"{SUPABASE_URL}/storage/v1/object/chat-images/{file_path}",
            content=data,
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": mime,
                "x-upsert": "true",
            },
        )
        if r.status_code not in (200, 201):
            print(f"[bridge] storage 업로드 실패: {r.status_code} {r.text}")
            return None
        print(f"[bridge] storage 업로드 완료: {file_path} ({len(data):,} bytes)")
        return file_path


async def upload_screenshot_to_storage(data_b64: str, room_id: str) -> str | None:
    """Upload a base64 PNG to Supabase storage, return the storage path."""
    img_bytes = base64.b64decode(data_b64)
    return await upload_file_to_storage(img_bytes, "screenshot.png", f"screenshots/{room_id}")


async def download_storage_file(file_path: str) -> dict | None:
    """Download a file from Supabase storage, return {data: bytes, mime_type}."""
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{SUPABASE_URL}/storage/v1/object/chat-images/{file_path}",
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            },
        )
        if r.status_code != 200:
            print(f"[bridge] storage 다운로드 실패: {r.status_code} {file_path}")
            return None
        # Content-Type 헤더 우선, 없으면 확장자 추측
        ct = r.headers.get("content-type", "").split(";")[0].strip()
        mime_type = ct if ct else _mime_from_path(file_path)
        print(f"[bridge] storage 다운로드: {len(r.content)} bytes, mime={mime_type}")
        return {"data": r.content, "mime_type": mime_type}


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
    ws = await websockets.connect(AGENT_WS, ssl=ssl_ctx, max_size=64 * 1024 * 1024)
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


async def _clear_history_for_room(room_id: str) -> str | None:
    """Send clear_history to agent_server, return saved filename or None."""
    try:
        ws = await _get_ws(room_id)
        await ws.send(json.dumps({"type": "clear_history"}))
        for _ in range(10):  # 최대 5초 대기
            raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
            msg = json.loads(raw)
            if msg.get("type") == "history_cleared":
                return msg.get("saved_as")
    except Exception as e:
        print(f"[bridge] clear_history 오류: {e}")
    return None


async def ask_agent(room_id: str, user_id: str, text: str, images: list | None = None) -> str | None:
    stop_watcher_task = None

    async def stop_watcher(ws):
        while True:
            rows = await supabase_get("pending_messages", {
                "receiver_id": f"eq.{AI_AGENT_ID}",
                "room_id": f"eq.{room_id}",
                "encrypted_payload": f"eq._ai_stop_:",
                "select": "id",
            })
            if rows:
                await supabase_delete_ids("pending_messages", [r["id"] for r in rows])
                try:
                    await ws.send(json.dumps({"type": "stop"}))
                except Exception:
                    pass
                return
            await asyncio.sleep(2)

    try:
        ws = await _get_ws(room_id)
        payload = {"type": "message", "text": text}
        if images:
            # data가 bytes이면 base64 문자열로 변환 (JSON 직렬화)
            payload["images"] = [
                {"data": base64.b64encode(img["data"]).decode() if isinstance(img["data"], bytes) else img["data"],
                 "mime_type": img["mime_type"]}
                for img in images
            ]
        await ws.send(json.dumps(payload))
        accumulated = ""
        await send_status(room_id, user_id, "🤔 요청 분석 중...")
        stop_watcher_task = asyncio.create_task(stop_watcher(ws))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=180)
            msg = json.loads(raw)
            t = msg.get("type")
            if t == "text":
                accumulated += msg.get("text", "")
            elif t == "done":
                await clear_status(room_id)
                return accumulated or None
            elif t in ("error", "stopped"):
                await clear_status(room_id)
                if t == "error":
                    print(f"[bridge] agent 오류 응답: {msg}")
                else:
                    print(f"[bridge] 작업 중단됨")
                return None
            elif t == "file_output":
                data_b64 = msg.get("data", "")
                filename = msg.get("filename", "file")
                note = msg.get("note", filename)
                if data_b64:
                    file_bytes = base64.b64decode(data_b64)
                    storage_path = await upload_file_to_storage(file_bytes, filename, f"files/{room_id}")
                    if storage_path:
                        # _ai_:_file_:path|filename 형식 — 프론트가 AI_PREFIX 슬라이스 후 FILE_PREFIX로 렌더링
                        await supabase_post("pending_messages", {
                            "sender_id": AI_AGENT_ID,
                            "receiver_id": user_id,
                            "room_id": room_id,
                            "encrypted_payload": f"{AI_PREFIX}{FILE_PREFIX}{storage_path}|{filename}",
                            "message_id": str(uuid.uuid4()),
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })
            elif t == "image_output":
                data_b64 = msg.get("data", "")
                note = msg.get("note", "")
                if data_b64:
                    file_path = await upload_screenshot_to_storage(data_b64, room_id)
                    if file_path:
                        # _ai_:_img_:path 형식 — 프론트가 AI_PREFIX 슬라이스 후 IMG_PREFIX로 렌더링
                        await supabase_post("pending_messages", {
                            "sender_id": AI_AGENT_ID,
                            "receiver_id": user_id,
                            "room_id": room_id,
                            "encrypted_payload": f"{AI_PREFIX}{IMG_PREFIX}{file_path}",
                            "message_id": str(uuid.uuid4()),
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })
                        if note:
                            await supabase_post("pending_messages", {
                                "sender_id": AI_AGENT_ID,
                                "receiver_id": user_id,
                                "room_id": room_id,
                                "encrypted_payload": f"{AI_PREFIX}{note}",
                                "message_id": str(uuid.uuid4()),
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                            })
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
    finally:
        if stop_watcher_task:
            stop_watcher_task.cancel()


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
                # stop 신호는 poll_loop에서 건드리지 않음 — stop_watcher가 처리
                if payload == "_ai_stop_:":
                    continue

                # 히스토리 저장 + 초기화 요청
                if payload == "_ai_clear_history_:":
                    await supabase_delete_ids("pending_messages", [row["id"]])
                    room_id = row["room_id"]
                    user_id = row["sender_id"]
                    filename = await _clear_history_for_room(room_id)
                    notice = f"💾 대화가 {filename} 에 저장됐습니다." if filename else "대화 기록이 없어 저장을 건너뜁니다."
                    await supabase_post("pending_messages", {
                        "sender_id": AI_AGENT_ID,
                        "receiver_id": user_id,
                        "room_id": room_id,
                        "encrypted_payload": f"{AI_PREFIX}{notice}",
                        "message_id": str(uuid.uuid4()),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                    continue

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
                    print("[bridge] agent 응답 없음, 요청 삭제")
                    await supabase_delete_ids("pending_messages", [row["id"]])
                    await supabase_post("pending_messages", {
                        "sender_id": AI_AGENT_ID,
                        "receiver_id": user_id,
                        "room_id": room_id,
                        "encrypted_payload": f"{AI_PREFIX}⚠️ 요청을 처리할 수 없었습니다. 다시 시도해 주세요.",
                        "message_id": str(uuid.uuid4()),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
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
