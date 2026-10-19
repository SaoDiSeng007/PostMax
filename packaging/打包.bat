@echo off
rem Entry point. All logic lives in packaging.ps1 (UTF-8, safe in editors).
rem Do not put Chinese text in this file. A .bat with Chinese must be saved as GBK
rem to be parsed correctly by cmd, and that makes it unreadable in modern editors.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging.ps1" %*
exit /b %ERRORLEVEL%
