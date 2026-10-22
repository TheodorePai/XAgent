#!/usr/bin/env python3
"""An explicit synthetic device, for the mock model or later DeepSeek tests."""
import argparse
import datetime
import json
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:4391')
parser.add_argument('--battery', type=int, default=78, choices=range(101), metavar='0..100')
parser.add_argument('--auto-photo', action='store_true', help='Return synthetic photo text; does not access a camera')
args = parser.parse_args()
print('Synthetic device running. No real phone, calendar, battery or camera is accessed.', flush=True)
seen = set()
try:
    while True:
        with urllib.request.urlopen(args.base + '/devices/sim-phone/commands', timeout=10) as response:
            commands = json.load(response)['commands']
        for command in commands:
            if command['tool'] == 'capturePhoto' and not args.auto_photo:
                if command['id'] not in seen:
                    print('Photo is waiting. Add --auto-photo to return a simulated result:', command['id'], flush=True)
                    seen.add(command['id'])
                continue
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            data = {'readBattery': {'level': args.battery, 'charging': False},
                'queryCalendar': {'events': [{'title': '模拟设备日程：架构实验讨论', 'startAt': now}]},
                'capturePhoto': {'description': '模拟照片：桌上有一张架构草图', 'simulated': True}}[command['tool']]
            payload = json.dumps({'status': 'succeeded', 'observedAt': now, 'data': data}).encode()
            request = urllib.request.Request(args.base + '/devices/sim-phone/results/' + command['id'], data=payload,
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=10) as response:
                print(command['tool'], command['id'], response.status, flush=True)
        time.sleep(0.15)
except KeyboardInterrupt:
    pass
