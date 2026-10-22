#!/usr/bin/env python3
"""Verify the deployed API, optionally including a real container restart.

Uses only scripted mock runs and synthetic device results. Never calls DeepSeek.
"""
import argparse
import datetime
import json
import subprocess
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:4391')
parser.add_argument('--container', choices=['xagent-mastra-lab'])
args = parser.parse_args()
checks = []

def api(path, body=None, expected=200):
    request = urllib.request.Request(args.base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={} if body is None else {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status, result = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, result = error.code, json.load(error)
    assert status == expected, (path, status, result)
    return result

def wait(read, limit=20):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        result = read()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError('Condition timed out')

def job(run_id, tool):
    return wait(lambda: next((j for j in api('/runs/' + run_id)['jobs']
        if j['tool'] == tool and j['status'] == 'pending'), None))

def settled(run_id):
    def read():
        run = api('/runs/' + run_id)
        return run if run['status'] in ['completed', 'failed', 'canceled'] else None
    return wait(read)

def success(data):
    return {'status': 'succeeded', 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'data': data}

def result(call_id, payload, expected=200):
    return api('/devices/sim-phone/results/' + call_id, payload, expected)

for attempt in range(120):
    try:
        health = api('/health')
        break
    except (OSError, urllib.error.URLError):
        time.sleep(0.5)
else:
    raise AssertionError('Server did not become ready')
assert health['mockIsScripted'] and health['persistentStorage']
run = api('/runs', {}, 202)
battery = job(run['id'], 'readBattery')
result(battery['id'], success({'level': 83, 'charging': False}))
calendar = job(run['id'], 'queryCalendar')
result(calendar['id'], success({'events': [{'title': 'server-proof-7391', 'startAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}]}))
done = settled(run['id'])
assert done['status'] == 'completed' and '7391' in done['text'] and '83' in done['text'], done
checks.append({'name': 'two_device_tools_and_result_driven_continuation', 'runId': run['id'], 'passed': True})

run = api('/runs', {}, 202)
battery = job(run['id'], 'readBattery')
result(battery['id'], success({'level': 11, 'charging': False}))
done = settled(run['id'])
assert done['status'] == 'completed' and len(done['jobs']) == 1 and '11%' in done['text'], done
checks.append({'name': 'low_battery_changes_next_tool_selection', 'runId': run['id'], 'passed': True})

run = api('/runs', {'scenario': 'photo'}, 202)
photo = job(run['id'], 'capturePhoto')
wait(lambda: api('/runs/' + run['id'])['status'] == 'waiting_device')
if args.container:
    subprocess.run(['docker', 'restart', args.container], check=True, capture_output=True, text=True)
    for attempt in range(120):
        try:
            api('/health')
            break
        except (OSError, urllib.error.URLError):
            time.sleep(0.5)
    else:
        raise AssertionError('Container failed to restart')
    assert api('/runs/' + run['id'])['status'] == 'waiting_device'
payload = success({'description': 'server-restart-photo-8624', 'simulated': True})
result(photo['id'], payload)
done = settled(run['id'])
assert done['status'] == 'completed' and '8624' in done['text'], done
assert result(photo['id'], payload)['duplicate']
result(photo['id'], {**payload, 'data': {'description': 'conflicting result', 'simulated': True}}, 409)
events = api('/runs/' + run['id'])['events']
assert sum(e['type'] == 'agent.resuming' for e in events) == 1
checks.append({'name': 'suspension_survives_container_restart' if args.container else 'delayed_tool_result', 'runId': run['id'], 'passed': True})
checks.append({'name': 'duplicate_receipt_and_conflicting_result', 'passed': True})

run = api('/runs', {'scenario': 'photo'}, 202)
photo = job(run['id'], 'capturePhoto')
api('/runs/' + run['id'] + '/cancel', {})
result(photo['id'], success({'description': 'late result', 'simulated': True}), 410)
assert api('/runs/' + run['id'])['status'] == 'canceled'
checks.append({'name': 'canceled_run_rejects_late_result', 'runId': run['id'], 'passed': True})

run = api('/runs', {'scenario': 'photo', 'jobTtlMs': 200}, 202)
done = settled(run['id'])
assert done['status'] == 'failed' and done['error'] == 'DEVICE_TIMEOUT'
checks.append({'name': 'device_timeout_is_terminal', 'runId': run['id'], 'passed': True})

if not api('/health')['deepseekConfigured']:
    api('/runs', {'mode': 'deepseek'}, 412)
    checks.append({'name': 'missing_deepseek_key_rejected_without_fallback', 'passed': True})
print(json.dumps({'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'base': args.base, 'mode': 'scripted-mock', 'deepseekCalled': False,
    'containerRestartTested': bool(args.container), 'checks': checks}, ensure_ascii=False, indent=2))
