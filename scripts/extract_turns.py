#!/usr/bin/env python3
import json, re, sys
with open('docs/audit/copilot-session-ab5315cf.jsonl') as f:
    events = [json.loads(l) for l in f if l.strip()]
rows = []
turn = 0
i = 0
while i < len(events):
    ev = events[i]
    if ev['type'] == 'user.message':
        turn += 1
        ts = ev.get('timestamp', '')[:19].replace('T', ' ')
        text = ev.get('data', {}).get('content') or ''
        if isinstance(text, list):
            text = ' '.join(
                str(p.get('text', '')) if isinstance(p, dict) else str(p)
                for p in text
            )
        text = (text or '').strip()
        text = re.sub(r'<context>.*?</context>', '', text, flags=re.S)
        text = re.sub(r'<environment_info>.*?</environment_info>', '', text, flags=re.S)
        text = re.sub(r'<editorContext>.*?</editorContext>', '', text, flags=re.S)
        text = re.sub(r'<reminderInstructions>.*?</reminderInstructions>', '', text, flags=re.S)
        m = re.search(r'<userRequest>(.*?)</userRequest>', text, flags=re.S)
        if m:
            text = m.group(1)
        text = re.sub(r'\s+', ' ', text).strip()
        j = i + 1
        tools = 0
        while j < len(events) and events[j]['type'] != 'user.message':
            if events[j]['type'] == 'tool.execution_start':
                tools += 1
            j += 1
        snippet = text[:140] + ('…' if len(text) > 140 else '')
        rows.append((turn, ts, tools, snippet))
        i = j
    else:
        i += 1

print('| # | 时间 (UTC) | 工具调用 | 用户请求摘要 |')
print('|---|------------|----------|--------------|')
for t, ts, tc, sn in rows:
    sn = sn.replace('|', '\\|')
    print(f'| {t} | {ts} | {tc} | {sn} |')
