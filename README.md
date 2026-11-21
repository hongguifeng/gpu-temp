# @local/gpu-temp

在 Harness Web UI 的输入框下方（composer dock）显示 NVIDIA 显卡温度。

- Host 半：每 5 s 调 `nvidia-smi`，缓存 die 温度/显存温度/SM 时钟/功耗/链路，
  通过只读路由 `/gpu-temp/state` 提供给页面；
- 面板里还能调 **风扇曲线**：显示当前转速/占空比，输入曲线或点预设（静音/均衡/全速），
  通过 `/gpu-temp/fan` → 守护进程 socket（`/run/gpu-fan-control.sock`）生效；
- Client 半：**默认只显示最热那张的温度数字**（如 `94°C`，多卡时带 `+3`）；
  **点击**弹出一个固定定位的小窗，列出每张卡的温度/显存温度/时钟/功耗/链路，
  弹窗不参与布局、不会挤压旁边的内容；点外面或 Esc 关闭。
  ≥80°C 变黄、≥90°C 变红。

安装：由 profile 的 package.json `dsh.profile.bundles` 引入；重启 `dsh web` 生效。

## 配套风扇守护进程（fan-daemon/）

插件只负责「看」和「下发」；真正写 PWM 的是 root 运行的守护进程：

```bash
sudo ./fan-daemon/install.sh          # 默认 pwm6，可用 PWM=2 INTERVAL=5 覆盖
```

- 每 5 s 读一次 GPU 温度，按曲线写主板 `pwm6`；
- 插件通过 Unix socket `/run/gpu-fan-control.sock`（root:hong 0660）改曲线；
- 退出（SIGTERM）时恢复 BIOS 自动控制；
- 方法、曲线、排查见 [`docs/fan-control.md`](docs/fan-control.md)。
