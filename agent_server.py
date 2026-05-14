"""
AI Agent Server — FastAPI + WebSocket + Ollama (gemma4:e4b)
Cross-platform: macOS (AppleScript) / Windows (PowerShell)

Run: python agent_server.py
"""
import asyncio
import json
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:31b-cloud")
IS_MAC = platform.system() == "Darwin"
IS_WIN = platform.system() == "Windows"

TOOLS = [
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
                "Control an application. "
                "On macOS use AppleScript syntax. "
                "On Windows use PowerShell syntax. "
                "Example macOS: 'tell application \"Safari\" to open location \"https://example.com\"'. "
                "Example Windows: 'Start-Process chrome \"https://example.com\"'."
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
]

# low = auto execute, medium = auto execute with preview, high = require user confirmation
RISK = {
    "list_files": "low",
    "read_file": "low",
    "fetch_webpage": "low",
    "open_url": "low",
    "write_file": "medium",
    "control_app": "medium",
    "execute_shell": "high",
    "delete_file": "high",
}


def get_risk(tool_name: str, args: dict, workspace: "Path | None") -> str:
    """Within workspace, file ops are auto-approved (no confirmation)."""
    base = RISK.get(tool_name, "medium")
    if workspace and tool_name in ("write_file", "delete_file", "read_file", "list_files"):
        try:
            path = expand(args.get("path", ""), workspace)
            if str(path).startswith(str(workspace)):
                return "low"
        except Exception:
            pass
    return base


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
        f"You are a helpful AI assistant running on {platform.system()}. "
        "You have tools to manage files, browse the web, control applications, and run code. "
        "Always briefly explain what you plan to do before calling a tool. "
        "Respond in the same language the user writes in."
    )
    if workspace:
        base += (
            f"\n\nWorkspace: {workspace}\n"
            "This is the designated working directory. "
            "Prefer to read, write, and execute code within this folder. "
            "You have full access to all files and subfolders inside it."
        )
    if guide:
        base += (
            f"\n\n---\n## Project Guidelines (Guide.md)\n\n{guide}\n---\n\n"
            "You MUST strictly follow the above guidelines for ALL tasks in this workspace. "
            "These rules take priority over your default behavior."
        )
    return base


def expand(path: str, workspace: "Path | None" = None) -> Path:
    """Resolve path. Relative paths are resolved against workspace if set."""
    p = Path(path).expanduser()
    if not p.is_absolute() and workspace:
        return (workspace / p).resolve()
    return p.resolve()


async def run_tool(name: str, args: dict, workspace: "Path | None" = None) -> str:
    try:
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

        else:
            return f"Unknown tool: {name}"

    except Exception as e:
        return f"Error in {name}: {e}"


@app.get("/status")
async def status():
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            models = [m["name"] for m in r.json().get("models", [])]
            available = any(MODEL.split(":")[0] in m for m in models)
            return {"status": "ok", "model": MODEL, "model_available": available, "os": platform.system()}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/browse")
async def browse(path: str = "~"):
    """Return directory listing for the workspace picker."""
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
    """Create a new directory."""
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


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()

    incoming: asyncio.Queue = asyncio.Queue()

    async def recv_loop():
        try:
            while True:
                data = await websocket.receive_json()
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

            # ── Workspace 설정 ──────────────────────────────────────────
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

            # Agentic loop — keeps calling Ollama until no more tool calls
            while True:
                full_content = ""
                tool_calls = []
                try:
                    async with httpx.AsyncClient(timeout=180) as client:
                        async with client.stream(
                            "POST",
                            f"{OLLAMA_URL}/api/chat",
                            json={"model": MODEL, "messages": conversation, "tools": TOOLS, "stream": True},
                        ) as r:
                            async for line in r.aiter_lines():
                                if not line.strip():
                                    continue
                                try:
                                    chunk = json.loads(line)
                                except json.JSONDecodeError:
                                    continue
                                msg = chunk.get("message") or {}
                                piece = msg.get("content") or ""
                                if piece:
                                    full_content += piece
                                    await websocket.send_json({"type": "text", "text": piece})
                                # tool_calls can appear in any chunk (Ollama version-dependent)
                                if msg.get("tool_calls"):
                                    tool_calls = msg["tool_calls"]
                                if chunk.get("done"):
                                    break

                    # Fallback: if streaming gave no tool_calls, retry with stream:False
                    if not tool_calls and not full_content:
                        async with httpx.AsyncClient(timeout=180) as client:
                            r2 = await client.post(
                                f"{OLLAMA_URL}/api/chat",
                                json={"model": MODEL, "messages": conversation, "tools": TOOLS, "stream": False},
                            )
                            resp = r2.json()
                            msg2 = resp.get("message") or {}
                            tool_calls = msg2.get("tool_calls") or []
                            full_content = (msg2.get("content") or "").strip()
                            if full_content:
                                await websocket.send_json({"type": "text", "text": full_content})

                except Exception as e:
                    await websocket.send_json({"type": "error", "message": f"Ollama error: {e}"})
                    break

                assistant_msg: dict = {"role": "assistant", "content": full_content}
                if tool_calls:
                    assistant_msg["tool_calls"] = tool_calls
                conversation.append(assistant_msg)

                if not tool_calls:
                    await websocket.send_json({"type": "done"})
                    break

                tool_results = []

                for tc in tool_calls:
                    fn = tc.get("function", {})
                    tool_name = fn.get("name", "")
                    tool_args = fn.get("arguments") or {}
                    tool_id = tc.get("id") or tool_name
                    risk = get_risk(tool_name, tool_args, workspace)

                    await websocket.send_json({
                        "type": "tool_start",
                        "id": tool_id,
                        "name": tool_name,
                        "args": tool_args,
                        "risk": risk,
                    })

                    # High-risk tools require explicit user approval
                    if risk == "high":
                        await websocket.send_json({
                            "type": "confirm_request",
                            "id": tool_id,
                            "name": tool_name,
                            "args": tool_args,
                        })
                        # Wait for confirm response (ignore unrelated messages)
                        approved = False
                        while True:
                            confirm_data = await incoming.get()
                            if confirm_data is None:
                                break
                            if confirm_data.get("type") == "confirm" and confirm_data.get("tool_call_id") == tool_id:
                                approved = confirm_data.get("approved", False)
                                break

                        if not approved:
                            result = "Cancelled by user."
                            await websocket.send_json({"type": "tool_result", "id": tool_id, "name": tool_name, "result": result, "success": False})
                            tool_results.append({"role": "tool", "content": result})
                            continue

                    result = await run_tool(tool_name, tool_args, workspace)
                    await websocket.send_json({"type": "tool_result", "id": tool_id, "name": tool_name, "result": result, "success": True})
                    tool_results.append({"role": "tool", "content": result})

                conversation.extend(tool_results)

    except WebSocketDisconnect:
        pass
    finally:
        recv_task.cancel()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=3001, log_level="info")
