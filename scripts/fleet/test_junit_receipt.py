import unittest
from junit_receipt import summarize


class JUnitReceiptTests(unittest.TestCase):
    def test_requires_executed_passing_case(self):
        report = summarize(b'<testsuites><testsuite><testcase name="real" classname="fixture"/></testsuite></testsuites>', 'a'*40)
        self.assertEqual(report['verdict'], 'pass')
        self.assertEqual(report['executed'], 1)
        self.assertFalse(report['live_workers_tested'])
        self.assertFalse(report['full_typecheck_executed'])

    def test_empty_skipped_failed_and_suite_setup_errors_are_not_success(self):
        for body in (b'<testsuite/>', b'<testsuite><testcase name="x"><skipped/></testcase></testsuite>',
                     b'<testsuite><testcase name="x"><failure/></testcase></testsuite>',
                     b'<testsuite errors="1"><testcase name="x"/></testsuite>'):
            with self.subTest(body=body):
                self.assertEqual(summarize(body,'a'*40)['verdict'], 'fail')

    def test_duplicate_tests_and_entities_are_rejected(self):
        for body in (b'<testsuite><testcase name="x"/><testcase name="x"/></testsuite>',
                     b'<!DOCTYPE a [<!ENTITY x "bad">]><testsuite/>'):
            with self.subTest(body=body), self.assertRaises(ValueError):
                summarize(body, 'a'*40)

    def test_printing_a_case_does_not_execute_one(self):
        body = b'<testsuite><system-out>&lt;testcase name="fake"/&gt;</system-out></testsuite>'
        self.assertEqual(summarize(body, 'a'*40)['verdict'], 'fail')


if __name__ == '__main__':
    unittest.main()
