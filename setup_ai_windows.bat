@echo off
REM AstroVital: offline AstroAI ni bir marta o'rnatish (Internet kerak, ~10 GB).
cd /d "%~dp0"
call run_windows.bat --setup-ai
echo.
echo [AstroVital] Tugadi. Oynani yopish uchun istalgan tugmani bosing.
pause
