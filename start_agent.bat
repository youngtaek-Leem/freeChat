@echo off
REM AI Agent Server 시작 스크립트 (Windows)
REM
REM 기본 모델: gemma4:31b-cloud
REM 모델 변경: set OLLAMA_MODEL=gemma4:e4b && start_agent.bat

cd /d "%~dp0"

REM Python 가상환경 확인 및 생성
if not exist ".venv" (
    echo 가상환경 생성 중...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

REM 패키지 설치
pip install -q -r requirements.txt

REM Ollama 실행 여부 확인
curl -s http://localhost:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo Ollama가 실행되지 않고 있습니다. 시작합니다...
    start /B ollama serve
    timeout /t 3 /nobreak >nul
)

REM 사용 모델 표시
if "%OLLAMA_MODEL%"=="" (
    set OLLAMA_MODEL=gemma4:31b-cloud
)

echo.
echo AI Agent 서버 시작: http://localhost:3001
echo 사용 모델: %OLLAMA_MODEL%
echo 종료하려면 Ctrl+C
echo.

python agent_server.py
