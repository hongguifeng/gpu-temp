#!/usr/bin/env python3
"""按 GPU 温度控制主板 PWM 风扇（nct6775/nct6798）。

原理：nvidia-smi 读 GPU 温度 → 线性插值一条曲线 → 写主板 hwmon 的 pwmN。
退出（SIGTERM/Ctrl+C）时把该通道还给 BIOS 自动控制（pwmN_enable=5）。

用法:
    sudo python3 tools/gpu_fan_control.py --pwm 6 --once        # 读一次温度并设置
    sudo python3 tools/gpu_fan_control.py --pwm 6               # 常驻守护
    sudo python3 tools/gpu_fan_control.py --pwm 6 --curve "40:20,60:45,80:90"
    sudo python3 tools/gpu_fan_control.py --pwm 6 --dry-run     # 只打印不写

安全:
    * nvidia-smi 连续失败时切到 --fail-duty（默认 100%）；
    * 曲线两端夹紧在 min/max；
    * 退出时恢复 BIOS 自动模式，除非 --keep-manual。
"""
import argparse, glob, json, os, pwd, signal, socket, subprocess, sys, threading, time

DEFAULT_CURVE = "40:20,50:30,60:45,70:75,80:100"
HWMON_NAMES = ("nct6798", "nct6799", "nct6775", "nct6776", "nct6779", "nct6796")
DEFAULT_SOCKET = "/run/gpu-fan-control.sock"
MAX_POINTS = 8


def parse_curve(text):
    points = []
    for part in str(text).split(","):
        t, d = part.split(":")
        points.append((float(t), float(d)))
    points.sort()
    if not 2 <= len(points) <= MAX_POINTS:
        raise ValueError(f"curve needs 2..{MAX_POINTS} points")
    for (t0, _), (t1, _) in zip(points, points[1:]):
        if t1 <= t0:
            raise ValueError("temperatures must increase")
    for t, d in points:
        if not 0 <= t <= 115 or not 0 <= d <= 100:
            raise ValueError("temperature 0..115, duty 0..100")
    return points


