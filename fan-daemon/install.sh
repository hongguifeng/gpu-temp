#!/bin/bash
# 安装 GPU 温控风扇守护进程（nct6775/nct6798）。
# 需要 root；会写入 /etc/systemd/system 和 /etc/modules-load.d。
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PWM="${PWM:-6}"
INTERVAL="${INTERVAL:-5}"
echo nct6775 > /etc/modules-load.d/nct6775.conf
cat > /etc/systemd/system/gpu-fan-control.service <<UNIT
[Unit]
Description=GPU temperature controlled chassis fan (pwm${PWM})
After=multi-user.target

[Service]
Type=simple
ExecStart=${HERE}/gpu_fan_control.py --pwm ${PWM} --interval ${INTERVAL}
Restart=always
RestartSec=5
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now gpu-fan-control.service
systemctl status gpu-fan-control.service --no-pager | tail -5
