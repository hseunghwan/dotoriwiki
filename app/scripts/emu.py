#!/usr/bin/env python3
"""Drives the app on a running emulator for manual verification.

  emu.py ls                      visible texts and accessibility labels with their bounds
  emu.py tap <label> [nth]       tap the nth (0-based) node whose text or content-desc equals <label>
  emu.py has <label>             exit 0 if a node with that text or content-desc is on screen
  emu.py type <ascii text>       type into the focused field (adb input cannot type Hangul)
  emu.py clear                   empty the focused field
  emu.py key <BACK|ENTER|...>    send a key event
  emu.py theme <dark|light>      switch the system night mode
  emu.py shot <file.png>         screenshot
  emu.py open <url>              open a deep link in the app ($DOTORIWIKI_APP_ID, as app.config.ts reads it)
"""
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

PACKAGE = os.environ.get('DOTORIWIKI_APP_ID') or 'dev.dotoriwiki.app'
ADB = os.path.join(os.environ.get('ANDROID_HOME', '/opt/homebrew/share/android-commandlinetools'), 'platform-tools', 'adb')


def adb(*args, capture=False):
    r = subprocess.run([ADB, *args], capture_output=True, check=True)
    return r.stdout if capture else None


def nodes():
    for attempt in range(3):
        try:
            xml = adb('exec-out', 'uiautomator', 'dump', '/dev/tty', capture=True).decode('utf-8', 'replace')
            xml = xml[: xml.rindex('</hierarchy>') + len('</hierarchy>')]
            break
        except (ValueError, subprocess.CalledProcessError):
            time.sleep(0.5)
    else:
        sys.exit('uiautomator dump failed')
    for n in ET.fromstring(xml).iter('node'):
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds', '[0,0][0,0]')))
        yield {'text': n.get('text', ''), 'desc': n.get('content-desc', ''), 'center': ((x1 + x2) // 2, (y1 + y2) // 2), 'bounds': (x1, y1, x2, y2)}


def find(label):
    return [n for n in nodes() if label in (n['text'], n['desc'])]


def main(cmd, *args):
    if cmd == 'ls':
        for n in nodes():
            if n['text'] or n['desc']:
                print(n['bounds'], repr(n['text'] or n['desc']))
    elif cmd == 'tap':
        hits = find(args[0])
        nth = int(args[1]) if len(args) > 1 else 0
        if len(hits) <= nth:
            sys.exit(f'not on screen: {args[0]!r}')
        x, y = hits[nth]['center']
        adb('shell', 'input', 'tap', str(x), str(y))
    elif cmd == 'has':
        sys.exit(0 if find(args[0]) else 1)
    elif cmd == 'type':
        adb('shell', 'input', 'text', args[0].replace(' ', '%s'))
    elif cmd == 'clear':
        adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END', *['KEYCODE_DEL'] * 80)
    elif cmd == 'key':
        adb('shell', 'input', 'keyevent', f'KEYCODE_{args[0]}')
    elif cmd == 'theme':
        adb('shell', 'cmd', 'uimode', 'night', 'yes' if args[0] == 'dark' else 'no')
    elif cmd == 'shot':
        with open(args[0], 'wb') as f:
            f.write(adb('exec-out', 'screencap', '-p', capture=True))
    elif cmd == 'open':
        adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', args[0], PACKAGE)
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(*sys.argv[1:]) if len(sys.argv) > 1 else sys.exit(__doc__)
