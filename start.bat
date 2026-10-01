@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai thu vien lan dau...
  call npm install
)
start "" http://localhost:5180
call npm run dev
