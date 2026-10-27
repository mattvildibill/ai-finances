#!/usr/bin/env python3
"""Push the exact source via an ephemeral credential supplied on stdin. Never log it."""
import sys,json,os,subprocess
c=json.loads(sys.stdin.readline()); env=os.environ.copy()
if c.get('token'):
 env.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='http.extraHeader',GIT_CONFIG_VALUE_0='Authorization: Bearer '+c['token'])
result=subprocess.run(['git','push',c['remote_url'],'HEAD:'+c['branch']],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
print(json.dumps({'ok':result.returncode==0,'returncode':result.returncode}))
if result.returncode: print(result.stderr.replace(c.get('token','NEVER_MATCH_THIS'), '[redacted]')[:2000])
sys.exit(result.returncode)
