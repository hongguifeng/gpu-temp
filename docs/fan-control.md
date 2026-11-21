> **文档头**
> - 卡：**CMP 170HX（无板载风扇）**；外接机箱风扇插在主板 4-pin 头
> - 时间：2026-11-21
> - 内容：用 **GPU 温度**驱动主板 PWM 风扇的工具与服务
> - 状态：**标准方法**；换主板只需重新确认 PWM 通道号

# GPU 温控风扇（主板 PWM）

## 1. 背景

CMP 170HX 本身没有风扇（被动散热）。外接风扇插在主板 4-pin 头上时，
其转速由主板 **Super I/O（nct6775/nct6798）** 控制，默认走 BIOS 曲线，
与 GPU 温度无关——GPU 已经 90°C，机箱风扇可能还按 CPU 温度慢慢转。

## 2. 前提：加载 nct6775

```bash
sudo modprobe nct6775
ls /sys/class/hwmon/*/name | xargs -I{} sh -c 'echo -n "{}: "; cat {}'
# 应出现 nct6798 / nct6775
```

开机自动加载（安装脚本已写）：

```bash
echo nct6775 | sudo tee /etc/modules-load.d/nct6775.conf
```

## 3. 确认哪一路 PWM 对应你的风扇

`/sys/class/hwmon/hwmonN/` 下有 `pwm1..pwm6`、`fan1..fan6_input`。
逐路设 255（100%）和 0，看哪个 `fanX_input` 变化：

```
pwm6: 255% -> fan6 3325 RPM | 0% -> fan6 1339 RPM
```

**本机实测**：`pwm6` = 外接风扇（fan6）；`pwm2` = 另一路（fan2）。
不同主板/插法会不同，**换板必须重新探测**。

> 注意：不要把 GPU 曲线套到 CPU_FAN 上；探测时一次只动一路，测完恢复
> `pwmX_enable=5`（BIOS 自动）。

## 4. 工具

```bash
# 只看不写（推荐先跑）
sudo python3 tools/gpu_fan_control.py --pwm 6 --once --dry-run

# 单次设置后退出（退出时恢复 BIOS 自动）
sudo python3 tools/gpu_fan_control.py --pwm 6 --once

# 常驻（5 s 一次）
sudo python3 tools/gpu_fan_control.py --pwm 6 --interval 5

# 自定义曲线：温度:占空比，线性插值
sudo python3 tools/gpu_fan_control.py --pwm 6 --curve "40:20,60:45,75:75,85:100"
```

默认曲线（`--curve` 可改）：

| GPU 温度 | 占空比 |
|---|---|
| ≤40°C | 20% |
| 50°C | 30% |
| 60°C | 45% |
| 70°C | 75% |
| ≥80°C | **100%** |

安全设计：

- **nvidia-smi 连续失败** → 切到 `--fail-duty`（默认 100%），宁可吵不可过热；
- **回差 3%**：温度小幅波动不会让转速来回跳；
- **退出（SIGTERM/Ctrl+C）恢复 `pwmX_enable=5`**，把风扇还给 BIOS，
  除非显式 `--keep-manual`；
- 曲线两端夹在 `--min/--max`。

## 5. 开机服务

```bash
sudo ./tools/install_gpu_fan_service.sh
```

等价于：

```bash
echo nct6775 | sudo tee /etc/modules-load.d/nct6775.conf
sudo cp tools/gpu-fan-control.service /etc/systemd/system/
sudo systemctl enable --now gpu-fan-control.service
```

服务每 5 s 读一次 GPU 温度并写 `pwm6`；`journalctl -u gpu-fan-control -f`
可看实时曲线。

## 6. 本机实测

```
pwm6=255 (100%) -> fan6 3325 RPM
pwm6=128 ( 50%) -> fan6 2397 RPM
pwm6= 40 ( 15%) -> fan6 1624 RPM
GPU 73°C -> duty 71% -> pwm6=181 -> 2812 RPM
```

风扇在 0% 也不会完全停（约 1300 RPM），所以曲线下限用 15–20% 即可。

## 7. 在 DSH 插件里调曲线（2026-11-21）

`docs` 之外的 `gpu-temp` DSH 插件（`/home/hong/Documents/deepseek-harness/default-workspace/gpu-temp/`）
面板里也能直接改曲线，不用敲命令：

- 面板显示：`风扇 3061 RPM · 85% · 手动`；
- 输入框填曲线（如 `40:20,50:30,60:45,70:75,80:100`），点「应用」；
- 预设按钮：静音 / 均衡 / 全速。

原理：插件（普通用户 hong）**不直接写 pwm**，而是连守护进程的 Unix socket
`/run/gpu-fan-control.sock`（root:hong 0660）发 `{"cmd":"set_curve","curve":"..."}`；
守护进程校验后立即生效。这样 Web UI 不需要 root 权限。

插件路由：`/gpu-temp/fan`（GET 读曲线，POST 应用曲线）。

### 7.1 恢复默认（BIOS 自动）

面板里还有一个 **「默认」** 按钮：点它会执行 `set_mode=auto`，
守护进程把 `pwmX_enable` 写回 **5**（BIOS 自动曲线）并停止写 `pwm`；
再点「应用」或任一预设会切回 `manual`。

命令行等价：

```bash
# 恢复 BIOS 自动
sudo python3 tools/gpu_fan_control.py --pwm 6 --keep-manual  # 仅示意；实际用 socket
# 或直接：
echo 5 | sudo tee /sys/class/hwmon/hwmon<N>/pwm6_enable
```

> hwmon 编号会变（本机从 hwmon7 变成 hwmon5），脚本按 `name=nct6798` 查找，不要写死编号。
