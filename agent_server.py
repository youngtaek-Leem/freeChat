"""
AI Agent Server — FastAPI + WebSocket + Ollama
Cross-platform: macOS (AppleScript) / Windows (PowerShell)

Run: python agent_server.py
"""
import asyncio
import base64
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = []
    sched_task = asyncio.create_task(scheduler_loop())
    tasks.append(sched_task)
    if os.environ.get("SUPABASE_SERVICE_KEY"):
        ssl_cert = os.environ.get("SSL_CERT")
        scheme = "wss" if ssl_cert and os.path.exists(ssl_cert) else "ws"
        os.environ.setdefault("AGENT_WS", f"{scheme}://localhost:3001/ws")
        from agent_bridge import poll_loop
        tasks.append(asyncio.create_task(poll_loop()))
        print(f"[server] AI Friend Bridge 시작됨 ({os.environ['AGENT_WS']})")
    else:
        print("[server] SUPABASE_SERVICE_KEY 없음 — AI Friend Bridge 비활성")
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
IS_MAC = platform.system() == "Darwin"
IS_WIN = platform.system() == "Windows"

CHAT_HISTORY_DIR = Path.home() / ".ai_chats"
CHAT_HISTORY_DIR.mkdir(exist_ok=True)

CLAUDE_TASK_DIR = Path.home() / ".ai_claude_tasks"
CLAUDE_TASK_DIR.mkdir(exist_ok=True)

AGENT_CONFIG_FILE = Path.home() / ".ai_agent_config.json"

# 위험 명령어 패턴 (pattern, 설명)
_DANGER_PATTERNS = [
    (r"rm\s+-[rf]{1,2}\s+[/~*]",   "rm -rf 위험 경로"),
    (r"rm\s+-[rf]{1,2}\s+\*",       "rm -rf 와일드카드"),
    (r"sudo\s+rm",                   "sudo rm"),
    (r"drop\s+table",                "DROP TABLE"),
    (r"drop\s+database",             "DROP DATABASE"),
    (r"truncate\s+table",            "TRUNCATE TABLE"),
    (r"mkfs",                        "디스크 포맷(mkfs)"),
    (r"\bdd\s+if=",                  "dd 디스크 복사"),
    (r":\(\)\{.*\}.*:",             "Fork bomb"),
    (r"chmod\s+-r\s+777",           "chmod -R 777"),
    (r">/dev/[sh]d[a-z]",           "디스크 직접 쓰기"),
]


def _detect_danger(text: str) -> list[str]:
    """계획 텍스트에서 위험 패턴을 검출해 설명 목록 반환."""
    found = []
    lower = text.lower()
    for pattern, label in _DANGER_PATTERNS:
        if re.search(pattern, lower):
            found.append(label)
    return found


