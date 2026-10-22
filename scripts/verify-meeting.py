#!/usr/bin/env python3
"""Bounded real-model acceptance against synthetic events and task-local notes.

Demo user credentials are read into memory and never printed or written to reports.
The DeepSeek key remains inside the service and is never read by this script.
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
parser.add_argument('--container', choices=['xagent-mastra-lab'])
parser.add_argument('--identities', help='local meeting-lab-identities.json instead of container')
parser.add_argument('--mode', choices=['mock', 'deepseek'], default='deepseek')
parser.add_argument('--restart', action='store_true')
parser.add_argument('--output', default='docs/meeting-verification.json')
args = parser.parse_args()
started = time.monotonic()
report = {'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'mode': args.mode, 'device': 'simulated-calendar', 'retrieval': 'task-scoped-fixture-library',
          'rendererTested': False, 'checks': []}
created = []


def api(token, path, body=None, expected=200):
    request = urllib.request.Request(args.base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(request, timeout=10) as res:
            status, result = res.status, json.load(res)
    except urllib.error.HTTPError as error:
        status, result = error.code, json.load(error)
    assert status == expected, f'HTTP {status}, code={result.get("error", "unknown")}, expected={expected}'
    return result


def read(task):
    return api(task['owner'], '/v1/tasks/' + task['id'])


def settled(task, revision):
    until = time.monotonic() + 100
    while time.monotonic() < until:
        value = read(task)
        assert not value.get('error'), 'Generation failed: ' + str(value.get('error'))
        if value['publishedRevision'] == revision:
            assert value['mode'] == args.mode
            return value
        time.sleep(.15)
    raise AssertionError('Meeting generation timed out')


def event(sequence, title, agenda):
    return {'eventId': str(uuid.uuid4()), 'sequence': sequence,
        'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'meeting': {'title': title, 'agenda': agenda, 'startAt': '2026-10-30T10:00:00+08:00'}}


def post_event(task, value, expected=202):
    return api(task['device'], f'/v1/device/tasks/{task["id"]}/events', value, expected)


def check(name, **evidence):
    report['checks'].append({'name': name, 'passed': True, **evidence})
    print(json.dumps({'check': name, 'passed': True}, ensure_ascii=False), flush=True)


try:
    health = api(None, '/health')
    assert health.get('meetingAgent')
    if args.mode == 'deepseek':
        assert health['deepseekConfigured'], 'DeepSeek key not loaded'
    if args.container:
        metadata = subprocess.run(['docker', 'exec', args.container, 'node', '-p',
            "JSON.stringify({model:process.env.DEEPSEEK_MODEL||'deepseek-flash',baseHost:new URL(process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com/v1').hostname,node:process.version})"],
            check=True, capture_output=True, text=True)
        report['runtime'] = json.loads(metadata.stdout)
        result = subprocess.run(['docker', 'exec', args.container, 'node', '-e',
            "process.stdout.write(require('node:fs').readFileSync('/app/data/meeting-lab-identities.json','utf8'))"],
            check=True, capture_output=True, text=True)
        identities = json.loads(result.stdout)
    else:
        assert args.identities, 'Use --container or --identities'
        identities = json.loads(Path(args.identities).read_text())
    if args.restart:
        assert args.container, '--restart requires --container'
        old = api(None, '/runs')['runs']
        assert not any(r['status'] in ['running', 'waiting_device'] for r in old), 'Unrelated device experiment active'
        for user in identities:
            assert not any(t['status'] == 'active' for t in api(user['token'], '/v1/tasks')['tasks']), 'Unrelated meeting tasks active'

    for i, user in enumerate(identities):
        for j in range(2):
            marker = f'ONLY-U{i}-T{j}-' + uuid.uuid4().hex[:6]
            data = api(user['token'], '/v1/tasks', {'name': f'参会验证-{i}-{j}', 'mode': args.mode,
                'instruction': '准备预算会议，保留资料中的独特编号及具体数额，给出会前准备清单。',
                'notes': [{'id': marker, 'text': f'本次预算上限为 {31+i*10+j} 万元，独特编号 {marker}。请把编号原样用于摘要便于核对。'}]}, 201)
            task = {'id': data['task']['id'], 'owner': user['token'], 'device': data['deviceToken'], 'marker': marker}
            created.append(task)
            commands = api(task['device'], f'/v1/device/tasks/{task["id"]}/commands')
            assert commands['commands'][0]['tool'] == 'watchCalendar'
            api(task['device'], f'/v1/device/tasks/{task["id"]}/ack', {'commandId': task['id']})
            assert not read(task)['runs'], 'Subscription installation must not run model'
            post_event(task, event(1, f'预算会-{i}-{j}', '核对预算上限并制定准备清单'))

    outputs = []
    for task in created:
        value = settled(task, 1)
        text = json.dumps(value['brief'], ensure_ascii=False)
        assert task['marker'] in value['brief']['summary'], 'Actual retrieved note must influence summary'
        assert value['brief']['sourceIds'] == [task['marker']]
        for other in created:
            if other['id'] != task['id']:
                assert other['marker'] not in text, 'Task data leaked'
        run = value['runs'][-1]
        assert run['status'] == 'completed'
        assert [x['tool'] for x in run['trace']] == ['searchMeetingNotes', 'submitBrief']
        outputs.append({'taskId': task['id'], 'ownerId': value['ownerId'], 'agentId': value['agentId'],
            'agentVersion': value['agentVersion'], 'brief': value['brief'], 'run': run})
    check('one_agent_two_users_four_isolated_tasks', outputs=outputs)

    task = created[0]
    api(identities[1]['token'], '/v1/tasks/' + task['id'], expected=404)
    api(identities[1]['token'], f'/v1/tasks/{task["id"]}/instruction', {'instruction': 'unauthorized'}, 404)
    api(created[1]['device'], f'/v1/device/tasks/{task["id"]}/commands', expected=401)
    api(task['device'], f'/v1/tasks/{task["id"]}/view', expected=401)
    check('cross_user_access_and_cross_subscription_token_rejected')

    view = api(task['owner'], f'/v1/tasks/{task["id"]}/view')
    assert len(view['messages']) == 3 and view['protocol'] == 'v0.9.1'
    report['initialA2ui'] = view
    api(task['owner'], f'/v1/tasks/{task["id"]}/instruction',
        {'instruction': '现在重点关注预算风险。请在摘要中明确写出“预算风险”，保留资料编号。'}, 202)
    value = settled(task, 2)
    assert '预算风险' in value['brief']['summary']
    update = api(task['owner'], f'/v1/tasks/{task["id"]}/view?after=1')
    assert update['surfaceId'] == view['surfaceId'] and len(update['messages']) == 1
    assert 'updateDataModel' in update['messages'][0]
    assert not api(task['owner'], f'/v1/tasks/{task["id"]}/view?after=2')['messages']
    check('user_instruction_refreshes_same_surface', brief=value['brief'], update=update)

    payload = event(2, '预算变更会议', '会议变更：追加议题为费用超支，原样写出“费用超支”并结合资料分析。')
    post_event(task, payload)
    value = settled(task, 3)
    assert '费用超支' in value['brief']['summary']
    count = len(value['runs'])
    assert post_event(task, payload)['duplicate']
    post_event(task, {**payload, 'sequence': 3}, 409)
    post_event(task, event(1, '旧事件', '旧议题'), 409)
    assert len(read(task)['runs']) == count
    for other in created[1:]:
        assert read(other)['publishedRevision'] == 1
    check('event_refresh_deduplication_ordering_and_other_tasks_unchanged', brief=value['brief'])

    if args.restart:
        # Save an event while the app is stopped, reproducing receipt commit
        # followed by a crash before the next scheduling tick.
        target = created[1]
        for current in created:
            assert all(r['status'] != 'running' for r in read(current)['runs'])
        subprocess.run(['docker', 'stop', args.container], check=True, capture_output=True)
        helper = """import {MeetingStore} from './dist/meeting/store.js';
