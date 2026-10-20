"""Run an interactive TUI in a pseudo-terminal until it exits or is killed.

Usage: python3 pty-run.py <logfile> <cmd> [args...]

Interactive harness sessions are the only ones that sit idle at a prompt, so
idle delivery can only be tested inside a terminal. Output is appended to
<logfile>. Terminal capability queries a TUI blocks on at start-up (cursor
position, device attributes, colours, keyboard protocol) are answered the way
a typical terminal would.
"""
import os
import pty
import select
import signal
import sys

REPLIES = [
    (b'\x1b[6n', b'\x1b[1;1R'),
    (b'\x1b[c', b'\x1b[?62c'),
    (b'\x1b[0c', b'\x1b[?62c'),
    (b'\x1b]10;?', b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),
    (b'\x1b]11;?', b'\x1b]11;rgb:0000/0000/0000\x1b\\'),
    (b'\x1b[?u', b'\x1b[?0u'),
]

log, command = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execvp(command[0], command)


def stop(_signum, _frame):
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except ProcessLookupError:
        pass
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
with open(log, 'ab') as out:
    while True:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        out.flush()
        for query, reply in REPLIES:
            if query in data:
                os.write(fd, reply)
