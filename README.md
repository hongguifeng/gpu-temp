# @local/gpu-temp

在 Harness Web UI 的输入框下方（composer dock）显示 NVIDIA 显卡温度。

- Host 半：每 5 s 调 `nvidia-smi`，缓存 die 温度/显存温度/SM 时钟/功耗/链路，
  通过只读路由 `/gpu-temp/state` 提供给页面；
- Client 半：**默认只显示最热那张的温度数字**（如 `94°C`，多卡时带 `+3`）；
  **点击**弹出一个固定定位的小窗，列出每张卡的温度/显存温度/时钟/功耗/链路，
  弹窗不参与布局、不会挤压旁边的内容；点外面或 Esc 关闭。
  ≥80°C 变黄、≥90°C 变红。

安装：由 profile 的 package.json `dsh.profile.bundles` 引入；重启 `dsh web` 生效。
