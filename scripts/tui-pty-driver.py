#!/usr/bin/env python3
"""Small dependency-free POSIX PTY driver for the operational TUI smoke test."""

import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def main() -> int:
    if len(sys.argv) < 4:
        raise RuntimeError("usage: tui-pty-driver.py <cwd> <command> [args...]")
    cwd, command = sys.argv[1], sys.argv[2:]
    master, slave = pty.openpty()

    def resize(rows: int, columns: int) -> None:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    resize(30, 120)

    def child_session() -> None:
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    child = subprocess.Popen(command, cwd=cwd, stdin=slave, stdout=slave, stderr=slave, close_fds=True, preexec_fn=child_session)
    os.close(slave)
    output = bytearray()

    def read_available(timeout: float = 0.05) -> None:
        ready, _, _ = select.select([master], [], [], timeout)
        if not ready:
            return
        try:
            chunk = os.read(master, 65536)
        except OSError:
            chunk = b""
        output.extend(chunk)

    def wait_for(value: bytes, after: int = 0, timeout: float = 8.0) -> int:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            index = output.find(value, after)
            if index >= 0:
                return index + len(value)
            if child.poll() is not None:
                break
            read_available()
        recent = bytes(output[-4000:]).decode("utf-8", "replace")
        raise RuntimeError(f"PTY output did not contain {value!r} after offset {after}. Recent output:\n{recent}")

    def wait_for_quiet(quiet_for: float = 0.25, timeout: float = 2.0) -> None:
        deadline = time.monotonic() + timeout
        quiet_since = time.monotonic()
        observed = len(output)
        while time.monotonic() < deadline:
            read_available(0.05)
            if len(output) != observed:
                observed = len(output)
                quiet_since = time.monotonic()
            elif time.monotonic() - quiet_since >= quiet_for:
                return

    def send(value: bytes, expected: bytes, after: int, quiet: bool = True) -> int:
        if quiet:
            wait_for_quiet()
        else:
            time.sleep(0.2)
        os.write(master, value)
        return wait_for(expected, after)

    try:
        if os.environ.get("ARIADNE_PTY_MODE") == "review":
            cursor = wait_for(b"Dashboard")
            cursor = send(b"\t", b"Needs attention", cursor)
            cursor = send(b"\r", b"Results", cursor)
            cursor = send(b"\r", b"Result summary", cursor)
            cursor = send(b"\r", b"Changed files", cursor)
            cursor = send(b"\r", b"Diff", cursor)
            cursor = send(b"\x1b", b"Changed files", cursor)
            cursor = send(b"\x1b", b"Result summary", cursor)
            cursor = send(b"a", b"Apply eligibility", cursor)
            cursor = send(b"\r", b"Apply preview", cursor)
            cursor = send(b"\r", b"Apply confirmation", cursor)
            cursor = send(b"\x1b", b"Apply preview", cursor)
            cursor = send(b"\x1b", b"Apply eligibility", cursor)
            cursor = send(b"\x1b", b"Result summary", cursor)
            cursor = send(b"x", b"Discard preview", cursor)
            cursor = send(b"\r", b"Discard confirmation", cursor)
            cursor = send(b"\x1b", b"Discard preview", cursor)
            os.write(master, b"q")
            deadline = time.monotonic() + 10.0
            while child.poll() is None and time.monotonic() < deadline:
                read_available()
            if child.poll() is None:
                raise RuntimeError("PTY review workflow did not tear down within 10 seconds")
            while True:
                before = len(output)
                read_available(0)
                if len(output) == before:
                    break
            if child.returncode != 0:
                raise RuntimeError(f"PTY review child exited {child.returncode}")
            if b"\x1b[?1049h" not in output or b"\x1b[?1049l" not in output:
                raise RuntimeError("review alternate-screen entry/restoration was not observed")
            print("TUI PTY review smoke passed: attention, result, manifest, diff, apply cancellation, discard cancellation, teardown.")
            return 0

        cursor = wait_for(b"Dashboard")
        cursor = send(b"p", b"Select tasks", cursor)
        wait_for_quiet()
        os.write(master, b" ")  # Exercise Space; some script/pty stacks swallow a lone space in raw mode.
        wait_for_quiet()
        cursor = send(b"a", b"[x]", cursor)
        cursor = send(b"\r", b"Workflow plan", cursor)
        cursor = send(b"\r", b"Launch workflow?", cursor)
        cursor = send(b"\r", b"Live output", cursor)
        cursor = wait_for(b"pty live", cursor)
        resize(24, 80)
        os.killpg(child.pid, signal.SIGWINCH)
        cursor = send(b"\x1b", b"Dashboard", cursor, quiet=False)
        cursor = wait_for(b"attached", cursor, 4.0)
        cursor = send(b"\r", b"live output", cursor)
        cursor = send(b"c", b"Cancel workflow?", cursor, quiet=False)
        cursor = send(b"\x1b", b"live output", cursor)
        cursor = send(b"c", b"Cancel workflow?", cursor, quiet=False)
        cursor = send(b"\r", b"Cancelling workflow", cursor)
        cursor = wait_for(b"Workflow overview", cursor)
        os.write(master, b"q")
        deadline = time.monotonic() + 10.0
        while child.poll() is None and time.monotonic() < deadline:
            read_available()
        if child.poll() is None:
            raise RuntimeError("PTY workflow did not tear down within 10 seconds")
        while True:
            before = len(output)
            read_available(0)
            if len(output) == before:
                break
        if child.returncode != 0:
            raise RuntimeError(f"PTY child exited {child.returncode}")
        if b"\x1b[?1049h" not in output or b"\x1b[?1049l" not in output:
            raise RuntimeError("alternate-screen entry/restoration was not observed")
        print("TUI PTY smoke passed: plan, launch, output, detach, reopen, cancel, resize, teardown.")
        return 0
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
        os.close(master)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # smoke-test diagnostic path
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
