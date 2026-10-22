"""Bounded real-model acceptance for task adapters in an isolated service.

Synthetic calendar/observation events and notes only; no real phone or notification.
Credentials are read from the isolated server's local data file and never reported.
"""
import datetime,json,time,uuid,urllib.request,argparse
from pathlib import Path

p=argparse.ArgumentParser()
p.add_argument('--base',default='http://127.0.0.1:4491')
p.add_argument('--data',required=True)
p.add_argument('--output',required=True)
p.add_argument('--source-commit',help='Commit of the service being verified')
a=p.parse_args()
assert a.base=='http://127.0.0.1:4491', 'Use the isolated verification endpoint'
users=json.loads((Path(a.data)/'meeting-lab-identities.json').read_text())
token=users[0]['token']
report={'mode':'deepseek','sourceCommit':a.source_commit,'inputs':'synthetic events and notes','notificationsSent':False,'passed':False,'checks':[]}
created=[]
def api(path,body=None,auth=token):
    req=urllib.request.Request(a.base+path,data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type':'application/json','Authorization':'Bearer '+auth})
    with urllib.request.urlopen(req,timeout=15) as response: return json.load(response)
def wait(task,revision):
    deadline=time.monotonic()+105
    while time.monotonic()<deadline:
        value=api('/v1/tasks/'+task['id'])
        assert not value.get('error'), 'Agent generation failed'
        if value['publishedRevision']==revision:
            assert value['runs'][-1]['status']=='completed'
            assert value['runs'][-1]['usage']['totalTokens']>0
            assert '[MOCK]' not in json.dumps(value['output'])
            view=api('/v1/tasks/'+task['id']+'/view')
            assert len(view['messages'])==3
            report['checks'].append({'agentId':value['agentId'],'revision':revision,'output':value['output'],
                'trace':value['runs'][-1]['trace'],'usage':value['runs'][-1]['usage'],'a2uiMessages':len(view['messages'])})
            return value['output']
        time.sleep(.3)
    raise AssertionError('Timed out waiting for published output')
def emit(task,sequence,content):
    event={'eventId':str(uuid.uuid4()),'sequence':sequence,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if task['agentId']=='meeting-prep':
        event['meeting']={'title':'发布评审','agenda':content,'startAt':'2026-11-03T10:00:00+08:00'}
    else: event['observation']={'sourceId':'release-status','title':'发布状态','content':content}
    api('/v1/device/tasks/'+task['id']+'/events',event,task['device'])
started=time.monotonic()
try:
    for agent in ['meeting-prep','information-watch']:
        result=api('/v1/tasks',{'name':'Studio改造后的任务兼容验收','agentId':agent,'mode':'deepseek',
            'instruction':'关注延期与回滚，摘要保留资料编号RULE-731。仅严重变更建议提醒。',
            'config':{'sourceId':'release-status'} if agent=='information-watch' else {},
            'notes':[{'id':'RULE-731','text':'合成规则RULE-731：负责人林舟；延期超过30分钟或出现阻断项建议提醒；回滚前应停止新设备调用。'}]})
        task={'id':result['task']['id'],'agentId':agent,'device':result['deviceToken']}; created.append(task)
        api('/v1/device/tasks/'+task['id']+'/ack',{'commandId':task['id']},task['device'])
        emit(task,1,'计划18:00上线，无阻断项；评审回滚方案。')
        output=wait(task,1)
        assert 'RULE-731' in output['sourceIds'] and 'RULE-731' in output['summary']
        if agent=='information-watch':
            assert output['change']=='initial' and output['notification']=='quiet'
            emit(task,2,'上线从18:00推迟到20:00，新增阻断项：设备结果回传超时。')
            output=wait(task,2)
            assert output['change']=='changed' and output['notification']=='notify'
    report['passed']=True
finally:
    for task in created: api('/v1/tasks/'+task['id']+'/pause',{})
    report['elapsedSeconds']=round(time.monotonic()-started,3)
    Path(a.output).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'passed':report['passed'],'realRuns':len(report['checks']),'elapsedSeconds':report['elapsedSeconds']}))
