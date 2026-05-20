#!/bin/bash
# AI Agent + React 통합 시작 스크립트 (macOS / Linux)
#
# 기본 모델: gemini-2.0-flash
# 모델 변경: GEMINI_MODEL=gemini-1.5-pro ./start_agent.sh
# Agent 서버만 시작: AGENT_ONLY=1 ./start_agent.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# GEMINI_API_KEY 확인
if [ -z "$GEMINI_API_KEY" ]; then
  echo "⚠️  GEMINI_API_KEY 환경변수가 설정되지 않았습니다."
  echo "   export GEMINI_API_KEY=your_api_key_here"
  echo "   또는 ~/.zshrc 에 추가하세요."
  exit 1
fi

# Python 가상환경 확인 및 생성
if [ ! -d ".venv" ]; then
  echo "가상환경 생성 중..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# 패키지 설치 (venv의 pip 경로를 명시해 올바른 환경에 설치)
"$SCRIPT_DIR/.venv/bin/pip" install -q -r requirements.txt

# Playwright 브라우저 바이너리 설치 (최초 1회)
if ! "$SCRIPT_DIR/.venv/bin/python3" -c "from playwright.sync_api import sync_playwright" 2>/dev/null; then
  echo "Playwright 브라우저 설치 중..."
  "$SCRIPT_DIR/.venv/bin/python3" -m playwright install chromium
fi

GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.1-flash-lite}"

# SSL 인증서 자동 탐색 (mkcert로 생성된 localhost.pem)
SSL_CERT="${SSL_CERT:-$SCRIPT_DIR/localhost.pem}"
SSL_KEY="${SSL_KEY:-$SCRIPT_DIR/localhost-key.pem}"

if [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
  PROTOCOL="https"
  export SSL_CERT SSL_KEY
else
  PROTOCOL="http"
  unset SSL_CERT SSL_KEY
fi

echo ""
echo "AI Agent 서버 시작: ${PROTOCOL}://localhost:3001"
echo "사용 모델: $GEMINI_MODEL"
echo "종료하려면 Ctrl+C"
echo ""

export GEMINI_API_KEY
export GEMINI_MODEL

# Agent 서버 백그라운드 실행 (venv python 명시)
"$SCRIPT_DIR/.venv/bin/python3" agent_server.py &
AGENT_PID=$!

# Agent Bridge 실행 (SUPABASE_SERVICE_KEY 있을 때만)
BRIDGE_PID=""
if [ -n "$SUPABASE_SERVICE_KEY" ]; then
  export SUPABASE_SERVICE_KEY
  sleep 2  # agent_server 먼저 시작 대기
  "$SCRIPT_DIR/.venv/bin/python3" agent_bridge.py &
  BRIDGE_PID=$!
  echo "AI Friend Bridge 시작됨"
else
  echo "⚠️  SUPABASE_SERVICE_KEY 미설정 — AI Friend Bridge 비활성"
fi

# React dev 서버 실행 (AGENT_ONLY=1 이면 생략)
if [ -z "$AGENT_ONLY" ] && [ -d "$SCRIPT_DIR/message" ]; then
  echo "React dev 서버 시작: http://localhost:5173"
  echo ""
  cd "$SCRIPT_DIR/message"
  if [ ! -d "node_modules" ]; then
    echo "패키지 설치 중..."
    npm install --silent
  fi
  npm run dev &
  VITE_PID=$!
  cd "$SCRIPT_DIR"
fi

# Ctrl+C 시 모든 프로세스 종료
trap "kill $AGENT_PID $BRIDGE_PID $VITE_PID 2>/dev/null; exit" INT TERM

wait $AGENT_PID
