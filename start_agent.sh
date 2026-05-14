#!/bin/bash
# AI Agent Server 시작 스크립트 (macOS / Linux)
#
# 기본 모델: gemma4:31b-cloud
# 모델 변경: OLLAMA_MODEL=gemma4:e4b ./start_agent.sh

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

# 사용 모델 표시
OLLAMA_MODEL="${OLLAMA_MODEL:-gemma4:31b-cloud}"

echo ""
echo "AI Agent 서버 시작: http://localhost:3001"
echo "사용 모델: $OLLAMA_MODEL"
echo "종료하려면 Ctrl+C"
echo ""

export OLLAMA_MODEL
python3 agent_server.py