def serve_socket(path, state, lock, hwmon_dir, enable_name):
    """Accept one-line JSON commands and update the shared curve."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o660)
    try:
        gid = pwd.getpwnam("hong").pw_gid
        os.chown(path, -1, gid)
    except KeyError:
        pass
    server.listen(4)
    while not state["stop"]:
        try:
            server.settimeout(1.0)
            conn, _ = server.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        with conn:
            try:
                data = conn.makefile("r", encoding="utf-8").readline()
                msg = json.loads(data or "{}")
                if msg.get("cmd") == "set_curve":
                    points = parse_curve(msg.get("curve", ""))
                    with lock:
                        state["curve"] = points
                    print(f"[socket] curve -> {msg['curve']}", flush=True)
                    conn.sendall((json.dumps({"ok": True, "curve": points}) + "\n").encode())
                elif msg.get("cmd") == "set_mode":
                    mode = msg.get("mode")
                    if mode not in ("auto", "manual"):
                        raise ValueError("mode must be auto|manual")
                    write_attr(hwmon_dir, enable_name, 5 if mode == "auto" else 1)
                    with lock:
                        state["mode"] = mode
                    print(f"[socket] mode -> {mode}", flush=True)
                    conn.sendall((json.dumps({"ok": True, "mode": mode}) + "\n").encode())
                elif msg.get("cmd") == "get_curve":
                    with lock:
                        points = state["curve"]
                        mode = state["mode"]
                    conn.sendall((json.dumps({"ok": True, "curve": points, "mode": mode}) + "\n").encode())
                else:
                    conn.sendall((json.dumps({"ok": False, "error": "unknown cmd"}) + "\n").encode())
            except Exception as error:
                try:
                    conn.sendall((json.dumps({"ok": False, "error": str(error)}) + "\n").encode())
                except OSError:
                    pass
    server.close()
    try:
        os.unlink(path)
    except OSError:
        pass


def find_hwmon():
    for path in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        try:
            name = open(os.path.join(path, "name")).read().strip()
        except OSError:
            continue
        if name in HWMON_NAMES:
            return path, name
    return None, None


def duty_for(temp, curve, lo, hi):
    if temp <= curve[0][0]:
        duty = curve[0][1]
    elif temp >= curve[-1][0]:
        duty = curve[-1][1]
    else:
        duty = curve[-1][1]
        for (t0, d0), (t1, d1) in zip(curve, curve[1:]):
            if t0 <= temp <= t1:
                ratio = (temp - t0) / (t1 - t0)
                duty = d0 + ratio * (d1 - d0)
                break
    return max(lo, min(hi, duty))


def read_gpu_temp(use_mem):
    fields = "temperature.gpu,memory.temperature" if use_mem else "temperature.gpu"
    try:
        out = subprocess.run(
            ["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    temps = []
    for line in out.stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        for p in parts:
            try:
                temps.append(float(p))
            except ValueError:
                pass
    return max(temps) if temps else None


def write_attr(path, name, value):
    with open(os.path.join(path, name), "w") as f:
        f.write(str(value))


def read_attr(path, name):
    try:
        return open(os.path.join(path, name)).read().strip()
    except OSError:
        return "?"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pwm", type=int, default=6, help="hwmon PWM channel (default 6)")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--curve", default=DEFAULT_CURVE, help='temp:duty pairs, e.g. "40:20,60:45,80:90"')
    ap.add_argument("--min", type=float, default=15, dest="lo")
    ap.add_argument("--max", type=float, default=100, dest="hi")
    ap.add_argument("--fail-duty", type=float, default=100)
    ap.add_argument("--hysteresis", type=float, default=3.0)
    ap.add_argument("--mem-temp", action="store_true", help="also consider memory temperature")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-manual", action="store_true", help="do not restore BIOS auto on exit")
    ap.add_argument("--socket", default=DEFAULT_SOCKET, help="control socket path")
    a = ap.parse_args()

    curve = parse_curve(a.curve)
    state = {"curve": curve, "stop": False, "mode": "manual"}
    lock = threading.Lock()
    path, name = find_hwmon()
    if path is None:
        print("找不到 nct6775/nct6798 hwmon；先 sudo modprobe nct6775", file=sys.stderr)
        return 2
    pwm = f"pwm{a.pwm}"
    enable = f"pwm{a.pwm}_enable"
    if not os.path.exists(os.path.join(path, pwm)):
        print(f"{path} 没有 {pwm}", file=sys.stderr)
        return 2
    print(f"hwmon: {path} ({name})  {pwm} 当前: pwm={read_attr(path, pwm)} enable={read_attr(path, enable)}")

    last = None
    fails = 0
    stopped = False

    def restore(*_):
        nonlocal stopped
        stopped = True
        state["stop"] = True
        if a.keep_manual or a.dry_run:
            return
        try:
            write_attr(path, enable, 5)
            print(f"\n已恢复 {enable}=5（BIOS 自动）")
        except OSError as e:
            print(f"\n恢复 {enable} 失败: {e}", file=sys.stderr)

    signal.signal(signal.SIGTERM, restore)
    signal.signal(signal.SIGINT, restore)

    if not a.dry_run:
        write_attr(path, enable, 1)
        threading.Thread(target=serve_socket, args=(a.socket, state, lock, path, enable), daemon=True).start()

    while True:
        temp = read_gpu_temp(a.mem_temp)
        if temp is None:
            fails += 1
            duty = a.fail_duty
            print(f"[warn] nvidia-smi 读取失败（{fails}），duty={duty:.0f}%", flush=True)
        else:
            fails = 0
            with lock:
                active = state["curve"]
            duty = duty_for(temp, active, a.lo, a.hi)
            if last is None or abs(duty - last) >= a.hysteresis or a.once:
                print(f"GPU {temp:.0f}°C → duty {duty:.0f}%", flush=True)
            else:
                duty = last
        with lock:
            mode = state["mode"]
        if not a.dry_run and mode == "manual":
            write_attr(path, pwm, int(round(duty / 100 * 255)))
        else:
            print(f"(dry-run) {pwm}={int(round(duty / 100 * 255))} fan={read_attr(path, f'fan{a.pwm}_input')} RPM", flush=True)
        last = duty
        if a.once:
            break
        time.sleep(a.interval)
        if stopped:
            break

    restore()
    return 0


if __name__ == "__main__":
    sys.exit(main())
