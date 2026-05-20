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
from pathlib import Path

import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = None
    if os.environ.get("SUPABASE_SERVICE_KEY"):
        from agent_bridge import poll_loop
        task = asyncio.create_task(poll_loop())
        print("[server] AI Friend Bridge 시작됨")
    else:
        print("[server] SUPABASE_SERVICE_KEY 없음 — AI Friend Bridge 비활성")
    yield
    if task:
        task.cancel()


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
            for img_b64 in msg.get("images", []):
                parts.append({"inline_data": {"mime_type": "image/png", "data": img_b64}})
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
                await websocket.send_json({"type": "thinking_done"})
                await websocket.send_json({"type": "text", "text": full_text})

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
                    "command": {"type": "string", "description": "Command to execute"}
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
}


async def _heartbeat(websocket: WebSocket, tool_name: str, step: int):
    """Send animated progress dots every 1.5 s while a long-running tool is executing."""
    icon, base = TOOL_MESSAGES.get(tool_name, ("⚙️", "처리 중"))
    dots = 0
    try:
        while True:
            await asyncio.sleep(1.5)
            dots = (dots % 3) + 1
            await websocket.send_json({
                "type": "progress",
                "step": step,
                "tool": tool_name,
                "icon": icon,
                "message": base + " " + "·" * dots,
            })
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
        "- After taking a screenshot or browser_screenshot, describe what you see in detail."
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

        # ── System ──
        elif name == "execute_shell":
            cmd = args["command"]
            cwd = str(workspace) if workspace else None
            if IS_WIN:
                proc = subprocess.run(
                    ["powershell", "-NoProfile", "-Command", cmd],
                    capture_output=True, text=True, timeout=30, cwd=cwd,
                )
            else:
                proc = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True, timeout=30, cwd=cwd,
                )
            out = (proc.stdout + proc.stderr).strip()
            if len(out) > 4000:
                out = out[:4000] + "... (truncated)"
            return out or "(no output)"

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
        if isinstance(parsed, dict) and parsed.get("__type") == "screenshot":
            return {"role": "tool", "name": tool_name, "content": parsed.get("note", "Screenshot"), "images": [parsed["data"]]}
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

    workspace: Path | None = None
    guide: str | None = None
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
                    await websocket.send_json({"type": "workspace_set", "path": None, "has_guide": False})
                else:
                    try:
                        p = expand(raw)
                        if not p.is_dir():
                            await websocket.send_json({"type": "workspace_error", "message": f"존재하지 않는 폴더: {p}"})
                        else:
                            workspace = p
                            guide = read_guide(workspace)
                            conversation[0] = {"role": "system", "content": build_system_prompt(workspace, guide)}
                            await websocket.send_json({
                                "type": "workspace_set",
                                "path": str(workspace),
                                "has_guide": guide is not None,
                            })
                    except Exception as e:
                        await websocket.send_json({"type": "workspace_error", "message": str(e)})
                continue

            if data.get("type") != "message":
                continue

            user_text = data.get("text", "").strip()
            if not user_text:
                continue

            conversation.append({"role": "user", "content": user_text})

            # Agentic loop
            while True:
                # Stop 체크 — 루프 진입 시
                if stop_event.is_set():
                    stop_event.clear()
                    await websocket.send_json({"type": "stopped", "message": "작업이 중단됐습니다."})
                    break

                full_content = ""
                tool_calls = []
                raw_model_content = None

                # LLM 추론 시작 알림
                await websocket.send_json({"type": "thinking", "message": "요청 분석 중..."})

                try:
                    full_content, tool_calls, raw_model_content = await _call_gemini(conversation, websocket)
                except Exception as e:
                    await websocket.send_json({"type": "error", "message": f"Gemini error: {e}"})
                    break

                # thinking 버블 제거 (텍스트 없이 tool_calls만 온 경우)
                await websocket.send_json({"type": "thinking_done"})

                assistant_msg: dict = {"role": "assistant", "content": full_content}
                if tool_calls:
                    assistant_msg["tool_calls"] = tool_calls
                if raw_model_content is not None:
                    assistant_msg["gemini_content"] = raw_model_content
                conversation.append(assistant_msg)

                if not tool_calls:
                    await websocket.send_json({"type": "done"})
                    break

                tool_results = []

                for step_num, tc in enumerate(tool_calls, 1):
                    fn = tc.get("function", {})
                    tool_name = fn.get("name", "")
                    tool_args = fn.get("arguments") or {}
                    tool_id = tc.get("id") or tool_name
                    risk = get_risk(tool_name, tool_args, workspace)
                    icon, msg = TOOL_MESSAGES.get(tool_name, ("⚙️", "처리 중"))

                    await websocket.send_json({
                        "type": "tool_start",
                        "id": tool_id,
                        "name": tool_name,
                        "args": tool_args,
                        "risk": risk,
                    })
                    # Initial progress event
                    await websocket.send_json({
                        "type": "progress",
                        "step": step_num,
                        "tool": tool_name,
                        "icon": icon,
                        "message": msg + "...",
                    })

                    if risk == "high":
                        await websocket.send_json({
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
                            await websocket.send_json({"type": "tool_result", "id": tool_id, "name": tool_name, "result": result, "success": False})
                            tool_results.append({"role": "tool", "name": tool_name, "content": result})
                            continue

                    # Stop 체크 — 도구 실행 직전
                    if stop_event.is_set():
                        stop_event.clear()
                        await websocket.send_json({"type": "stopped", "message": "작업이 중단됐습니다."})
                        tool_results = None  # 루프 탈출 신호
                        break

                    # Run tool — long-running ones get heartbeat + stop cancellation
                    if tool_name in LONG_RUNNING_TOOLS:
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
                                await websocket.send_json({"type": "stopped", "message": "작업이 중단됐습니다."})
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
                        if isinstance(parsed_result, dict) and parsed_result.get("__type") == "screenshot":
                            await websocket.send_json({
                                "type": "tool_result",
                                "id": tool_id,
                                "name": tool_name,
                                "result": parsed_result.get("note", "Screenshot captured"),
                                "image": parsed_result["data"],  # frontend can render this
                                "success": True,
                            })
                        else:
                            await websocket.send_json({"type": "tool_result", "id": tool_id, "name": tool_name, "result": result, "success": True})
                    except (json.JSONDecodeError, KeyError):
                        await websocket.send_json({"type": "tool_result", "id": tool_id, "name": tool_name, "result": result, "success": True})

                    tool_results.append(_make_tool_result_msg(result, tool_name))

                if tool_results is None:
                    break  # stop 신호로 인한 중단
                conversation.extend(tool_results)

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
    )
