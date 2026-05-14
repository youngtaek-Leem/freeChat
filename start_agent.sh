#!/bin/bash
# AI Agent + React 통합 시작 스크립트 (macOS / Linux)
#
# 기본 모델: gemma4:31b-cloud
# 모델 변경: OLLAMA_MODEL=gemma4:e4b ./start_agent.sh
# Agent 서버만 시작: AGENT_ONLY=1 ./start_agent.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Python 가상환경 확인 및 생성
if [ ! -d ".venv" ]; then
  echo "가상환경 생성 중..."
  python3 -m venv .venv
fi

source .venv/bin/activate

# 패키지 설치
pip install -q -r requirements.txt

# Ollama 실행 여부 확인
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "Ollama가 실행되지 않고 있습니다. 시작합니다..."
  ollama serve &
  sleep 3
fi

OLLAMA_MODEL="${OLLAMA_MODEL:-gemma4:31b-cloud}"

echo ""
echo "AI Agent 서버 시작: http://localhost:3001"
echo "사용 모델: $OLLAMA_MODEL"
echo "종료하려면 Ctrl+C"
echo ""

export OLLAMA_MODEL

# Agent 서버 백그라운드 실행
python3 agent_server.py &
AGENT_PID=$!

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

# Ctrl+C 시 두 프로세스 모두 종료
trap "kill $AGENT_PID $VITE_PID 2>/dev/null; exit" INT TERM

wait $AGENT_PID