import {readFileSync} from 'node:fs';
const s=new MeetingStore('/app/data');
const input=JSON.parse(readFileSync(0,'utf8'));
s.receive(input.task,input.token,input.event);s.close();"""
        payload = event(2, '重启后预算会', '新增议题“恢复核对”，请在摘要中原样体现。')
        # Pass scoped credentials over stdin, not command-line arguments.
        try:
            subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'none', '--user', '1000:1000',
                '--read-only', '-v', str(Path('data').resolve()) + ':/app/data',
                'xagent-mastra-lab:0.1.0', 'node', '--input-type=module', '-e', helper],
                input=json.dumps({'task': target['id'], 'token': target['device'], 'event': payload}),
                text=True, check=True, capture_output=True)
        finally:
            subprocess.run(['docker', 'start', args.container], check=True, capture_output=True)
        deadline = time.monotonic() + 30
        while True:
            try:
                api(None, '/health')
                break
            except (OSError, AssertionError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(.3)
        value = settled(target, 2)
        assert '恢复核对' in value['brief']['summary']
        assert value['subscription'] == 'active'
        assert len(api(target['owner'], f'/v1/tasks/{target["id"]}/view')['messages']) == 3
        check('restart_recovers_committed_event_and_surface_snapshot', brief=value['brief'])

    target = created[2]
    api(target['owner'], f'/v1/tasks/{target["id"]}/pause', {})
    post_event(target, event(2, 'late', 'late'), 410)
    commands = api(target['device'], f'/v1/device/tasks/{target["id"]}/commands')
    assert commands['commands'][0]['tool'] == 'stopWatchCalendar'
    check('pause_revokes_subscription_and_rejects_late_event')
    report['passed'] = True
finally:
    report['finalTasks'] = []
    for task in created:
        try:
            api(task['owner'], f'/v1/tasks/{task["id"]}/pause', {})
            current = read(task)
            report['finalTasks'].append({k: current[k] for k in
                ['id', 'ownerId', 'agentId', 'agentVersion', 'mode', 'status', 'revision', 'publishedRevision', 'runs']})
        except Exception:
            pass
    report['totalRuns'] = sum(len(t['runs']) for t in report['finalTasks'])
    report['elapsedSeconds'] = round(time.monotonic() - started, 3)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
