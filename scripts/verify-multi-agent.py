#!/usr/bin/env python3
"""Bounded mixed-domain server acceptance; all observations and notes are synthetic.

Uses server-loaded model credentials. Demo identity tokens remain in memory and
are excluded from reports and subprocess arguments. No notification is sent.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
import uuid

p = argparse.ArgumentParser()
p.add_argument('--base', default='http://127.0.0.1:4391')
p.add_argument('--container', choices=['xagent-mastra-lab'], default='xagent-mastra-lab')
p.add_argument('--mode', choices=['mock', 'deepseek'], default='deepseek')
p.add_argument('--restart', action='store_true')
p.add_argument('--output', default='docs/multi-agent-verification.json')
a = p.parse_args()
started = time.monotonic()
created = []
r = {'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mode': a.mode,
     'scope': 'server-only', 'sources': 'synthetic-observations-and-task-local-notes',
     'notificationsSent': False, 'a2uiValidation': 'mandatory-before-publication', 'passed': False, 'checks': []}


def api(token, path, body=None, expected=200):
    request = urllib.request.Request(a.base + path, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status, value = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, value = error.code, json.load(error)
    assert status == expected, f'HTTP {status}, expected {expected}, code={value.get("error", "unknown")}'
    return value


def detail(task):
    return api(task['owner'], '/v1/tasks/' + task['id'])


def wait(task, revision):
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        value = detail(task)
        assert not value.get('error'), 'Run failed: ' + str(value.get('error'))
        if value['publishedRevision'] == revision:
            return value
        time.sleep(.15)
    raise AssertionError('Published revision timed out')


def emit(task, sequence, text, expected=202, source=None):
    payload = {'eventId': str(uuid.uuid4()), 'sequence': sequence,
               'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if task['agent'] == 'meeting-prep':
        payload['meeting'] = {'title': '服务协调会', 'agenda': text, 'startAt': '2026-10-30T10:00:00+08:00'}
    else:
        payload['observation'] = {'sourceId': source or task['source'], 'title': '服务维护公告', 'content': text}
    receipt = api(task['device'], f'/v1/device/tasks/{task["id"]}/events', payload, expected)
    return payload, receipt


def check(name, **evidence):
    r['checks'].append({'name': name, 'passed': True, **evidence})
    print(json.dumps({'check': name, 'passed': True}, ensure_ascii=False), flush=True)


def canonical(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


try:
    health = api(None, '/health')
    assert {'meeting-prep', 'information-watch'} <= set(health.get('agentIds', []))
    assert a.mode != 'deepseek' or health['deepseekConfigured']
    metadata = subprocess.run(['docker', 'exec', a.container, 'node', '-p',
        "JSON.stringify({model:process.env.DEEPSEEK_MODEL||'deepseek-flash',node:process.version})"],
        check=True, capture_output=True, text=True)
    r['runtime'] = json.loads(metadata.stdout)
    result = subprocess.run(['docker', 'exec', a.container, 'node', '-e',
        "process.stdout.write(require('fs').readFileSync('/app/data/meeting-lab-identities.json','utf8'))"],
        check=True, capture_output=True, text=True)
    users = json.loads(result.stdout)
    preexisting = []
    for user in users:
        tasks = api(user['token'], '/v1/tasks')['tasks']
        assert not any(t['status'] == 'active' for t in tasks), 'Unrelated active tasks; do not restart'
        preexisting.extend({'id': t['id'], 'owner': user['token'], 'revision': t['publishedRevision'],
                            'outputHash': canonical(t.get('output'))} for t in tasks)
    old_snapshot = Path('docs/pre-second-agent-snapshot.json')
    migration_count = 0
    if old_snapshot.exists():
        credentials = {u['userId']: u['token'] for u in users}
        for prior in json.loads(old_snapshot.read_text())['tasks']:
            value = api(credentials[prior['ownerId']], '/v1/tasks/' + prior['id'])
            assert value['publishedRevision'] == prior['publishedRevision']
            assert canonical(value.get('brief')) == prior['briefHash']
            assert value['output'] == value['brief']
            migration_count += 1
        r['legacyMeetingResultsVerified'] = migration_count
    assert not any(v['status'] in ['running', 'waiting_device'] for v in api(None, '/runs')['runs'])

    for i, user in enumerate(users):
        for agent in ['meeting-prep', 'information-watch']:
            marker = 'NOTE-' + uuid.uuid4().hex[:8]
            source = 'SOURCE-' + uuid.uuid4().hex[:8]
            result = api(user['token'], '/v1/tasks', {'agentId': agent, 'mode': a.mode, 'name': f'{agent}-{i}',
                'instruction': '结合实际资料，摘要原样保留独特编号。关注影响服务可用性的维护变更；重要变更应提醒。',
                'config': {'sourceId': source} if agent == 'information-watch' else {},
                'notes': [{'id': marker, 'text': f'授权资料编号 {marker}。服务每天 10:00 至 18:00 对外开放。维护影响开放时段时需要提醒并建议调整安排。'}]}, 201)
            task = {'id': result['task']['id'], 'owner': user['token'], 'device': result['deviceToken'],
                    'agent': agent, 'source': source, 'marker': marker}
            created.append(task)
            cmd = api(task['device'], f'/v1/device/tasks/{task["id"]}/commands')['commands'][0]
            assert cmd['tool'] == ('watchCalendar' if agent == 'meeting-prep' else 'watchInformation')
            api(task['device'], f'/v1/device/tasks/{task["id"]}/ack', {'commandId': task['id']})
            assert not detail(task)['runs']
            emit(task, 1, '原始安排：凌晨 02:00 维护，不影响开放时间。')

    initial = []
    for task in created:
        value = wait(task, 1)
        assert task['marker'] in value['output']['summary'], 'Actual task-local retrieval must affect result'
        assert task['marker'] in value['output']['sourceIds']
        serialized = json.dumps(value['output'], ensure_ascii=False)
        assert '[MOCK]' not in serialized or a.mode == 'mock'
        for other in created:
            if other['id'] != task['id']:
                assert other['marker'] not in serialized
        trace = [v['tool'] for v in value['runs'][-1]['trace']]
        required = (['searchMeetingNotes', 'submitBrief'] if task['agent'] == 'meeting-prep' else
                    ['readPreviousObservation', 'searchReferenceNotes', 'submitInspection'])
        assert set(trace) <= set(required) and all(name in trace for name in required)
        assert all(trace.index(name) < trace.index(required[-1]) for name in required[:-1])
        if task['agent'] == 'information-watch':
            assert value['output']['change'] == 'initial' and value['output']['notification'] == 'quiet'
        else:
            assert value['brief'] == value['output']
        assert len(api(task['owner'], f'/v1/tasks/{task["id"]}/view')['messages']) == 3
        initial.append({'taskId': task['id'], 'ownerId': value['ownerId'], 'agentId': task['agent'], 'output': value['output']})
    check('two_users_two_agent_types_four_isolated_tasks', outputs=initial)

    target = created[1]
    api(users[1]['token'], '/v1/tasks/' + target['id'], expected=404)
    api(created[3]['device'], f'/v1/device/tasks/{target["id"]}/commands', expected=401)
    emit(target, 2, 'wrong source', expected=403, source=created[3]['source'])
    bad = {'eventId': str(uuid.uuid4()), 'sequence': 2, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'meeting': {'title': 'x', 'agenda': 'x', 'startAt': '2026-10-30T10:00:00+08:00'}}
    api(target['device'], f'/v1/device/tasks/{target["id"]}/events', bad, 400)
    check('cross_user_cross_subscription_cross_source_and_wrong_domain_rejected')

    changed_text = '维护变更：改为 14:00 至 16:00 停机，影响开放时段。摘要明确包含“停机”。'
    payload, _ = emit(target, 2, changed_text)
    value = wait(target, 2)
    assert value['output']['change'] == 'changed' and value['output']['notification'] == 'notify'
    assert '停机' in value['output']['summary']
    count = len(value['runs'])
    receipt = api(target['device'], f'/v1/device/tasks/{target["id"]}/events', payload, 202)
    assert receipt['duplicate']
    api(target['device'], f'/v1/device/tasks/{target["id"]}/events', {**payload, 'sequence': 3}, 409)
    emit(target, 1, 'stale', expected=409)
    assert len(detail(target)['runs']) == count
    check('baseline_comparison_changes_decision_and_duplicates_do_not_rerun', output=value['output'])

    emit(target, 3, changed_text)
    value = wait(target, 3)
    assert value['output']['change'] == 'unchanged' and value['output']['notification'] == 'quiet'
    check('unchanged_content_advances_result_without_notification', output=value['output'])

    api(target['owner'], f'/v1/tasks/{target["id"]}/instruction',
        {'instruction': '现在关注备用方案。摘要原样包含“备用方案”并保留资料编号。'}, 202)
    value = wait(target, 4)
    assert '备用方案' in value['output']['summary']
    assert value['output']['change'] == 'unchanged' and value['output']['notification'] == 'quiet'
    for other in created:
        if other['id'] != target['id']:
            assert detail(other)['publishedRevision'] == 1
    check('user_instruction_refresh_preserves_baseline_and_other_tasks', output=value['output'])

    meeting = created[0]
    emit(meeting, 2, '会议议程调整：讨论服务停机风险。摘要包含“停机风险”，保留资料编号。')
    value = wait(meeting, 2)
    assert '停机风险' in value['brief']['summary']
    check('meeting_agent_still_refreshes_on_the_shared_runtime', output=value['output'])

    if a.restart:
        pending = created[3]
        for task in created:
            assert all(v['status'] != 'running' for v in detail(task)['runs'])
        subprocess.run(['docker', 'stop', a.container], check=True, capture_output=True)
        event = {'eventId': str(uuid.uuid4()), 'sequence': 2,
                 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 'observation': {'sourceId': pending['source'], 'title': '服务维护公告',
                                 'content': '重启恢复：维护改至 15:00 停机。摘要原样包含“恢复核对”。'}}
        helper = """import {TaskStore} from './dist/tasks/store.js';
