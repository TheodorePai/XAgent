#!/usr/bin/env python3
"""Small, explicit real-model acceptance run against synthetic device data.

Uses the key already loaded by the server; never reads or prints credentials.
"""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:4391')
parser.add_argument('--restart-container', choices=['xagent-mastra-lab'])
parser.add_argument('--output', default='docs/deepseek-verification.json')
args = parser.parse_args()
checks = []
created = []
started = time.monotonic()
report = {'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'base': args.base, 'mode': 'deepseek', 'device': 'synthetic-only',
    'containerRestartTested': False, 'checks': checks}

def api(path, body=None, expected=200):
    request = urllib.request.Request(args.base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={} if body is None else {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status, result = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, result = error.code, json.load(error)
    if status != expected:
        raise AssertionError(f'{path}: HTTP {status}, code={result.get("error", "unknown")}')
    return result

def wait_for(run_id, condition, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        run = api('/runs/' + run_id)
        if condition(run):
            return run
        if run['status'] in ['completed', 'failed', 'canceled']:
            raise AssertionError(f'Unexpected terminal state: {run["status"]}, code={run.get("error", "none")}')
        time.sleep(0.15)
    raise AssertionError('Real-model run timed out')

def create(scenario, prompt):
    run = api('/runs', {'mode': 'deepseek', 'scenario': scenario, 'prompt': prompt, 'jobTtlMs': 180000}, 202)
    created.append(run['id'])
    return run['id']

def pending(run_id, name):
    run = wait_for(run_id, lambda r: any(j['tool'] == name and j['status'] == 'pending' for j in r['jobs']))
    return next(j for j in run['jobs'] if j['tool'] == name and j['status'] == 'pending')

def submit(job, data=None, error=None, expected=200):
    payload = {'status': 'failed' if error else 'succeeded',
        'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    payload['error' if error else 'data'] = error if error else data
    result = api('/devices/sim-phone/results/' + job['id'], payload, expected)
    return payload, result

def completed(run_id):
    return wait_for(run_id, lambda r: r['status'] == 'completed')

def record(name, run, t0):
    assert run['mode'] == 'deepseek'
    assert '[MOCK]' not in run['text']
    check = {'name': name, 'passed': True, 'runId': run['id'],
        'elapsedSeconds': round(time.monotonic() - t0, 3),
        'tools': [j['tool'] for j in run['jobs']], 'answer': run['text'],
        'events': [{'at': e['at'], 'type': e['type'], 'data': e['data']} for e in run['events']]}
    checks.append(check)
    print(json.dumps({'check': name, 'passed': True, 'elapsedSeconds': check['elapsedSeconds']}, ensure_ascii=False), flush=True)

try:
    health = api('/health')
    assert health['deepseekConfigured'], 'DeepSeek key is not loaded by the running server'
    if args.restart_container:
        # Read only non-secret runtime metadata; never inspect the full environment.
        metadata = subprocess.run(['docker', 'exec', args.restart_container, 'node', '-p',
            "JSON.stringify({model:process.env.DEEPSEEK_MODEL || 'deepseek-flash',baseHost:new URL(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').hostname,node:process.version})"],
            check=True, capture_output=True, text=True)
        report['runtime'] = json.loads(metadata.stdout)
    # Refuse to interfere with an unrelated experiment during the restart case.
    busy = [r for r in api('/runs')['runs'] if r['status'] in ['running', 'waiting_device']]
    assert not busy, 'There is an active experiment; wait until it finishes'

    t0 = time.monotonic()
    marker = '日程回执-' + uuid.uuid4().hex[:10]
    run_id = create('plan', '请读取手机电量；低于20%就建议充电并结束，否则查询日历再给安排。最终回复必须包含日历事件的完整标题和实际电量。')
    battery = pending(run_id, 'readBattery')
    submit(battery, {'level': 82, 'charging': False})
    calendar = pending(run_id, 'queryCalendar')
    submit(calendar, {'events': [{'title': marker, 'startAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}]})
    run = completed(run_id)
    assert marker in run['text'] and '82' in run['text'], 'Final answer did not use the returned observation'
    assert [j['tool'] for j in run['jobs']] == ['readBattery', 'queryCalendar']
    record('two_phone_tools_and_observation_grounding', run, t0)

    t0 = time.monotonic()
    run_id = create('plan', '请读手机电量后决定是否继续查看日历：低于20%就建议充电并结束，不要查询日历。回复里写明实际电量。')
    submit(pending(run_id, 'readBattery'), {'level': 12, 'charging': False})
    run = completed(run_id)
    assert [j['tool'] for j in run['jobs']] == ['readBattery'] and '12' in run['text'] and '充电' in run['text']
    record('low_battery_changes_tool_selection', run, t0)

    t0 = time.monotonic()
    marker = '照片回执-' + uuid.uuid4().hex[:10]
    run_id = create('photo', '请调用手机拍照工具，等待工具返回后概括它提供的照片说明，并原样保留说明中的照片回执编号。')
    photo = pending(run_id, 'capturePhoto')
    wait_for(run_id, lambda r: r['status'] == 'waiting_device')
    if args.restart_container:
        other = [r for r in api('/runs')['runs'] if r['id'] != run_id and r['status'] in ['running', 'waiting_device']]
        assert not other, 'Another run started; refusing to restart it'
        subprocess.run(['docker', 'restart', args.restart_container], check=True, capture_output=True, text=True)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                api('/health')
                break
            except (OSError, urllib.error.URLError):
                time.sleep(0.5)
        else:
            raise AssertionError('Container restart did not become ready')
        assert api('/runs/' + run_id)['status'] == 'waiting_device'
        report['containerRestartTested'] = True
    # This callback is a new HTTP request after the process boundary.
    payload, _ = submit(photo, {'description': f'模拟照片显示桌上的一张蓝色便签。{marker}', 'simulated': True})
    run = completed(run_id)
    assert marker in run['text'] and len(run['jobs']) == 1
    record('photo_suspension_and_restart_continuation', run, t0)
    receipt = api('/devices/sim-phone/results/' + photo['id'], payload)
    assert receipt['duplicate']
    changed = {**payload, 'data': {'description': 'conflicting synthetic observation', 'simulated': True}}
    api('/devices/sim-phone/results/' + photo['id'], changed, 409)
    assert sum(e['type'] == 'agent.resuming' for e in api('/runs/' + run_id)['events']) == 1
    checks.append({'name': 'real_model_run_duplicate_result_does_not_resume_twice', 'passed': True, 'runId': run_id})

    t0 = time.monotonic()
    run_id = create('plan', '请读取手机电量后给出建议。如果工具报告权限被拒绝，明确说明无法读取，不要重试、不要猜测电量，也不要继续查日历。')
    submit(pending(run_id, 'readBattery'), error='permission_denied')
    run = completed(run_id)
    assert len(run['jobs']) == 1 and any(word in run['text'] for word in ['权限', '授权', '拒绝'])
    record('permission_denied_is_not_empty_success', run, t0)
    report['passed'] = True
except Exception as error:
    report['passed'] = False
    report['failure'] = {'type': type(error).__name__, 'message': str(error)}
    # All run IDs here were created by this verifier. Never cancel unrelated runs.
    for run_id in created:
        try:
            run = api('/runs/' + run_id)
            if run['status'] in ['running', 'waiting_device']:
                api('/runs/' + run_id + '/cancel', {})
        except Exception:
            pass
finally:
    report['totalElapsedSeconds'] = round(time.monotonic() - started, 3)
    report['runIds'] = created
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': report.get('passed', False), 'checksPassed': len(checks),
        'report': str(output), 'totalElapsedSeconds': report['totalElapsedSeconds'],
        **({'failure': report['failure']} if 'failure' in report else {})}, ensure_ascii=False), flush=True)
if not report['passed']:
    raise SystemExit(1)
