@echo off
setlocal
set "HOME_DIR=%LOCALAPPDATA%\hermes"
"%HOME_DIR%\hermes-agent\venv\Scripts\python.exe" "%HOME_DIR%\patches\turn-alerts\repair.py" %*
echo.
pause
