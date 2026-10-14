@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在启动 PostMax...
python run.py

if errorlevel 1 (
    echo.
    echo 启动失败，请检查是否已安装 Python 以及依赖（pip install -r requirements.txt）。
    pause
)
