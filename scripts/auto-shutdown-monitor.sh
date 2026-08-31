#!/bin/bash
# 监控 fetch 进程，完成后关机；最晚 05:00 强制中断
DEADLINE=$(date -d "05:00" +%s 2>/dev/null || date -d "today 05:00" +%s)
CHECK_INTERVAL=30

echo "[Monitor] Started at $(date). Deadline: 05:00"

while true; do
  NOW=$(date +%s)
  
  # 检查是否到了 deadline
  if [ "$NOW" -ge "$DEADLINE" ]; then
    echo "[Monitor] Deadline reached (05:00). Safely stopping..."
    # 给进程 10 秒保存进度
    taskkill //PID 18972 //F 2>/dev/null
    sleep 5
    echo "[Monitor] Process killed. Shutting down in 120s (cancel: shutdown /a)"
    shutdown /s /t 120 /c "Anime data fetch deadline reached"
    exit 0
  fi
  
  # 检查 node 进程是否还在
  if ! tasklist 2>/dev/null | grep -q "18972"; then
    echo "[Monitor] Fetch process finished at $(date)."
    sleep 10  # 等待文件写入完成
    echo "[Monitor] Shutting down in 120s (cancel: shutdown /a)"
    shutdown /s /t 120 /c "Anime data fetch completed"
    exit 0
  fi
  
  sleep $CHECK_INTERVAL
done
