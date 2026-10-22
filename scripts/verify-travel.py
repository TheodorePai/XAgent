#!/usr/bin/env python3
"""Real DeepSeek + native Mastra AgentBrowser acceptance, no search API key.
Reads only demo identity credentials into memory. Does not read the model key.
"""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

base = 'http://127.0.0.1:4391'
started = time.monotonic()
report = {'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mode': 'deepseek',
          'browser': '@mastra/agent-browser@0.5.4 with headless Chromium', 'destination': '延吉',
          'sources': 'live-public-web', 'passed': False, 'checks': []}
task_id = None


def api(token, path, body=None, expected=200):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            status, value = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, value = error.code, json.load(error)
    assert status == expected, f'HTTP {status}, code={value.get("error", "unknown")}'
    return value


def wait(revision):
    deadline = time.monotonic() + 200
    while time.monotonic() < deadline:
        value = api(owner, '/v1/tasks/' + task_id)
        if value.get('error'):
            report['failedTask'] = value
            raise AssertionError(value['error'])
        if value['publishedRevision'] == revision:
            return value
        time.sleep(.3)
    raise AssertionError('Travel planning timed out')


def check(name, **evidence):
    report['checks'].append({'name': name, 'passed': True, **evidence})
    print(json.dumps({'check': name, 'passed': True}, ensure_ascii=False), flush=True)


try:
    health = api(None, '/health')
    assert health['deepseekConfigured'] and 'travel-assistant' in health['agentIds']
    result = subprocess.run(['docker', 'exec', 'xagent-mastra-lab', 'node', '-e',
        "process.stdout.write(require('fs').readFileSync('/app/data/meeting-lab-identities.json','utf8'))"],
        check=True, capture_output=True, text=True)
    users = json.loads(result.stdout)
    owner = users[0]['token']
    created = api(owner, '/v1/tasks', {'name': '延吉三日游真实浏览器验证', 'agentId': 'travel-assistant',
        'mode': 'deepseek', 'instruction': '我要去延吉玩三天，想体验朝鲜族文化、美食和城市散步。请实际搜索并阅读政府或公共新闻资料，给出按天计划，并尽量附上相关图片。未指定出发地、日期和预算，请标明假设，不编造实时价格。',
        'config': {'destination': '延吉', 'days': 3}, 'notes': []}, 201)
    task_id = created['task']['id']
    assert created['task']['subscription'] == 'not_required' and 'deviceToken' not in created
    task = wait(1)
    plan = task['output']
    assert plan['destination'] == '延吉' and len(plan['days']) == 3
    assert len([s for s in plan['sources'] if s['kind'] == 'page']) >= 2
    assert plan['assumptions'] and '[MOCK]' not in json.dumps(plan, ensure_ascii=False)
    tools = [t['tool'] for run in task['runs'] for t in run['trace']]
    assert all(name in tools for name in ['browserSearch', 'browserRead', 'browserImages', 'submitTripPlan'])
    assert task['runs'][-1]['status'] == 'completed'
    report['plan'] = plan
    report['runs'] = task['runs']
    check('user_request_runs_without_device_subscription', taskId=task_id)
    check('real_browser_pages_support_three_day_plan', sourceCount=len(plan['sources']), toolCalls=tools)
    image_checks = []
    for image in plan['images']:
        assert image['sourceId'] in {s['id'] for s in plan['sources']}
        assert image['width'] >= 300 and image['height'] >= 150
        image_checks.append({'id': image['id'], 'url': image['url'], 'sourcePage': image['sourcePage'],
                             'loadedDimensions': [image['width'], image['height']]})
    check('image_metadata_is_bound_to_loaded_source_pages', imageCount=len(image_checks), images=image_checks)
    view = api(owner, f'/v1/tasks/{task_id}/view')
    assert len(view['messages']) == 3 and view['protocol'] == 'v0.9.1'
    api(users[1]['token'], '/v1/tasks/' + task_id, expected=404)
    check('mandatory_a2ui_validation_and_cross_user_isolation')
    previous = json.loads(Path('docs/pre-travel-snapshot.json').read_text())['tasks']
    creds = {u['userId']: u['token'] for u in users}
    for old in previous:
        value = api(creds[old['ownerId']], '/v1/tasks/' + old['id'])
        output_hash = hashlib.sha256(json.dumps(value.get('output'), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        assert value['publishedRevision'] == old['revision'] and output_hash == old['outputHash']
    check('preexisting_task_results_unchanged', tasks=len(previous))
    report['passed'] = True
finally:
    if task_id:
        try:
            api(owner, f'/v1/tasks/{task_id}/pause', {})
            value = api(owner, '/v1/tasks/' + task_id)
            report['finalStatus'] = value['status']
            report.setdefault('runs', value['runs'])
        except Exception:
            pass
    report['elapsedSeconds'] = round(time.monotonic() - started, 3)
    Path('docs/travel-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
