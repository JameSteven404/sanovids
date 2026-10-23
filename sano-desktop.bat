@echo off
rem SANO desktop - mo app SANO, khu "Dung phim" la SanoVids ban desktop (cong canvasapp). Xem docs\SANO-DESKTOP.md
rem Chay SANO truoc (mac dinh http://127.0.0.1:5173) va dong SanoVids dang mo. Dia chi khac: sano-desktop.bat https://...
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai thu vien lan dau...
  call npm install
  if errorlevel 1 goto :fail
)
set "SANO_URL=%~1"
if "%SANO_URL%"=="" set "SANO_URL=http://127.0.0.1:5173"
echo Mo SANO tai "%SANO_URL%" ...
call npm run desktop
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo Co loi, xem thong bao phia tren.
pause
exit /b 1