def _load_agent_config() -> dict:
    if AGENT_CONFIG_FILE.exists():
        try:
            return json.loads(AGENT_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_agent_config(config: dict):
    AGENT_CONFIG_FILE.write_text(
        json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
    )


SCHEDULED_TASKS_FILE = Path.home() / ".ai_scheduled_tasks.json"
AI_AGENT_ID = "a04fce0a-02f8-4040-962a-22d7d98851f0"
AI_PREFIX = "_ai_:"


def _load_scheduled_tasks() -> list:
    if SCHEDULED_TASKS_FILE.exists():
        try:
            return json.loads(SCHEDULED_TASKS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_scheduled_tasks(tasks: list):
    SCHEDULED_TASKS_FILE.write_text(
        json.dumps(tasks, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _should_run(task: dict, now: datetime) -> bool:
    """예약 시간이 됐는지 확인."""
    schedule = task.get("schedule", "")
    last_run = task.get("last_run")
    last_dt = datetime.fromisoformat(last_run) if last_run else None

    if schedule.startswith("daily "):          # "daily HH:MM"
        h, m = map(int, schedule[6:].split(":"))
        if now.hour == h and now.minute == m:
            if not last_dt or last_dt.date() < now.date():
                return True
    elif schedule.startswith("every "):        # "every Nm" / "every Nh"
        val = schedule[6:]
        secs = int(val[:-1]) * (60 if val.endswith("m") else 3600)
        if not last_dt or (now - last_dt).total_seconds() >= secs:
            return True
    elif schedule.startswith("once "):         # "once YYYY-MM-DD HH:MM"
        target = datetime.strptime(schedule[5:], "%Y-%m-%d %H:%M")
        if not last_dt and now >= target:
            return True
    return False


async def _notify_mobile(text: str):
    """config에 저장된 마지막 활성 사용자에게 Supabase 메시지 전송."""
    cfg = _load_agent_config()
    room_id = cfg.get("notification_room_id")
    user_id = cfg.get("notification_user_id")
    service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    supabase_url = os.environ.get("SUPABASE_URL", "https://cqhxbsyamdmdraiueaht.supabase.co")
    if not (room_id and user_id and service_key):
        print(f"[scheduler] 알림 대상 없음 — 메시지 전송 불가: {text[:60]}")
        return
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(
                f"{supabase_url}/rest/v1/pending_messages",
                json={
                    "sender_id": AI_AGENT_ID,
                    "receiver_id": user_id,
                    "room_id": room_id,
                    "encrypted_payload": f"{AI_PREFIX}{text}",
                    "message_id": str(uuid.uuid4()),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                headers={
                    "apikey": service_key,
                    "Authorization": f"Bearer {service_key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
            )
        print(f"[scheduler] 알림 전송: {text[:60]}")
    except Exception as e:
        print(f"[scheduler] 알림 전송 실패: {e}")


async def _execute_scheduled_task(task: dict):
    """예약 작업 실행 후 결과를 모바일로 전송."""
    name = task.get("name", "예약 작업")
    cmd_type = task.get("type", "shell")
    command = task.get("command", "")
    workspace = task.get("workspace")
    cwd = workspace or None

    await _notify_mobile(f"⏰ 예약 작업 시작: {name}")
    proc = None
    try:
        if cmd_type == "shell":
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
            output = (stdout.decode(errors="replace") + stderr.decode(errors="replace")).strip()
            output = output[:800] or "(출력 없음)"
            await _notify_mobile(f"✅ {name} 완료\n\n{output}")
        elif cmd_type == "claude":
            claude_bin = shutil.which("claude") or "claude"
            proc = await asyncio.create_subprocess_exec(
                claude_bin, "--print", "--dangerously-skip-permissions", command,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
            output = stdout.decode(errors="replace").strip()[:800] or "(출력 없음)"
            await _notify_mobile(f"✅ {name} 완료\n\n{output}")
    except asyncio.TimeoutError:
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass
        await _notify_mobile(f"⚠️ {name} 타임아웃 (300초 초과) — 프로세스 강제 종료")
    except Exception as e:
        await _notify_mobile(f"❌ {name} 실패: {e}")


async def scheduler_loop():
    """30초마다 예약 작업을 확인하고 실행."""
    print("[scheduler] 시작됨")
    while True:
        await asyncio.sleep(30)
        try:
            tasks = _load_scheduled_tasks()
            now = datetime.now()
            changed = False
            for task in tasks:
                try:
                    if task.get("enabled", True) and _should_run(task, now):
                        print(f"[scheduler] 실행: {task.get('name')}")
                        asyncio.create_task(_execute_scheduled_task(task))
                        task["last_run"] = now.isoformat()
                        changed = True
                        # once 타입은 실행 후 비활성화
                        if task.get("schedule", "").startswith("once "):
                            task["enabled"] = False
                except Exception as te:
                    print(f"[scheduler] 태스크 오류 ({task.get('name', '?')}): {te}")
            if changed:
                _save_scheduled_tasks(tasks)
        except Exception as e:
            print(f"[scheduler] 오류: {e}")


def _save_claude_task(prompt: str, plan: str, result: str, workspace: "str | None", duration: float) -> str:
    """run_claude 실행 결과를 파일로 저장. 파일명 반환."""
    task = {
        "timestamp": datetime.now().isoformat(),
        "prompt": prompt,
        "plan": plan,
        "result": result[:1000],
        "workspace": workspace,
        "duration_sec": round(duration, 1),
    }
    fname = f"task_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    (CLAUDE_TASK_DIR / fname).write_text(
        json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return fname


def _save_history(conversation: list) -> str:
    """Save conversation (excluding system prompt) to a JSON file. Returns filename."""
    messages = [m for m in conversation if m.get("role") != "system"]
    # Strip raw binary data (images in tool messages) to keep files small
    clean = []
    for m in messages:
        entry = {k: v for k, v in m.items() if k not in ("images", "gemini_content")}
        clean.append(entry)
    filename = f"chat_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    path = CHAT_HISTORY_DIR / filename
    path.write_text(json.dumps({"saved_at": datetime.now().isoformat(), "messages": clean}, ensure_ascii=False, indent=2), encoding="utf-8")
    return filename

# ── Playwright browser manager ─────────────────────────────────────────────

class BrowserManager:
    def __init__(self):
        self._playwright = None
        self._browser = None
        self._page = None

    async def get_page(self):
        from playwright.async_api import async_playwright
        if self._playwright is None:
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=False)
        if self._page is None or self._page.is_closed():
            self._page = await self._browser.new_page()
        return self._page

    async def close(self):
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        self._playwright = None
        self._browser = None
        self._page = None

browser = BrowserManager()

# ── Gemini helpers ────────────────────────────────────────────────────────

_TYPE_MAP = {"string": "STRING", "number": "NUMBER", "integer": "INTEGER",
             "boolean": "BOOLEAN", "array": "ARRAY", "object": "OBJECT"}


def _convert_schema(schema: dict) -> dict:
    if not isinstance(schema, dict):
        return schema
    result = {}
    for k, v in schema.items():
        if k == "type" and isinstance(v, str):
            result[k] = _TYPE_MAP.get(v.lower(), v.upper())
        elif k == "properties" and isinstance(v, dict):
            result[k] = {pk: _convert_schema(pv) for pk, pv in v.items()}
        elif isinstance(v, dict):
            result[k] = _convert_schema(v)
        elif isinstance(v, list):
            result[k] = [_convert_schema(i) if isinstance(i, dict) else i for i in v]
        else:
            result[k] = v
    return result


def _build_gemini_tools():
    from google.genai import types
    declarations = []
    for tool in TOOLS:
        fn = tool["function"]
        declarations.append(types.FunctionDeclaration(
            name=fn["name"],
            description=fn.get("description", ""),
            parameters=_convert_schema(fn.get("parameters", {})),
        ))
    return [types.Tool(function_declarations=declarations)]


def _to_gemini_contents(conversation: list) -> tuple[str, list]:
    """Convert OpenAI-format conversation list → (system_instruction, gemini_contents)."""
    system_instruction = ""
    contents = []
    i = 0
    while i < len(conversation):
        msg = conversation[i]
        role = msg.get("role")
        content = msg.get("content", "")
        if role == "system":
            system_instruction = content
            i += 1
            continue
        if role == "user":
            parts = []
            if content:
                parts.append({"text": content})
            for img in msg.get("images", []):
                if isinstance(img, dict):
                    raw = img["data"]
                    # bytes로 변환 (base64 문자열이면 디코딩)
                    if isinstance(raw, str):
                        raw = base64.b64decode(raw)
                    parts.append({"inline_data": {"mime_type": img.get("mime_type", "image/jpeg"), "data": raw}})
                else:
                    raw = base64.b64decode(img) if isinstance(img, str) else img
                    parts.append({"inline_data": {"mime_type": "image/jpeg", "data": raw}})
            if parts:
                contents.append({"role": "user", "parts": parts})
            i += 1
        elif role == "assistant":
            # Use raw Content object if available — preserves thought_signature bytes exactly
            gemini_content = msg.get("gemini_content")
            if gemini_content is not None:
                contents.append(gemini_content)
            else:
                parts = []
                if content:
                    parts.append({"text": content})
                for tc in msg.get("tool_calls", []):
                    fn = tc.get("function", {})
                    args = fn.get("arguments", {})
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except Exception:
                            args = {}
                    parts.append({"function_call": {"name": fn.get("name", ""), "args": args}})
                if parts:
                    contents.append({"role": "model", "parts": parts})
            i += 1
        elif role == "tool":
            tool_parts = []
            while i < len(conversation) and conversation[i].get("role") == "tool":
                t = conversation[i]
                t_name = t.get("name", "unknown")
                t_content = t.get("content", "")
                tool_parts.append({"function_response": {"name": t_name, "response": {"result": t_content}}})
                for img_b64 in t.get("images", []):
                    tool_parts.append({"inline_data": {"mime_type": "image/png", "data": img_b64}})
                i += 1
            if tool_parts:
                contents.append({"role": "user", "parts": tool_parts})
        else:
            i += 1
    return system_instruction, contents


async def _call_gemini(conversation: list, websocket) -> tuple[str, list, object]:
    """Call Gemini API. Returns (full_text, tool_calls, raw_model_content).
    raw_model_content is the original Content object from the API — it preserves
    thought_signature bytes exactly so the next turn can replay it without loss.
    """
    from google import genai
    from google.genai import types

    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY 환경변수가 없습니다. "
            "https://aistudio.google.com/app/apikey 에서 키를 발급받아 "
            "export GEMINI_API_KEY=your_key 로 설정하세요."
        )

    client = genai.Client()
    system_instruction, contents = _to_gemini_contents(conversation)

    config = types.GenerateContentConfig(
        system_instruction=system_instruction or None,
        tools=_build_gemini_tools(),
    )

    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = await client.aio.models.generate_content(
                model=GEMINI_MODEL,
                contents=contents,
                config=config,
            )

            full_text = ""
            tool_calls = []
            raw_content = None

            if response.candidates:
                raw_content = response.candidates[0].content  # preserve as-is
                for part in raw_content.parts:
                    if getattr(part, "thought", False):
                        continue
                    if getattr(part, "text", None):
                        full_text += part.text
                    fc = getattr(part, "function_call", None)
                    if fc and getattr(fc, "name", None):
                        args = dict(fc.args) if fc.args else {}
                        tool_calls.append({
                            "id": f"{fc.name}_{id(part)}",
                            "function": {"name": fc.name, "arguments": args},
                        })

            if full_text:
                try:
                    await websocket.send_json({"type": "thinking_done"})
                    await websocket.send_json({"type": "text", "text": full_text})
                except Exception:
                    pass

            return full_text, tool_calls, raw_content

        except Exception as e:
            err_str = str(e)
            if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                import re as _re
                m = _re.search(r"retry[Dd]elay.*?(\d+)", err_str)
                wait_sec = int(m.group(1)) + 2 if m else 60
                if attempt < max_retries - 1:
                    await websocket.send_json({
                        "type": "progress",
                        "icon": "⏳",
                        "message": f"API 요청 한도 초과. {wait_sec}초 후 재시도... ({attempt + 1}/{max_retries - 1})",
                    })
                    await asyncio.sleep(wait_sec)
                    continue
            raise


# ── Tool definitions ───────────────────────────────────────────────────────

TOOLS = [
    # ── File management ──
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files and directories at a given path",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path. Use ~ for home directory."}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a text file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to read"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write or overwrite a file with given content",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to write"},
                    "content": {"type": "string", "description": "Content to write"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delete_file",
            "description": "Delete a file or directory",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to delete"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "copy_file",
            "description": "Copy a file or directory to a new location",
            "parameters": {
                "type": "object",
                "properties": {
                    "src": {"type": "string", "description": "Source path"},
                    "dst": {"type": "string", "description": "Destination path"},
                },
                "required": ["src", "dst"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_file",
            "description": "Move or rename a file or directory",
            "parameters": {
                "type": "object",
                "properties": {
                    "src": {"type": "string", "description": "Source path"},
                    "dst": {"type": "string", "description": "Destination path"},
                },
                "required": ["src", "dst"],
            },
        },
    },
    # ── Web ──
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the web using DuckDuckGo and return a list of results. "
                "Use this to find information, news, documentation, or any topic. "
                "Returns titles, URLs, and snippets."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "max_results": {"type": "integer", "description": "Max results to return (default 5)", "default": 5},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_url",
            "description": "Open a URL in the default web browser",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to open"}
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_webpage",
            "description": "Fetch and return the text content of a webpage",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to fetch"}
                },
                "required": ["url"],
            },
        },
    },
    # ── Screen ──
    {
        "type": "function",
        "function": {
            "name": "take_screenshot",
            "description": (
                "Take a screenshot of the current screen and analyze it with the vision model. "
                "Use this to see what is currently on screen, read text from the screen, "
                "check the state of an app, or verify the result of an action. "
                "Returns an image that will be analyzed by the vision model."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "note": {"type": "string", "description": "Optional note describing why you are taking this screenshot"}
                },
                "required": [],
            },
        },
    },
    # ── System ──
    {
        "type": "function",
        "function": {
            "name": "execute_shell",
            "description": "Execute a shell command (bash on macOS/Linux, PowerShell on Windows)",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to execute"},
                    "timeout": {"type": "integer", "description": "Max seconds to wait (default 30)", "default": 30},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "control_app",
            "description": (
                "Control an application using AppleScript (macOS) or PowerShell (Windows). "
                "Use this for tasks that are difficult to do otherwise: "
                "controlling GUI apps (Finder, Safari, Mail, Calendar, Reminders, Music, etc.), "
                "reading/writing system clipboard, sending keystrokes, clicking UI elements, "
                "sending emails via Mail.app, adding calendar events, showing notifications. "
                "On macOS use AppleScript syntax. On Windows use PowerShell syntax. "
                "Example macOS: 'tell application \"Finder\" to reveal POSIX file \"/tmp\"'. "
                "Example Windows: 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText(\"hello\")'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "script": {"type": "string", "description": "AppleScript (macOS) or PowerShell (Windows) script"}
                },
                "required": ["script"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_python",
            "description": (
                "Write and execute Python code to solve tasks that are hard to do with other tools. "
                "Use this for: complex data processing, math/statistics, JSON/CSV manipulation, "
                "image processing (Pillow), PDF handling, regex extraction, API calls (requests), "
                "zip/archive operations, encoding/decoding, generating charts (matplotlib), "
                "or any multi-step logic that is cleaner in code than shell commands. "
                "The code runs in the workspace directory. Print results to stdout."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python 3 code to execute. Use print() for output."}
                },
                "required": ["code"],
            },
        },
    },
    # ── App finder ──
    {
        "type": "function",
        "function": {
            "name": "find_app",
            "description": (
                "Find installed macOS applications by partial name using Spotlight (mdfind). "
                "Always use this BEFORE launching an app to discover its exact name and path. "
                "If no results, retry with shorter or different keywords: "
                "'이문열 중국고전' → '중국고전' → '중국' → '이문열'. "
                "Returns matching .app paths and the open command to launch each one."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "Partial app name keyword (Korean or English)"},
                },
                "required": ["keyword"],
            },
        },
    },
    # ── System monitoring ──
    {
        "type": "function",
        "function": {
            "name": "system_monitor",
            "description": "Get current system status: CPU, memory, disk, network usage. Use when user asks about computer state or performance.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    # ── Process management ──
    {
        "type": "function",
        "function": {
            "name": "list_processes",
            "description": "List running processes sorted by CPU usage. Use when user asks what's running or wants to find a process to kill.",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "Filter processes by name keyword (optional)"},
                    "top": {"type": "integer", "description": "Number of top processes to return (default 20)", "default": 20},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kill_process",
            "description": "Terminate a process by PID or name. This is a destructive action — always confirm with the user first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pid": {"type": "integer", "description": "Process ID to kill (preferred)"},
                    "name": {"type": "string", "description": "Process name to kill (kills first match)"},
                },
                "required": [],
            },
        },
    },
    # ── Scheduled tasks ──
    {
        "type": "function",
        "function": {
            "name": "schedule_task",
            "description": (
                "Schedule a recurring or one-time task. "
                "schedule format: 'daily HH:MM' | 'every Nm' | 'every Nh' | 'once YYYY-MM-DD HH:MM'. "
                "type: 'shell' for bash commands, 'claude' for natural language tasks. "
                "Examples: 'daily 09:00', 'every 30m', 'once 2026-06-10 14:00'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name":     {"type": "string", "description": "Task name (shown in notifications)"},
                    "schedule": {"type": "string", "description": "Schedule string"},
                    "type":     {"type": "string", "description": "'shell' or 'claude'", "default": "shell"},
                    "command":  {"type": "string", "description": "Shell command or natural language instruction"},
                    "workspace":{"type": "string", "description": "Working directory (optional)"},
                },
                "required": ["name", "schedule", "command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_scheduled_tasks",
            "description": "List all scheduled tasks.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_scheduled_task",
            "description": "Cancel (disable) a scheduled task by ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string", "description": "Task ID from list_scheduled_tasks"},
                },
                "required": ["task_id"],
            },
        },
    },
    # ── Chat history ──
    {
        "type": "function",
        "function": {
            "name": "list_chat_history",
            "description": "List saved chat history files. Use this when the user wants to continue a previous conversation.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "load_chat_history",
            "description": "Load a saved chat history file to continue the previous conversation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "Filename from list_chat_history (e.g. chat_20260604_143022.json)"},
                },
                "required": ["filename"],
            },
        },
    },
    # ── Claude task history ──
    {
        "type": "function",
        "function": {
            "name": "list_claude_tasks",
            "description": "List recent run_claude task history. Use when user asks to continue previous work or see what was done before.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "load_claude_task",
            "description": "Load a specific run_claude task to get context (prompt, plan, result, workspace).",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "Task filename from list_claude_tasks"},
                },
                "required": ["filename"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_default_workspace",
            "description": "Save a directory as the default workspace. Future run_claude calls will use this directory automatically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path to set as default workspace"},
                },
                "required": ["path"],
            },
        },
    },
    # ── Send file to mobile chat ──
    {
        "type": "function",
        "function": {
            "name": "send_file",
            "description": (
                "Send a file from the local filesystem to the mobile chat. "
                "The file is uploaded to cloud storage and delivered as a downloadable attachment. "
                "Use this when the user asks to 'send', 'share', or 'transfer' a file. "
                "For multiple files or a folder, use send_files_zipped instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute or workspace-relative file path to send"},
                    "note": {"type": "string", "description": "Optional caption shown in chat alongside the file"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_files_zipped",
            "description": (
                "Compress one or more files or folders into a zip archive and send it to the mobile chat. "
                "Use this when sending multiple files, a whole directory, or when the user asks to compress before sending."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of file/folder paths to include in the zip",
                    },
                    "zip_name": {"type": "string", "description": "Name for the zip file (default: archive.zip)", "default": "archive.zip"},
                    "note": {"type": "string", "description": "Optional caption shown in chat"},
                },
                "required": ["paths"],
            },
        },
    },
    # ── Send screenshot to mobile chat ──
    {
        "type": "function",
        "function": {
            "name": "capture_and_send",
            "description": (
                "Take a screenshot of the current screen and send it as an image to the mobile chat. "
                "Use this when the user asks to 'send a screenshot', 'show me the screen', or 'capture and share'. "
                "Unlike take_screenshot (which only lets the AI see the screen), this delivers the image to the user's chat."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "note": {"type": "string", "description": "Optional caption for the image"}
                },
                "required": [],
            },
        },
    },
    # ── Claude Code sub-agent ──
    {
        "type": "function",
        "function": {
            "name": "run_claude",
            "description": (
                "Run a Claude sub-agent (via Anthropic SDK) to handle coding tasks. "
                "The sub-agent can read/write files and run bash commands. "
                "Dangerous operations (bash, file writes) will pause and ask the user for confirmation before executing. "
                "Use this to delegate coding tasks, refactoring, file edits, or explanations. "
                "Example: 'Implement a login API in src/auth.py' or 'Explain what main.py does'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "The instruction to send to the Claude sub-agent"},
                    "timeout": {"type": "integer", "description": "Max seconds to wait (default 300)", "default": 300},
                },
                "required": ["prompt"],
            },
        },
    },
    # ── Mouse / Keyboard ──
    {
        "type": "function",
        "function": {
            "name": "mouse_move",
            "description": "Move the mouse cursor to absolute screen coordinates",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer", "description": "X coordinate"},
                    "y": {"type": "integer", "description": "Y coordinate"},
                },
                "required": ["x", "y"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_click",
            "description": "Click the mouse at given coordinates. Use take_screenshot first to find the right coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {"type": "integer", "description": "X coordinate"},
                    "y": {"type": "integer", "description": "Y coordinate"},
                    "button": {"type": "string", "description": "'left', 'right', or 'middle' (default: left)", "default": "left"},
                    "clicks": {"type": "integer", "description": "Number of clicks: 1 for single, 2 for double (default: 1)", "default": 1},
                },
                "required": ["x", "y"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_drag",
            "description": "Click and drag from one coordinate to another",
            "parameters": {
                "type": "object",
                "properties": {
                    "x1": {"type": "integer", "description": "Start X"},
                    "y1": {"type": "integer", "description": "Start Y"},
                    "x2": {"type": "integer", "description": "End X"},
                    "y2": {"type": "integer", "description": "End Y"},
                },
                "required": ["x1", "y1", "x2", "y2"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "type_text",
            "description": "Type text using the keyboard at the current cursor position. Click the target field first with mouse_click.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to type"},
                    "interval": {"type": "number", "description": "Seconds between keystrokes (default 0.02)", "default": 0.02},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "press_key",
            "description": (
                "Press a single key or key combination. "
                "Key names: enter, tab, space, backspace, delete, escape, up, down, left, right, "
                "home, end, pageup, pagedown, f1-f12, cmd, ctrl, shift, alt, option. "
                "For combinations use hotkey instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Key name, e.g. 'enter', 'escape', 'tab'"},
                    "presses": {"type": "integer", "description": "How many times to press (default 1)", "default": 1},
                },
                "required": ["key"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "hotkey",
            "description": (
                "Press a keyboard shortcut (multiple keys simultaneously). "
                "Examples: ['cmd', 'c'] for copy, ['cmd', 'v'] for paste, "
                "['cmd', 'z'] for undo, ['cmd', 'shift', 'z'] for redo, "
                "['cmd', 'a'] for select all, ['ctrl', 'c'] on Windows/Linux."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "keys": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of key names to press together, e.g. ['cmd', 'c']",
                    },
                },
                "required": ["keys"],
            },
        },
    },
    # ── Browser automation ──
    {
        "type": "function",
        "function": {
            "name": "browser_navigate",
            "description": (
                "Open a URL in the automated Chromium browser. "
                "Use this for web automation: login flows, form submission, dynamic pages that need JavaScript. "
                "Different from open_url — this controls a browser you can interact with further."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to navigate to"},
                    "wait_for": {
                        "type": "string",
                        "description": "CSS selector or 'load' or 'networkidle' to wait for after navigation",
                        "default": "load",
                    },
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_click",
            "description": "Click an element in the automated browser by CSS selector or visible text",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS selector, e.g. '#submit-btn' or 'button:text(\"Login\")'"},
                },
                "required": ["selector"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_fill",
            "description": "Type text into an input field in the automated browser",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS selector for the input field"},
                    "value": {"type": "string", "description": "Text to type"},
                },
                "required": ["selector", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_get_text",
            "description": "Extract text content from the current browser page or a specific element",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": "CSS selector to extract text from. Leave empty for full page text.",
                        "default": "",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_screenshot",
            "description": (
                "Take a screenshot of the current automated browser page. "
                "Useful to verify what the browser is showing after navigation or interaction."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_close",
            "description": (
                "Close the automated browser. "
                "Always call this after you have finished extracting the information you need from the web. "
                "Do not leave the browser open unnecessarily."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "browser_eval",
            "description": (
                "Execute JavaScript in the current browser page and return the result. "
                "Use this when other browser tools fail — e.g. elements inside iframes, "
                "shadow DOM, or when you need fine-grained control. "
                "Examples: "
                "'document.querySelector(\"input\").value = \"hello\"' to set a field, "
                "'document.querySelector(\"button\").click()' to click, "
                "'document.title' to get the page title, "
                "'[...document.querySelectorAll(\"a\")].map(a=>a.href).join(\"\\\\n\")' to list links."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "script": {"type": "string", "description": "JavaScript code to execute in the page context"},
                },
                "required": ["script"],
            },
        },
    },
]

# ── Progress messages (icon, message) per tool ────────────────────────────

TOOL_MESSAGES: dict[str, tuple[str, str]] = {
    "list_files":       ("📁", "파일 목록 확인 중"),
    "read_file":        ("📖", "파일 읽는 중"),
    "write_file":       ("✍️",  "파일 작성 중"),
    "delete_file":      ("🗑️",  "파일 삭제 중"),
    "copy_file":        ("📋", "파일 복사 중"),
    "move_file":        ("📦", "파일 이동 중"),
    "web_search":       ("🔍", "웹 검색 중"),
    "open_url":         ("🌐", "브라우저 열기"),
    "fetch_webpage":    ("📄", "웹 페이지 불러오는 중"),
    "find_app":         ("🔎", "앱 검색 중"),
    "take_screenshot":  ("📷", "화면 캡처 중"),
    "execute_shell":    ("⚙️",  "명령 실행 중"),
    "control_app":      ("🖥️",  "앱 제어 중"),
    "run_python":       ("🐍", "Python 코드 실행 중"),
    "list_chat_history":  ("📋", "대화 기록 목록 조회 중"),
    "load_chat_history":  ("📂", "대화 기록 불러오는 중"),
    "list_claude_tasks":     ("📋", "Claude 작업 이력 조회 중"),
    "load_claude_task":      ("📂", "Claude 작업 이력 불러오는 중"),
    "set_default_workspace": ("📌", "기본 작업 디렉토리 저장 중"),
    "system_monitor":        ("📊", "시스템 상태 확인 중"),
    "list_processes":        ("🔍", "프로세스 목록 조회 중"),
    "kill_process":          ("🛑", "프로세스 종료 중"),
    "schedule_task":         ("⏰", "작업 예약 중"),
    "list_scheduled_tasks":  ("📋", "예약 작업 목록 조회 중"),
    "cancel_scheduled_task": ("🗑️",  "예약 작업 취소 중"),
    "send_file":        ("📤", "파일 전송 중"),
    "send_files_zipped":("🗜️",  "파일 압축 후 전송 중"),
    "capture_and_send": ("📤", "화면 캡처 후 전송 중"),
    "run_claude":       ("🤖", "Claude Code 실행 중"),
    "mouse_move":       ("🖱️",  "마우스 이동 중"),
    "mouse_click":      ("👆", "마우스 클릭 중"),
    "mouse_drag":       ("✋", "드래그 중"),
    "type_text":        ("⌨️",  "텍스트 입력 중"),
    "press_key":        ("🔑", "키 입력 중"),
    "hotkey":           ("⌨️",  "단축키 입력 중"),
    "browser_navigate": ("🌐", "페이지 이동 중"),
    "browser_click":    ("👆", "클릭 중"),
    "browser_fill":     ("⌨️",  "텍스트 입력 중"),
    "browser_get_text": ("📝", "텍스트 추출 중"),
    "browser_screenshot":("📷", "브라우저 스크린샷 캡처 중"),
    "browser_close":     ("🔒", "브라우저 닫는 중"),
    "browser_eval":      ("🔧", "JavaScript 실행 중"),
}

# Tools that can take a while — get animated heartbeat dots
LONG_RUNNING_TOOLS = {
    "web_search", "fetch_webpage", "run_python",
    "execute_shell", "browser_navigate", "take_screenshot",
    "run_claude", "capture_and_send", "send_file", "send_files_zipped",
}


async def _heartbeat(websocket: WebSocket, tool_name: str, step: int):
    """Send animated progress dots every 1.5 s while a long-running tool is executing."""
    icon, base = TOOL_MESSAGES.get(tool_name, ("⚙️", "처리 중"))
    dots = 0
    try:
        while True:
            await asyncio.sleep(1.5)
            dots = (dots % 3) + 1
            try:
                await websocket.send_json({
                    "type": "progress",
                    "step": step,
                    "tool": tool_name,
                    "icon": icon,
                    "message": base + " " + "·" * dots,
                })
            except Exception:
                return  # WS closed — stop heartbeat silently
    except asyncio.CancelledError:
        pass


# ── Risk levels ────────────────────────────────────────────────────────────
# low = auto execute, medium = auto execute with preview, high = require user confirmation

RISK = {
    "list_files": "low",
    "read_file": "low",
    "fetch_webpage": "low",
    "open_url":  "low",
    "find_app":  "low",
    "web_search": "low",
    "take_screenshot": "low",
    "list_chat_history":     "low",
    "load_chat_history":     "low",
    "list_claude_tasks":     "low",
    "load_claude_task":      "low",
    "set_default_workspace": "low",
    "system_monitor":        "low",
    "list_processes":        "low",
    "kill_process":          "high",
    "schedule_task":         "medium",
    "list_scheduled_tasks":  "low",
    "cancel_scheduled_task": "medium",
    "send_file":        "medium",
    "send_files_zipped":"medium",
    "capture_and_send": "low",
    "run_claude":   "medium",
    "mouse_move":   "low",
    "mouse_click":  "medium",
    "mouse_drag":   "medium",
    "type_text":    "medium",
    "press_key":    "low",
    "hotkey":       "medium",
    "browser_navigate": "low",
    "browser_get_text": "low",
    "browser_screenshot": "low",
    "write_file": "medium",
    "copy_file": "medium",
    "move_file": "medium",
    "control_app": "medium",
    "execute_shell": "medium",
    "run_python": "medium",
    "browser_click": "medium",
    "browser_fill": "medium",
    "browser_eval":  "medium",
    "browser_close": "low",
    "delete_file":   "high",
}


def get_risk(tool_name: str, args: dict, workspace: "Path | None") -> str:
    base = RISK.get(tool_name, "medium")
    if workspace and tool_name in ("write_file", "read_file", "list_files"):
        try:
            path = expand(args.get("path", ""), workspace)
            if str(path).startswith(str(workspace)):
                return "low"
        except Exception:
            pass
    return base


# ── Helpers ────────────────────────────────────────────────────────────────

def read_guide(workspace: Path | None) -> str | None:
    if not workspace:
        return None
    guide_path = workspace / "Guide.md"
    if guide_path.exists():
        try:
            return guide_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None
    return None


def build_system_prompt(workspace: Path | None, guide: str | None = None) -> str:
    base = (
        f"You are a powerful AI assistant running on {platform.system()}. "
        "You have tools to manage files, search the web, take screenshots, "
        "control applications, automate browsers, and run code. "
        "Always narrate your progress as you work — before each tool call explain what you're about to do "
        "and why, and after each result summarize what you found or did. "
        "If a task has multiple steps, number them so the user can follow along (e.g. '1단계: …', '2단계: …'). "
        "Keep the user engaged: never go silent for more than one tool call without a brief update. "
        "Respond in the same language the user writes in.\n\n"
        "Tool selection strategy:\n"
        "- To find information on the web → use web_search first, then fetch_webpage for details\n"
        "- To see the current state of the screen → use take_screenshot\n"
        "- For complex data processing, calculations, or multi-step logic → use run_python\n"
        "- To LAUNCH a macOS app → use find_app to get the path, then execute_shell: open '/path/to/App.app' (NO Automation permission needed)\n"
        "- NEVER use control_app just to open/launch an app — always prefer: open '/path/to/App.app'\n"
        "- If find_app returns no results, retry with shorter keywords (e.g. '중국고전' → '중국' → '이문열')\n"
        "- For CONTROLLING apps (reading data, clicking UI, sending emails, calendar) → use control_app (AppleScript)\n"
        "- For web pages requiring login or JavaScript → use browser_navigate + browser_click/fill, then browser_close when done\n"
        "- Always call browser_close once you have extracted the information you need from the browser\n"
        "- For simple shell operations → use execute_shell\n"
        "- When a task seems difficult, think: 'Can I write 10 lines of Python to solve this?' If yes, use run_python.\n"
        "- After taking a screenshot or browser_screenshot, describe what you see in detail.\n"
        "- IMPORTANT: When you call run_claude, do NOT also call write_file, execute_shell, or run_python "
        "for the same task in the same turn. run_claude handles file and shell operations internally."
    )
    if workspace:
        base += (
            f"\n\nWorkspace: {workspace}\n"
            "This is the designated working directory. "
            "Prefer to read, write, and execute code within this folder."
        )
    if guide:
        base += (
            f"\n\n---\n## Project Guidelines (Guide.md)\n\n{guide}\n---\n\n"
            "You MUST strictly follow the above guidelines for ALL tasks in this workspace."
        )
    return base


def expand(path: str, workspace: "Path | None" = None) -> Path:
    p = Path(path).expanduser()
    if not p.is_absolute() and workspace:
        return (workspace / p).resolve()
    return p.resolve()


# ── Claude CLI 2단계 실행 (계획 확인 → 실행) ──────────────────────────────

async def run_claude_sdk(
    prompt: str,
    tool_id: str,
    workspace: "Path | None",
    websocket,
    incoming: asyncio.Queue,
    stop_event: asyncio.Event,
    timeout: int = 300,
) -> str:
    """Claude CLI 2단계 실행.
    1단계: Claude에게 실행 계획만 텍스트로 설명하도록 요청
    확인: WebSocket으로 사용자에게 계획을 보여주고 승인/거절 요청
    2단계: 승인되면 --dangerously-skip-permissions 로 실제 실행
    """
    claude_bin = shutil.which("claude") or "claude"
    cwd = str(workspace) if workspace else None

    async def _send(payload: dict):
        try:
            await websocket.send_json(payload)
        except Exception:
            pass

    async def _wait_confirm() -> bool:
        pending = []
        approved = False
        try:
            deadline = asyncio.get_event_loop().time() + 120
            while True:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                try:
                    data = await asyncio.wait_for(incoming.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                if data is None:
                    await incoming.put(None)
                    break
                if data.get("type") == "confirm" and data.get("tool_call_id") == tool_id:
                    approved = data.get("approved", False)
                    break
                pending.append(data)
        finally:
            for m in pending:
                await incoming.put(m)
        return approved

    # ── 1단계: 계획 수립 ──────────────────────────────────────────────────
    print(f"[run_claude] 계획 수립 시작: {prompt[:60]}")
    await _send({"type": "progress", "icon": "🤖", "message": "Claude 실행 계획 수립 중..."})

    plan_prompt = (
        f"{prompt}\n\n"
        "---\n"
        "위 작업을 수행하기 위해 당신이 실행할 단계를 간결하게 나열하세요.\n"
        "각 단계에 생성/수정할 파일 경로와 실행할 명령어를 구체적으로 포함하세요.\n"
        "실제로 파일을 만들거나 명령을 실행하지 말고, 계획만 텍스트로 출력하세요."
    )

    try:
        plan_proc = await asyncio.create_subprocess_exec(
            claude_bin, "--print", plan_prompt,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        print(f"[run_claude] claude 프로세스 시작됨 (PID={plan_proc.pid})")
        plan_task = asyncio.create_task(plan_proc.communicate())
        done, _ = await asyncio.wait(
            [plan_task, asyncio.create_task(stop_event.wait())],
            return_when=asyncio.FIRST_COMPLETED,
            timeout=300,  # 5분
        )
        if stop_event.is_set():
            plan_proc.kill()
            print("[run_claude] 계획 수립 중 STOP 신호")
            return "작업이 중단됐습니다."
        if not done:  # 5분 타임아웃
            plan_proc.kill()
            plan_text = "(계획 수립 타임아웃)"
            print("[run_claude] 계획 수립 타임아웃")
        else:
            plan_stdout, plan_stderr = plan_task.result()
            plan_text = plan_stdout.decode(errors="replace").strip()
            if not plan_text:
                plan_text = plan_stderr.decode(errors="replace").strip() or "(계획 없음)"
            print(f"[run_claude] 계획 수립 완료: {plan_text[:80]}")
    except Exception as e:
        plan_text = f"(계획 수립 실패: {e})"
        print(f"[run_claude] 계획 수립 실패: {e}")

    # ── 위험 명령어 감지 ──────────────────────────────────────────────────
    danger_warnings = _detect_danger(plan_text)

    # ── 파일 존재 여부 확인 (덮어쓰기 경고) ──────────────────────────────
    existing_files = []
    for m in re.finditer(r'[`\'"]?((?:~|/[\w/]|\.\.?/)\S+\.\w+)[`\'"]?', plan_text):
        fpath = Path(m.group(1).replace("~", str(Path.home())))
        if fpath.exists() and fpath.is_file():
            existing_files.append(str(m.group(1)))
    existing_files = list(dict.fromkeys(existing_files))[:5]  # 중복 제거, 최대 5개

    # ── 확인 요청 ─────────────────────────────────────────────────────────
    print(f"[run_claude] confirm 요청 전송 | danger={danger_warnings} | existing={existing_files}")
    await _send({
        "type": "confirm_request",
        "id": tool_id,
        "name": "run_claude",
        "args": {
            "task": prompt,
            "plan": plan_text,
            "danger_warnings": danger_warnings,
            "existing_files": existing_files,
        },
    })

    if stop_event.is_set():
        return "작업이 중단됐습니다."

    approved = await _wait_confirm()
    print(f"[run_claude] 사용자 응답: approved={approved}")
    if not approved:
        return "사용자가 취소했습니다."

    # ── 2단계: 실제 실행 ──────────────────────────────────────────────────
    exec_start = asyncio.get_event_loop().time()
    await _send({"type": "progress", "icon": "🤖", "message": "Claude 작업 실행 중..."})

    try:
        exec_proc = await asyncio.create_subprocess_exec(
            claude_bin, "--print", "--dangerously-skip-permissions", prompt,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )

        async def _stream_output():
            """stdout을 읽으면서 진행 상황을 WebSocket으로 스트리밍."""
            accumulated = ""
            stop_task = asyncio.create_task(stop_event.wait())
            try:
                while True:
                    line_task = asyncio.create_task(exec_proc.stdout.readline())
                    done, _ = await asyncio.wait(
                        [line_task, stop_task],
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if stop_event.is_set():
                        line_task.cancel()
                        exec_proc.kill()
                        print("[run_claude] 실행 중 STOP 신호")
                        break
                    line = line_task.result()
                    if not line:
                        break
                    text = line.decode(errors="replace").rstrip()
                    if text:
                        accumulated += text + "\n"
                        await _send({"type": "progress", "icon": "🤖", "message": text[:120]})
                        await _send({"type": "stream_text", "text": text})
            finally:
                stop_task.cancel()
            return accumulated

        output = await asyncio.wait_for(_stream_output(), timeout=timeout)
        await exec_proc.wait()
        if stop_event.is_set():
            stop_event.clear()
            return "작업이 중단됐습니다."

        duration = asyncio.get_event_loop().time() - exec_start
        result_text = output.strip() or "작업 완료"

        # 이력 저장
        task_file = _save_claude_task(prompt, plan_text, result_text, str(workspace) if workspace else None, duration)
        print(f"[run_claude] 작업 이력 저장: {task_file} ({duration:.1f}s)")

        # bridge가 요약 메시지를 만들 수 있도록 task_result 이벤트 전송
        await _send({
            "type": "task_result",
            "prompt": prompt,
            "duration_sec": round(duration, 1),
            "task_file": task_file,
            "success": True,
        })

        return result_text

    except asyncio.TimeoutError:
        try:
            exec_proc.kill()
        except Exception:
            pass
        return f"Error: Claude 실행 타임아웃 ({timeout}s)"
    except Exception as e:
        return f"Error: Claude 실행 실패 — {e}"


# ── Tool execution ─────────────────────────────────────────────────────────

async def run_tool(name: str, args: dict, workspace: "Path | None" = None) -> str:
    try:
        # ── File management ──
        if name == "list_files":
            p = expand(args["path"], workspace)
            if not p.exists():
                return f"Error: path does not exist: {p}"
            items = sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
            lines = []
            for item in items:
                tag = "FILE" if item.is_file() else " DIR"
                size = f" ({item.stat().st_size:,} B)" if item.is_file() else ""
                lines.append(f"[{tag}] {item.name}{size}")
            return "\n".join(lines) if lines else "(empty)"

        elif name == "read_file":
            p = expand(args["path"], workspace)
            if not p.exists():
                return f"Error: file not found: {p}"
            text = p.read_text(encoding="utf-8", errors="replace")
            if len(text) > 6000:
                text = text[:6000] + "\n\n... (truncated)"
            return text

        elif name == "write_file":
            p = expand(args["path"], workspace)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(args["content"], encoding="utf-8")
            return f"Wrote {len(args['content'])} chars to {p}"

        elif name == "delete_file":
            p = expand(args["path"], workspace)
            if not p.exists():
                return f"Error: not found: {p}"
            if p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
            return f"Deleted: {p}"

        elif name == "copy_file":
            src = expand(args["src"], workspace)
            dst = expand(args["dst"], workspace)
            if not src.exists():
                return f"Error: source not found: {src}"
            dst.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            return f"Copied {src} → {dst}"

        elif name == "move_file":
            src = expand(args["src"], workspace)
            dst = expand(args["dst"], workspace)
            if not src.exists():
                return f"Error: source not found: {src}"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            return f"Moved {src} → {dst}"

        # ── Web ──
        elif name == "web_search":
            try:
                from ddgs import DDGS
            except ImportError:
                from duckduckgo_search import DDGS
            query = args["query"]
            max_results = int(args.get("max_results", 5))
            results = list(DDGS().text(query, max_results=max_results))
            if not results:
                return "No results found."
            lines = []
            for i, r in enumerate(results, 1):
                lines.append(f"{i}. {r.get('title', '')}\n   {r.get('href', '')}\n   {r.get('body', '')[:200]}")
            return "\n\n".join(lines)

        elif name == "open_url":
            url = args["url"]
            if IS_WIN:
                os.startfile(url)
            elif IS_MAC:
                subprocess.Popen(["open", url])
            else:
                subprocess.Popen(["xdg-open", url])
            return f"Opened: {url}"

        elif name == "fetch_webpage":
            url = args["url"]
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                text = re.sub(r"<[^>]+>", " ", r.text)
                text = re.sub(r"\s+", " ", text).strip()
                if len(text) > 4000:
                    text = text[:4000] + "... (truncated)"
                return text

        # ── App finder ──
        elif name == "find_app":
            if not IS_MAC:
                return "find_app은 macOS에서만 지원됩니다."
            keyword = args["keyword"].strip()
            search_dirs = ["/Applications", str(Path.home() / "Applications"), "/System/Applications"]
            found = set()
            for d in search_dirs:
                proc = subprocess.run(
                    ["mdfind", "-name", keyword, "-onlyin", d],
                    capture_output=True, text=True, timeout=10,
                )
                for line in proc.stdout.splitlines():
                    line = line.strip()
                    if line.endswith(".app") and Path(line).exists():
                        found.add(line)
            # Spotlight 전체 인덱스에서도 추가 검색
            proc = subprocess.run(
                ["mdfind", f'kMDItemContentType == "com.apple.application-bundle" && kMDItemFSName == "*{keyword}*"'],
                capture_output=True, text=True, timeout=10,
            )
            for line in proc.stdout.splitlines():
                line = line.strip()
                if line.endswith(".app") and Path(line).exists():
                    found.add(line)
            if not found:
                return f"'{keyword}' 키워드로 앱을 찾지 못했습니다. 더 짧은 키워드로 다시 시도하세요."
            lines = [f"검색 결과 ({len(found)}개):"]
            for path in sorted(found):
                name_only = Path(path).stem
                lines.append(f"  이름: {name_only}\n  경로: {path}\n  실행: open '{path}'")
            return "\n".join(lines)

        # ── Screenshot ──
        elif name == "take_screenshot":
            note = args.get("note", "Screenshot")
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                tmp_path = f.name
            try:
                captured = False
                if IS_MAC:
                    # Try screencapture (needs Screen Recording permission)
                    proc = subprocess.run(
                        ["screencapture", "-x", tmp_path],
                        capture_output=True, timeout=10,
                    )
                    if proc.returncode == 0 and Path(tmp_path).stat().st_size > 0:
                        captured = True
                    else:
                        # Fallback: Pillow ImageGrab
                        try:
                            from PIL import ImageGrab
                            img = ImageGrab.grab()
                            img.save(tmp_path, "PNG")
                            captured = True
                        except Exception:
                            pass
                elif IS_WIN:
                    try:
                        from PIL import ImageGrab
                        img = ImageGrab.grab()
                        img.save(tmp_path, "PNG")
                        captured = True
                    except Exception:
                        script = (
                            "Add-Type -AssemblyName System.Windows.Forms;"
                            "Add-Type -AssemblyName System.Drawing;"
                            "$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"
                            "$b=New-Object System.Drawing.Bitmap $s.Width,$s.Height;"
                            "$g=[System.Drawing.Graphics]::FromImage($b);"
                            "$g.CopyFromScreen(0,0,0,0,$s.Size);"
                            f"$b.Save('{tmp_path}');"
                        )
                        proc = subprocess.run(
                            ["powershell", "-NoProfile", "-Command", script],
                            capture_output=True, timeout=15,
                        )
                        if proc.returncode == 0:
                            captured = True
                else:
                    # Linux: try scrot, then import
                    for cmd in [["scrot", tmp_path], ["import", "-window", "root", tmp_path]]:
                        if subprocess.run(cmd, capture_output=True, timeout=10).returncode == 0:
                            captured = True
                            break

                if not captured:
                    return "Error in take_screenshot: Screen recording permission denied. Grant Terminal screen recording access in System Preferences → Privacy & Security → Screen Recording."

                img_bytes = Path(tmp_path).read_bytes()
                b64 = base64.b64encode(img_bytes).decode()
                return json.dumps({"__type": "screenshot", "data": b64, "note": note})
            finally:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

        elif name == "list_chat_history":
            # ~/.ai_chats/ 와 ~/Downloads/ 모두 검색
            search_dirs = [CHAT_HISTORY_DIR, Path.home() / "Downloads"]
            files = []
            for d in search_dirs:
                files.extend(d.glob("chat_*.json"))
            files = sorted(set(files), key=lambda f: f.stat().st_mtime, reverse=True)
            if not files:
                return "저장된 대화 기록이 없습니다."
            lines = []
            for f in files[:20]:
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                    saved_at = data.get("saved_at", "")[:19].replace("T", " ")
                    msg_count = len(data.get("messages", []))
                    preview = next((
                        (m.get("content") or m.get("text") or "")[:40]
                        for m in data.get("messages", [])
                        if m.get("role") == "user"
                    ), "")
                    lines.append(f"{f.name}  [{saved_at}]  {msg_count}개 메시지  \"{preview}...\"  ({f.parent})")
                except Exception:
                    lines.append(str(f))
            return "\n".join(lines)

        elif name == "system_monitor":
            import psutil
            cpu = await asyncio.to_thread(psutil.cpu_percent, 1)
            mem = psutil.virtual_memory()
            disk = psutil.disk_usage("/")
            net = psutil.net_io_counters()
            boot = datetime.fromtimestamp(psutil.boot_time()).strftime("%Y-%m-%d %H:%M")
            lines = [
                f"🖥️  시스템 상태  ({datetime.now().strftime('%H:%M:%S')})",
                "",
                f"⚡ CPU      : {cpu:.1f}%  (코어 {psutil.cpu_count()}개)",
                f"🧠 메모리   : {mem.percent:.1f}%  ({mem.used/1024**3:.1f} / {mem.total/1024**3:.1f} GB)",
                f"💾 디스크   : {disk.percent:.1f}%  ({disk.used/1024**3:.1f} / {disk.total/1024**3:.1f} GB 사용)",
                f"🌐 네트워크 : ↑ {net.bytes_sent/1024**2:.1f} MB  ↓ {net.bytes_recv/1024**2:.1f} MB",
                f"🕐 부팅시간 : {boot}",
            ]
            battery = psutil.sensors_battery()
            if battery is not None:
                charging = "충전 중 🔌" if battery.power_plugged else "배터리 🔋"
                secs = battery.secsleft
                if secs > 0 and not battery.power_plugged:
                    h, m = divmod(secs // 60, 60)
                    remaining = f"  (잔여 {h}시간 {m}분)"
                else:
                    remaining = ""
                lines.append(f"🔋 배터리   : {battery.percent:.0f}%  {charging}{remaining}")
            return "\n".join(lines)

        elif name == "list_processes":
            import psutil
            keyword = (args.get("keyword") or "").lower()
            top = int(args.get("top", 20))
            procs = []
            for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_info", "status"]):
                try:
                    info = p.info
                    if keyword and keyword not in info["name"].lower():
                        continue
                    mem_mb = info["memory_info"].rss / 1024**2 if info["memory_info"] else 0
                    cpu_p = info["cpu_percent"] or 0.0
                    procs.append((cpu_p, info["pid"], info["name"], mem_mb, info["status"]))
                except Exception:
                    pass
            procs.sort(reverse=True)
            lines = [f"{'PID':>7}  {'CPU%':>6}  {'MEM(MB)':>8}  {'STATUS':>10}  NAME"]
            lines.append("-" * 55)
            for cpu_p, pid, pname, mem_mb, status in procs[:top]:
                lines.append(f"{pid:>7}  {cpu_p:>5.1f}%  {mem_mb:>7.1f}  {status:>10}  {pname}")
            return "\n".join(lines)

        elif name == "kill_process":
            import psutil
            pid = args.get("pid")
            pname = args.get("name", "")
            if pid:
                try:
                    p = psutil.Process(int(pid))
                    proc_name = p.name()  # terminate() 전에 이름 조회
                    p.terminate()
                    return f"프로세스 종료 신호 전송: PID={pid} ({proc_name})"
                except psutil.NoSuchProcess:
                    return f"PID {pid} 프로세스를 찾을 수 없습니다."
            elif pname:
                killed = []
                for p in psutil.process_iter(["pid", "name"]):
                    try:
                        if pname.lower() in p.info["name"].lower():
                            p.terminate()
                            killed.append(f"{p.info['name']} (PID={p.info['pid']})")
                    except Exception:
                        pass
                return f"종료 신호 전송: {', '.join(killed)}" if killed else f"'{pname}' 프로세스를 찾을 수 없습니다."
            return "pid 또는 name을 지정하세요."

        elif name == "schedule_task":
            tasks = _load_scheduled_tasks()
            task = {
                "id": str(uuid.uuid4())[:8],
                "name": args["name"],
                "schedule": args["schedule"],
                "type": args.get("type", "shell"),
                "command": args["command"],
                "workspace": args.get("workspace"),
                "enabled": True,
                "last_run": None,
                "created_at": datetime.now().isoformat(),
            }
            tasks.append(task)
            _save_scheduled_tasks(tasks)
            return f"예약 작업 등록 완료\nID: {task['id']}\n이름: {task['name']}\n일정: {task['schedule']}\n명령: {task['command'][:80]}"

        elif name == "list_scheduled_tasks":
            tasks = _load_scheduled_tasks()
            if not tasks:
                return "등록된 예약 작업이 없습니다."
            lines = []
            for t in tasks:
                status = "✅" if t.get("enabled", True) else "⏸️"
                last = (t.get("last_run") or "-")[:16].replace("T", " ")
                lines.append(f"{status} [{t['id']}] {t['name']}\n   일정: {t['schedule']} | 마지막: {last}\n   명령: {t['command'][:60]}")
            return "\n\n".join(lines)

        elif name == "cancel_scheduled_task":
            task_id = args["task_id"]
            tasks = _load_scheduled_tasks()
            for t in tasks:
                if t["id"] == task_id:
                    t["enabled"] = False
                    _save_scheduled_tasks(tasks)
                    return f"예약 작업 취소됨: {t['name']} ({task_id})"
            return f"ID '{task_id}' 작업을 찾을 수 없습니다."

        elif name == "list_claude_tasks":
            files = sorted(CLAUDE_TASK_DIR.glob("task_*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
            if not files:
                return "저장된 Claude 작업 이력이 없습니다."
            lines = []
            for f in files[:20]:
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                    ts = data.get("timestamp", "")[:19].replace("T", " ")
                    ws = data.get("workspace") or "-"
                    prompt_preview = data.get("prompt", "")[:50]
                    dur = data.get("duration_sec", 0)
                    lines.append(f"{f.name}  [{ts}]  {dur}s  ws={ws}  \"{prompt_preview}...\"")
                except Exception:
                    lines.append(str(f))
            return "\n".join(lines)

        elif name == "load_claude_task":
            fname = args["filename"].strip()
            if not fname.endswith(".json"):
                fname += ".json"
            path = CLAUDE_TASK_DIR / fname
            if not path.exists():
                return f"파일을 찾을 수 없습니다: {fname}"
            data = json.loads(path.read_text(encoding="utf-8"))
            return json.dumps(data, ensure_ascii=False, indent=2)

        elif name == "set_default_workspace":
            p = expand(args["path"])
            if not p.is_dir():
                return f"존재하지 않는 폴더: {p}"
            config = _load_agent_config()
            config["default_workspace"] = str(p)
            _save_agent_config(config)
            return f"기본 작업 디렉토리 저장됨: {p}"

        elif name == "load_chat_history":
            filename = args["filename"].strip()
            if not filename.endswith(".json"):
                filename += ".json"
            # 검색 순서: ~/.ai_chats/ → ~/Downloads/ → 절대경로
            search_dirs = [CHAT_HISTORY_DIR, Path.home() / "Downloads"]
            path = None
            for d in search_dirs:
                candidate = d / filename
                if candidate.exists():
                    path = candidate
                    break
            # 절대/상대 경로로 직접 지정한 경우
            if path is None:
                direct = Path(filename).expanduser()
                if direct.exists():
                    path = direct
            if path is None:
                return f"파일을 찾을 수 없습니다: {filename}\n검색 위치: {', '.join(str(d) for d in search_dirs)}"
            data = json.loads(path.read_text(encoding="utf-8"))
            raw_messages = data.get("messages", [])
            # content/text 필드 통일, 불필요한 필드 제거
            messages = []
            for m in raw_messages:
                role = m.get("role", "user")
                content = m.get("content") or m.get("text") or ""
                if role in ("user", "assistant") and content:
                    messages.append({"role": role, "content": content})
            return json.dumps({"__type": "load_history", "messages": messages, "saved_at": data.get("saved_at", ""), "filename": path.name})

        elif name == "send_file":
            p = expand(args["path"], workspace)
            if not p.exists() or not p.is_file():
                return f"Error: file not found: {p}"
            size = p.stat().st_size
            if size > 50 * 1024 * 1024:  # 50 MB hard limit
                return f"Error: file too large ({size / 1024 / 1024:.1f} MB). Use send_files_zipped with compression."
            data = p.read_bytes()
            b64 = base64.b64encode(data).decode()
            note = args.get("note") or f"{p.name} ({size / 1024:.1f} KB)"
            return json.dumps({"__type": "file_output", "data": b64, "filename": p.name, "note": note})

        elif name == "send_files_zipped":
            import zipfile, io
            paths = [expand(pp, workspace) for pp in args["paths"]]
            zip_name = (args.get("zip_name") or "archive.zip").strip()
            if not zip_name.endswith(".zip"):
                zip_name += ".zip"

            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for p in paths:
                    if not p.exists():
                        return f"Error: path not found: {p}"
                    if p.is_file():
                        zf.write(p, p.name)
                    else:
                        for child in p.rglob("*"):
                            if child.is_file():
                                zf.write(child, child.relative_to(p.parent))
            zip_bytes = buf.getvalue()
            if zip_bytes.__len__() > 50 * 1024 * 1024:
                return f"Error: compressed archive too large ({len(zip_bytes) / 1024 / 1024:.1f} MB)."
            b64 = base64.b64encode(zip_bytes).decode()
            note = args.get("note") or f"{zip_name} ({len(zip_bytes) / 1024:.1f} KB)"
            return json.dumps({"__type": "file_output", "data": b64, "filename": zip_name, "note": note})

        elif name == "capture_and_send":
            # Reuse take_screenshot logic, but mark as image_output so bridge sends to mobile
            screenshot_result = await run_tool("take_screenshot", {"note": args.get("note", "Screen capture")}, workspace)
            try:
                parsed = json.loads(screenshot_result)
                if parsed.get("__type") == "screenshot":
                    return json.dumps({
                        "__type": "image_output",
                        "data": parsed["data"],
                        "note": parsed.get("note", "Screen capture"),
                    })
            except Exception:
                pass
            return screenshot_result  # error string passthrough

        # ── System ──
        elif name == "execute_shell":
            cmd = args["command"]
            timeout = int(args.get("timeout", 30))
            cwd = str(workspace) if workspace else None
            if IS_WIN:
                proc = subprocess.run(
                    ["powershell", "-NoProfile", "-Command", cmd],
                    capture_output=True, text=True, timeout=timeout, cwd=cwd,
                )
            else:
                proc = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True, timeout=timeout, cwd=cwd,
                )
            out = (proc.stdout + proc.stderr).strip()
            if len(out) > 4000:
                out = out[:4000] + "... (truncated)"
            return out or "(no output)"

        elif name == "run_claude":
            prompt = args["prompt"]
            timeout = int(args.get("timeout", 300))
            cwd = str(workspace) if workspace else None
            claude_bin = shutil.which("claude") or "claude"
            proc = await asyncio.create_subprocess_exec(
                claude_bin, "--print", prompt,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            except asyncio.TimeoutError:
                proc.kill()
                return f"Error: claude timed out after {timeout}s"
            out = (stdout.decode(errors="replace") + stderr.decode(errors="replace")).strip()
            if len(out) > 6000:
                out = out[:6000] + "\n... (truncated)"
            return out or "(no output)"

        elif name == "mouse_move":
            import pyautogui
            pyautogui.moveTo(args["x"], args["y"], duration=0.2)
            return f"Mouse moved to ({args['x']}, {args['y']})"

        elif name == "mouse_click":
            x, y = args["x"], args["y"]
            button = args.get("button", "left")
            clicks = int(args.get("clicks", 1))
            if IS_MAC:
                btn_num = 1 if button == "left" else 2 if button == "right" else 3
                script = (
                    f'tell application "System Events"\n'
                    f'  set pos to {{{x}, {y}}}\n'
                )
                for _ in range(clicks):
                    script += f'  click at pos\n'
                script += 'end tell'
                subprocess.run(["osascript", "-e", script], capture_output=True)
            else:
                import pyautogui
                pyautogui.click(x, y, clicks=clicks, button=button, interval=0.1)
            return f"Clicked {button}×{clicks} at ({x}, {y})"

        elif name == "mouse_drag":
            import pyautogui
            pyautogui.moveTo(args["x1"], args["y1"], duration=0.2)
            pyautogui.dragTo(args["x2"], args["y2"], duration=0.4, button="left")
            return f"Dragged ({args['x1']},{args['y1']}) → ({args['x2']},{args['y2']})"

        elif name == "type_text":
            text = args["text"]
            if IS_MAC:
                # 1) pbcopy로 클립보드에 UTF-8 텍스트 설정
                subprocess.run(["pbcopy"], input=text.encode("utf-8"), capture_output=True)
                await asyncio.sleep(0.15)
                # 2) System Events로 Cmd+V 전송 — 포커스된 앱에 확실히 전달됨
                subprocess.run(
                    ["osascript", "-e",
                     'tell application "System Events" to keystroke "v" using command down'],
                    capture_output=True,
                )
            elif IS_WIN:
                subprocess.run(
                    ["powershell", "-NoProfile", "-Command",
                     "Add-Type -AssemblyName System.Windows.Forms; "
                     "[System.Windows.Forms.Clipboard]::SetText($input)"],
                    input=text, capture_output=True, text=True,
                )
                import pyautogui
                pyautogui.hotkey("ctrl", "v")
            else:
                subprocess.run(["xdotool", "type", "--clearmodifiers", text], capture_output=True)
            return f"Typed {len(text)} characters"

        elif name == "press_key":
            key = args["key"]
            presses = int(args.get("presses", 1))
            if IS_MAC:
                # 특수키는 key code, 일반 문자는 keystroke
                KEYCODE_MAP = {
                    "enter": 36, "return": 36,
                    "tab": 48, "space": 49,
                    "backspace": 51, "delete": 51,
                    "escape": 53,
                    "left": 123, "right": 124, "down": 125, "up": 126,
                    "home": 115, "end": 119,
                    "pageup": 116, "pagedown": 121,
                    "f1": 122, "f2": 120, "f3": 99, "f4": 118,
                    "f5": 96, "f6": 97, "f7": 98, "f8": 100,
                    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
                }
                k = key.lower()
                if k in KEYCODE_MAP:
                    stmt = f'key code {KEYCODE_MAP[k]}'
                else:
                    stmt = f'keystroke "{k}"'
                script = (
                    f'tell application "System Events"\n'
                    f'  repeat {presses} times\n'
                    f'    {stmt}\n'
                    f'  end repeat\n'
                    f'end tell'
                )
                subprocess.run(["osascript", "-e", script], capture_output=True)
            else:
                import pyautogui
                pyautogui.press(key, presses=presses)
            return f"Pressed '{key}' × {presses}"

        elif name == "hotkey":
            keys = args["keys"]
            if IS_MAC:
                MOD_MAP = {"cmd": "command down", "ctrl": "control down",
                           "shift": "shift down", "alt": "option down", "option": "option down"}
                mods = [MOD_MAP[k] for k in keys[:-1] if k in MOD_MAP]
                char = keys[-1]
                using = (", ".join(mods)) if mods else ""
                script = (
                    f'tell application "System Events" to keystroke "{char}"'
                    + (f' using {{{using}}}' if using else '')
                )
                subprocess.run(["osascript", "-e", script], capture_output=True)
            else:
                import pyautogui
                pyautogui.hotkey(*keys)
            return f"Hotkey: {' + '.join(keys)}"

        elif name == "control_app":
            script = args["script"]
            if IS_MAC:
                proc = subprocess.run(
                    ["osascript", "-e", script],
                    capture_output=True, text=True, timeout=15,
                )
            elif IS_WIN:
                proc = subprocess.run(
                    ["powershell", "-NoProfile", "-Command", script],
                    capture_output=True, text=True, timeout=15,
                )
            else:
                return "App control is only supported on macOS and Windows."
            out = (proc.stdout + proc.stderr).strip()
            return out or "OK"

        elif name == "run_python":
            code = args["code"]
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
                f.write(code)
                tmp_path = f.name
            try:
                proc = subprocess.run(
                    ["python3", tmp_path],
                    capture_output=True, text=True, timeout=60,
                    cwd=str(workspace) if workspace else None,
                )
                out = (proc.stdout + proc.stderr).strip()
                if len(out) > 4000:
                    out = out[:4000] + "... (truncated)"
                return out or "(no output)"
            finally:
                os.unlink(tmp_path)

        # ── Browser automation ──
        elif name == "browser_navigate":
            page = await browser.get_page()
            url = args["url"]
            wait_for = args.get("wait_for", "load")
            if wait_for in ("load", "networkidle", "domcontentloaded", "commit"):
                await page.goto(url, wait_until=wait_for, timeout=30000)
            else:
                await page.goto(url, timeout=30000)
                try:
                    await page.wait_for_selector(wait_for, timeout=10000)
                except Exception:
                    pass
            return f"Navigated to {url} — title: {await page.title()}"

        elif name == "browser_click":
            page = await browser.get_page()
            selector = args["selector"]
            await page.click(selector, timeout=10000)
            await page.wait_for_load_state("networkidle", timeout=5000)
            return f"Clicked: {selector}"

        elif name == "browser_fill":
            page = await browser.get_page()
            selector = args["selector"]
            value = args["value"]

            async def _js_fill(sel: str) -> bool:
                try:
                    await page.evaluate(
                        """([sel, val]) => {
                            const el = document.querySelector(sel);
                            if (!el) throw new Error('not found');
                            const desc = Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value');
                            if (desc) desc.set.call(el, val); else el.value = val;
                            el.dispatchEvent(new Event('input',  {bubbles: true}));
                            el.dispatchEvent(new Event('change', {bubbles: true}));
                        }""",
                        [sel, value],
                    )
                    return True
                except Exception:
                    return False

            # 1단계: 표준 fill
            try:
                await page.fill(selector, value, timeout=5000)
                return f"Filled '{selector}' with '{value}'"
            except Exception:
                pass

            # 2단계: click → keyboard type
            try:
                await page.click(selector, timeout=3000)
                await page.keyboard.select_all()
                await page.keyboard.type(value)
                return f"Typed into '{selector}': '{value}'"
            except Exception:
                pass

            # 3단계: JavaScript 직접 주입
            if await _js_fill(selector):
                return f"JS-filled '{selector}' with '{value}'"

            # 4단계: 퍼지 매칭 — title/placeholder 키워드로 실제 요소 자동 탐색
            try:
                # attribute selector에서 키워드 추출 (예: input[title='검색어 입력'] → 검색어)
                kw_match = re.search(r'\[(?:title|placeholder|name|id)[=~*^$|]*["\']([^"\']+)["\']', selector)
                keyword = kw_match.group(1) if kw_match else ""
                # keyword 첫 2글자로 유사 요소 찾기
                fuzzy_sel = await page.evaluate(
                    """([kw]) => {
                        const inputs = [...document.querySelectorAll('input,textarea')]
                            .filter(el => el.offsetParent !== null);
                        const kw2 = kw.slice(0, 2);
                        const match = inputs.find(el =>
                            (el.title && el.title.includes(kw2)) ||
                            (el.placeholder && el.placeholder.includes(kw2)) ||
                            (el.name && el.name.includes(kw2)) ||
                            (el.id && el.id.includes(kw2))
                        );
                        if (!match) return null;
                        if (match.id) return '#' + match.id;
                        if (match.name) return `[name="${match.name}"]`;
                        return null;
                    }""",
                    [keyword],
                )
                if fuzzy_sel:
                    if await _js_fill(fuzzy_sel):
                        return f"Auto-corrected selector '{selector}' → '{fuzzy_sel}', filled with '{value}'"
                    try:
                        await page.fill(fuzzy_sel, value, timeout=5000)
                        return f"Auto-corrected selector '{selector}' → '{fuzzy_sel}', filled with '{value}'"
                    except Exception:
                        pass
            except Exception:
                pass

            # 모두 실패 — 페이지의 visible input 목록 반환
            try:
                hints = await page.evaluate(
                    """() => [...document.querySelectorAll('input,textarea')]
                        .filter(el => el.offsetParent !== null)
                        .map(el => {
                            const a = [];
                            if (el.id)          a.push(`id="${el.id}"`);
                            if (el.name)        a.push(`name="${el.name}"`);
                            if (el.title)       a.push(`title="${el.title}"`);
                            if (el.placeholder) a.push(`placeholder="${el.placeholder}"`);
                            return `<${el.tagName.toLowerCase()} ${a.join(' ')}>`;
                        }).slice(0, 10).join('\\n')"""
                )
            except Exception:
                hints = "(unable to inspect page)"
            return (
                f"Error: selector '{selector}' not found.\n"
                f"Visible inputs on this page:\n{hints}\n"
                f"Use one of the above selectors and retry."
            )

        elif name == "browser_get_text":
            page = await browser.get_page()
            selector = args.get("selector", "")
            if selector:
                element = await page.query_selector(selector)
                if not element:
                    return f"Element not found: {selector}"
                text = await element.inner_text()
            else:
                text = await page.inner_text("body")
            text = re.sub(r"\s+", " ", text).strip()
            if len(text) > 4000:
                text = text[:4000] + "... (truncated)"
            return text

        elif name == "browser_close":
            await browser.close()
            return "Browser closed."

        elif name == "browser_eval":
            page = await browser.get_page()
            script = args["script"]
            result = await page.evaluate(script)
            out = str(result) if result is not None else "(null)"
            if len(out) > 4000:
                out = out[:4000] + "... (truncated)"
            return out

        elif name == "browser_screenshot":
            page = await browser.get_page()
            img_bytes = await page.screenshot(type="png")
            b64 = base64.b64encode(img_bytes).decode()
            return json.dumps({"__type": "screenshot", "data": b64, "note": "Browser screenshot"})

        else:
            return f"Unknown tool: {name}"

    except Exception as e:
        return f"Error in {name}: {e}"


# ── REST endpoints ─────────────────────────────────────────────────────────

@app.get("/status")
async def status():
    return {
        "status": "ok",
        "model": GEMINI_MODEL,
        "os": platform.system(),
        "tools": [t["function"]["name"] for t in TOOLS],
    }


@app.get("/automation_targets")
async def automation_targets():
    """Return list of automatable apps for pre-grant UI."""
    COMMON_APPS = [
        {"name": "Finder",    "script": 'tell application "Finder" to get name of startup disk'},
        {"name": "Safari",    "script": 'tell application "Safari" to get URL of current tab of window 1'},
        {"name": "Mail",      "script": 'tell application "Mail" to get name of first account'},
        {"name": "Calendar",  "script": 'tell application "Calendar" to get name of first calendar'},
        {"name": "Reminders", "script": 'tell application "Reminders" to get name of first list'},
        {"name": "Notes",     "script": 'tell application "Notes" to get name of first account'},
        {"name": "Music",     "script": 'tell application "Music" to get player state'},
        {"name": "Messages",  "script": 'tell application "Messages" to get name'},
        {"name": "System Events", "script": 'tell application "System Events" to get name of first process'},
    ]
    return {"apps": [a["name"] for a in COMMON_APPS]}


@app.post("/grant_automation")
async def grant_automation(payload: dict):
    """
    Trigger Automation permission dialog for a specific app.
    The user must click 'Allow' in the macOS dialog.
    Once allowed, macOS remembers it permanently.
    """
    if not IS_MAC:
        return {"error": "macOS only"}
    app_name = (payload.get("app") or "").strip()
    if not app_name:
        return {"error": "app name required"}

    SCRIPTS = {
        "Finder":       'tell application "Finder" to get name of startup disk',
        "Safari":       'tell application "Safari" to get name',
        "Mail":         'tell application "Mail" to get name',
        "Calendar":     'tell application "Calendar" to get name',
        "Reminders":    'tell application "Reminders" to get name',
        "Notes":        'tell application "Notes" to get name',
        "Music":        'tell application "Music" to get name',
        "Messages":     'tell application "Messages" to get name',
        "System Events":'tell application "System Events" to get name of first process',
    }
    script = SCRIPTS.get(app_name, f'tell application "{app_name}" to get name')
    proc = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode == 0:
        return {"status": "granted", "app": app_name}
    err = (proc.stderr or "").strip()
    if "not allowed" in err.lower() or "1743" in err:
        return {"status": "denied", "app": app_name, "message": "시스템 설정에서 직접 허용해 주세요."}
    # returncode != 0 but not a permission error → still triggered the dialog
    return {"status": "triggered", "app": app_name, "message": err}


@app.get("/browse")
async def browse(path: str = "~"):
    try:
        p = expand(path)
        if not p.is_dir():
            return {"error": f"Not a directory: {p}"}
        items = sorted(p.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        dirs = [{"name": item.name, "path": str(item)} for item in items if item.is_dir() and not item.name.startswith(".")]
        return {"path": str(p), "parent": str(p.parent), "dirs": dirs}
    except Exception as e:
        return {"error": str(e)}


@app.post("/mkdir")
async def mkdir(payload: dict):
    try:
        parent = payload.get("parent", "")
        name = (payload.get("name") or "").strip()
        if not parent or not name:
            return {"error": "parent와 name이 필요합니다."}
        if any(c in name for c in r'/\:*?"<>|'):
            return {"error": "폴더 이름에 사용할 수 없는 문자가 포함되어 있습니다."}
        new_dir = expand(parent) / name
        if new_dir.exists():
            return {"error": f"이미 존재합니다: {name}"}
        new_dir.mkdir(parents=False)
        return {"path": str(new_dir), "name": name}
    except Exception as e:
        return {"error": str(e)}


# ── WebSocket endpoint ─────────────────────────────────────────────────────

def _make_tool_result_msg(result: str, tool_name: str = "unknown") -> dict:
    """Convert tool result string to conversation message, handling screenshots."""
    try:
        parsed = json.loads(result)
        if isinstance(parsed, dict):
            t = parsed.get("__type")
            if t == "screenshot":
                return {"role": "tool", "name": tool_name, "content": parsed.get("note", "Screenshot"), "images": [parsed["data"]]}
            if t in ("file_output", "image_output"):
                note = parsed.get("note") or parsed.get("filename") or t
                return {"role": "tool", "name": tool_name, "content": f"Sent successfully: {note}"}
            if t == "load_history":
                # Inject history messages so AI has full context
                msgs = parsed.get("messages", [])
                saved_at = parsed.get("saved_at", "")[:19].replace("T", " ")
                summary = f"대화 기록 '{parsed.get('filename')}' 불러옴 ({saved_at}, {len(msgs)}개 메시지)"
                return {"role": "tool", "name": tool_name, "content": summary, "__inject": msgs}
    except (json.JSONDecodeError, KeyError):
        pass
    return {"role": "tool", "name": tool_name, "content": result}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    incoming: asyncio.Queue = asyncio.Queue()
    stop_event = asyncio.Event()

    async def recv_loop():
        try:
            while True:
                data = await websocket.receive_json()
                if data.get("type") == "stop":
                    stop_event.set()
                else:
                    await incoming.put(data)
        except Exception:
            await incoming.put(None)

    recv_task = asyncio.create_task(recv_loop())

    async def safe_send(payload: dict):
        """Send JSON, silently ignore errors if the connection is already closed."""
        try:
            await websocket.send_json(payload)
        except Exception:
            pass

    # config에 저장된 default_workspace 불러오기
    _cfg = _load_agent_config()
    _dws = _cfg.get("default_workspace")
    workspace: Path | None = Path(_dws) if _dws and Path(_dws).is_dir() else None
    guide: str | None = read_guide(workspace) if workspace else None
    conversation = [{"role": "system", "content": build_system_prompt(workspace, guide)}]

    try:
        while True:
            data = await incoming.get()
            if data is None:
                break

            if data.get("type") == "set_workspace":
                raw = (data.get("path") or "").strip()
                if not raw:
                    workspace = None
                    guide = None
                    conversation[0] = {"role": "system", "content": build_system_prompt(None, None)}
                    await safe_send({"type": "workspace_set", "path": None, "has_guide": False})
                else:
                    try:
                        p = expand(raw)
                        if not p.is_dir():
                            await safe_send({"type": "workspace_error", "message": f"존재하지 않는 폴더: {p}"})
                        else:
                            workspace = p
                            guide = read_guide(workspace)
                            conversation[0] = {"role": "system", "content": build_system_prompt(workspace, guide)}
                            await safe_send({
                                "type": "workspace_set",
                                "path": str(workspace),
                                "has_guide": guide is not None,
                            })
                    except Exception as e:
                        await safe_send({"type": "workspace_error", "message": str(e)})
                continue

            if data.get("type") == "clear_history":
                filename = None
                if len(conversation) > 1:  # system prompt 외 메시지가 있을 때만 저장
                    filename = _save_history(conversation)
                conversation = [{"role": "system", "content": build_system_prompt(workspace, guide)}]
                await safe_send({"type": "history_cleared", "saved_as": filename})
                continue

            if data.get("type") != "message":
                continue

            user_text = data.get("text", "").strip()
            user_images = data.get("images", [])
            if not user_text and not user_images:
                continue

            entry = {"role": "user", "content": user_text}
            if user_images:
                entry["images"] = user_images
            conversation.append(entry)

            # Agentic loop
            while True:
                # Stop 체크 — 루프 진입 시
                if stop_event.is_set():
                    stop_event.clear()
                    await safe_send({"type": "stopped", "message": "작업이 중단됐습니다."})
                    break

                full_content = ""
                tool_calls = []
                raw_model_content = None

                # LLM 추론 시작 알림
                await safe_send({"type": "thinking", "message": "요청 분석 중..."})

                try:
                    full_content, tool_calls, raw_model_content = await _call_gemini(conversation, websocket)
                except Exception as e:
                    await safe_send({"type": "error", "message": f"Gemini error: {e}"})
                    break

                # thinking 버블 제거 (텍스트 없이 tool_calls만 온 경우)
                await safe_send({"type": "thinking_done"})

                assistant_msg: dict = {"role": "assistant", "content": full_content}
                if tool_calls:
                    assistant_msg["tool_calls"] = tool_calls
                if raw_model_content is not None:
                    assistant_msg["gemini_content"] = raw_model_content
                conversation.append(assistant_msg)

                if not tool_calls:
                    await safe_send({"type": "done"})
                    break

                tool_results = []

                for step_num, tc in enumerate(tool_calls, 1):
                    fn = tc.get("function", {})
                    tool_name = fn.get("name", "")
                    tool_args = fn.get("arguments") or {}
                    tool_id = tc.get("id") or tool_name
                    risk = get_risk(tool_name, tool_args, workspace)
                    print(f"[ws] tool_call: {tool_name} | risk={risk} | args={json.dumps(tool_args, ensure_ascii=False)[:120]}")
                    icon, msg = TOOL_MESSAGES.get(tool_name, ("⚙️", "처리 중"))

                    await safe_send({
                        "type": "tool_start",
                        "id": tool_id,
                        "name": tool_name,
                        "args": tool_args,
                        "risk": risk,
                    })
                    # Initial progress event
                    await safe_send({
                        "type": "progress",
                        "step": step_num,
                        "tool": tool_name,
                        "icon": icon,
                        "message": msg + "...",
                    })

                    if risk == "high":
                        await safe_send({
                            "type": "confirm_request",
                            "id": tool_id,
                            "name": tool_name,
                            "args": tool_args,
                        })
                        approved = False
                        pending = []
                        try:
                            deadline = asyncio.get_event_loop().time() + 120
                            while True:
                                remaining = deadline - asyncio.get_event_loop().time()
                                if remaining <= 0:
                                    break
                                try:
                                    confirm_data = await asyncio.wait_for(incoming.get(), timeout=remaining)
                                except asyncio.TimeoutError:
                                    break
                                if confirm_data is None:
                                    await incoming.put(None)
                                    break
                                if confirm_data.get("type") == "confirm" and confirm_data.get("tool_call_id") == tool_id:
                                    approved = confirm_data.get("approved", False)
                                    break
                                pending.append(confirm_data)
                        finally:
                            for msg in pending:
                                await incoming.put(msg)

                        if not approved:
                            result = "Cancelled by user."
                            await safe_send({"type": "tool_result", "id": tool_id, "name": tool_name, "result": result, "success": False})
                            tool_results.append({"role": "tool", "name": tool_name, "content": result})
                            continue

                    # Stop 체크 — 도구 실행 직전
                    if stop_event.is_set():
                        stop_event.clear()
                        await safe_send({"type": "stopped", "message": "작업이 중단됐습니다."})
                        tool_results = None  # 루프 탈출 신호
                        break

                    # run_claude → 2단계 실행 (계획 확인 → 실행)
                    if tool_name == "run_claude":
                        result = await run_claude_sdk(
                            tool_args.get("prompt", ""),
                            tool_id,
                            workspace, websocket, incoming, stop_event,
                            int(tool_args.get("timeout", 300)),
                        )
                    # Run tool — long-running ones get heartbeat + stop cancellation
                    elif tool_name in LONG_RUNNING_TOOLS:
                        tool_task = asyncio.create_task(run_tool(tool_name, tool_args, workspace))
                        hb_task = asyncio.create_task(_heartbeat(websocket, tool_name, step_num))
                        try:
                            done, _ = await asyncio.wait(
                                [tool_task, asyncio.create_task(stop_event.wait())],
                                return_when=asyncio.FIRST_COMPLETED,
                            )
                            if stop_event.is_set():
                                tool_task.cancel()
                                stop_event.clear()
                                await safe_send({"type": "stopped", "message": "작업이 중단됐습니다."})
                                tool_results = None
                            else:
                                result = tool_task.result()
                        finally:
                            hb_task.cancel()
                        if tool_results is None:
                            break
                    else:
                        result = await run_tool(tool_name, tool_args, workspace)

                    # Build the event sent to the frontend — strip raw image data, send separately
                    try:
                        parsed_result = json.loads(result)
                        rtype = parsed_result.get("__type") if isinstance(parsed_result, dict) else None
                        if rtype == "file_output":
                            await safe_send({
                                "type": "file_output",
                                "data": parsed_result["data"],
                                "filename": parsed_result.get("filename", "file"),
                                "note": parsed_result.get("note", ""),
                            })
                            await safe_send({
                                "type": "tool_result",
                                "id": tool_id,
                                "name": tool_name,
                                "result": parsed_result.get("note", "File sent"),
                                "success": True,
                            })
                        elif rtype == "image_output":
                            # Send image to frontend AND signal bridge to deliver to mobile chat
                            await safe_send({
                                "type": "image_output",
                                "data": parsed_result["data"],
                                "note": parsed_result.get("note", "Screen capture"),
                            })
                            await safe_send({
                                "type": "tool_result",
                                "id": tool_id,
                                "name": tool_name,
                                "result": parsed_result.get("note", "Screen capture"),
                                "image": parsed_result["data"],
                                "success": True,
                            })
                        elif rtype == "screenshot":
                            await safe_send({
                                "type": "tool_result",
                                "id": tool_id,
                                "name": tool_name,
                                "result": parsed_result.get("note", "Screenshot captured"),
                                "image": parsed_result["data"],
                                "success": True,
                            })
                        else:
                            await safe_send({"type": "tool_result", "id": tool_id, "name": tool_name, "result": result, "success": True})
                    except (json.JSONDecodeError, KeyError):
                        await safe_send({"type": "tool_result", "id": tool_id, "name": tool_name, "result": result, "success": True})

                    tool_results.append(_make_tool_result_msg(result, tool_name))

                if tool_results is None:
                    break  # stop 신호로 인한 중단

                # load_history 결과가 있으면 system prompt 바로 뒤에 히스토리 주입
                injected = []
                plain_results = []
                for tr in tool_results:
                    inject = tr.pop("__inject", None)
                    if inject:
                        injected = inject
                    plain_results.append(tr)
                if injected:
                    conversation[1:1] = injected  # system prompt 다음에 삽입
                conversation.extend(plain_results)

    except WebSocketDisconnect:
        pass
    finally:
        recv_task.cancel()
        await browser.close()


if __name__ == "__main__":
    import uvicorn
    ssl_cert = os.environ.get("SSL_CERT")
    ssl_key = os.environ.get("SSL_KEY")
    uvicorn.run(
        app, host="127.0.0.1", port=3001, log_level="info",
        ssl_certfile=ssl_cert or None,
        ssl_keyfile=ssl_key or None,
        ws_max_size=64 * 1024 * 1024,  # 64MB — large enough for file transfers
    )
