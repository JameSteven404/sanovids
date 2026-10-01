@echo off
rem Ban Dung Phim - che do phat trien (tu tai lai khi sua code).
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai thu vien lan dau...
  call npm install
  if errorlevel 1 goto :fail
)
call npm run dev -- --open
goto :eof

:fail
echo.
echo Co loi, xem thong bao phia tren.
pause
exit /b 1
