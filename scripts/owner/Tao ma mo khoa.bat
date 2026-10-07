@echo off
rem SanoVids - tao mot ma mo khoa (SV1-...) cho mot ma may, dung mot lan.
chcp 65001 >nul
node "%~dp0mo-khoa.mjs" tao-ma
pause
