#!/usr/bin/env python3
"""Validate actual bounded JUnit evidence; fixture success is not live-host proof."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

LIMIT = 8 * 1024 * 1024
SHA = re.compile(r'^[0-9a-f]{40}$')


def summarize(raw: bytes, head: str) -> dict:
    if not SHA.fullmatch(head):
        raise ValueError('exact source SHA required')
    if len(raw) > LIMIT or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('oversized or unsafe XML report')
    root = ET.fromstring(raw)
    if root.tag not in ('testsuite', 'testsuites'):
        raise ValueError('expected JUnit test suites')
    cases = []
    seen = set()
    for case in root.iter('testcase'):
        name, classname = case.get('name'), case.get('classname', '')
        if not name or (classname, name) in seen:
            raise ValueError('missing or duplicate test identity')
        seen.add((classname, name))
        status = ('failed' if case.find('failure') is not None or case.find('error') is not None
                  else 'skipped' if case.find('skipped') is not None else 'passed')
        cases.append({'name': name, 'class': classname, 'status': status})
    counts = {name: sum(c['status'] == name for c in cases) for name in ('passed','failed','skipped')}
    # Suite-level failure counters can include setup failures with no testcase.
    suite_failure = False
    for suite in root.iter():
        if suite.tag not in ('testsuite', 'testsuites'):
            continue
        for key in ('failures', 'errors'):
            value = suite.get(key, '0')
            if not value.isdecimal():
                raise ValueError('invalid JUnit failure count')
            suite_failure |= int(value) > 0
    return {'schema_version': 1, 'head_sha': head, 'evidence_kind': 'adapter-fixture-tests',
            **counts, 'executed': counts['passed'] + counts['failed'], 'cases': cases,
            'verdict': 'pass' if counts['passed'] > 0 and not counts['failed'] and not suite_failure else 'fail',
            'live_workers_tested': False, 'provider_requests_executed': False,
            'full_typecheck_executed': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--head-sha', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        with args.input.open('rb') as handle:
            report = summarize(handle.read(LIMIT + 1), args.head_sha)
    except (OSError, ValueError, ET.ParseError):
        report = {'schema_version':1, 'head_sha':args.head_sha, 'verdict':'fail',
                  'executed':0, 'error':'test report absent or invalid', 'live_workers_tested':False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps(report, sort_keys=True))
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
