@echo off
rem SanoVids - tao khoa mo khoa che do Phat trien (chi chay mot lan, tren may chinh cua chu ung dung).
chcp 65001 >nul
node "%~dp0mo-khoa.mjs" tao-khoa
pause