import {definitions} from './dist/agents/registry.js';import {readFileSync} from 'node:fs';
const x=JSON.parse(readFileSync(0,'utf8'));const s=new TaskStore('/app/data',definitions);
s.receive(x.task,x.token,x.event);s.close();"""
        try:
            subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'none', '--user', '1000:1000', '--read-only',
                '-v', str(Path('data').resolve()) + ':/app/data', 'xagent-mastra-lab:0.1.0',
                'node', '--input-type=module', '-e', helper],
                input=json.dumps({'task': pending['id'], 'token': pending['device'], 'event': event}),
                text=True, check=True, capture_output=True)
        finally:
            subprocess.run(['docker', 'start', a.container], check=True, capture_output=True)
        deadline = time.monotonic() + 30
        while True:
            try:
                api(None, '/health')
                break
            except (OSError, AssertionError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(.3)
        value = wait(pending, 2)
        assert value['output']['change'] == 'changed' and '恢复核对' in value['output']['summary']
        assert value['subscription'] == 'active'
        check('restart_recovers_inspection_event_and_previous_baseline', output=value['output'])

    api(target['owner'], f'/v1/tasks/{target["id"]}/pause', {})
    emit(target, 4, 'late', expected=410)
    cmd = api(target['device'], f'/v1/device/tasks/{target["id"]}/commands')['commands'][0]
    assert cmd['tool'] == 'stopWatchInformation'
    for task in preexisting:
        value = api(task['owner'], '/v1/tasks/' + task['id'])
        assert value['publishedRevision'] == task['revision'] and canonical(value.get('output')) == task['outputHash']
    check('pause_and_preexisting_results_preserved', preexistingTasks=len(preexisting))
    r['passed'] = True
finally:
    r['finalTasks'] = []
    for task in created:
        try:
            api(task['owner'], f'/v1/tasks/{task["id"]}/pause', {})
            value = detail(task)
            r['finalTasks'].append({k: value[k] for k in ['id', 'ownerId', 'agentId', 'agentVersion', 'mode',
                                                        'status', 'revision', 'publishedRevision', 'runs']}
                                      | {'output': value.get('output')})
        except Exception:
            pass
    r['totalRuns'] = sum(len(t['runs']) for t in r['finalTasks'])
    r['elapsedSeconds'] = round(time.monotonic() - started, 3)
    Path(a.output).parent.mkdir(parents=True, exist_ok=True)
    Path(a.output).write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding='utf-8')
