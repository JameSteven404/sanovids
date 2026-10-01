@echo off
rem SanoVids - chay ban build (nhanh). Lan dau se tu cai thu vien va build.
rem Sau khi sua code / cap nhat: chay "npm run build" (hoac xoa thu muc dist) roi mo lai file nay.
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai thu vien lan dau...
  call npm install
  if errorlevel 1 goto :fail
)
if not exist dist\index.html (
  echo Dang build ung dung lan dau...
  call npm run build
  if errorlevel 1 goto :fail
)
echo Mo http://localhost:5180 ...
call npx vite preview --port 5180 --strictPort --open
goto :eof

:fail
echo.
echo Co loi, xem thong bao phia tren.
pause
exit /b 1
