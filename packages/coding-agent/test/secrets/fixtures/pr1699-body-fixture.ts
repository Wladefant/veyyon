export const PR1699_BODY_FIXTURE = `## Summary

- Map the permission-disabled Story Mode response to the unavailable notice.
- Map AI-processing-disabled to Ask a grown-up and the parent PIN route.
- Show rate limits with their minute copy and exact reset timestamp.
- Show quota limits with their actual reset date and neutral time copy.
- Show provider budget limits as busy and ask the child to try later.
- Keep default consent behavior backward compatible. The optional message preserves the existing parent-consent flow.
- Leave all unsafe-input copy to the owner of [PR #1690](https://github.com/Wladefant/heylolo-app/pull/1690).
- The existing registrations in \`src/shared/i18n/resources.ts\` (lines 165 and 226) cover Story Mode keys.
- Source pin: [pinned source commit](https://github.com/Wladefant/heylolo-app/commit/74e89ad9f7d2467f5449590ebe4b0b378902de45). This PR head is \`7ae0427e6d16adddb7e400cd022db208511d1879\`.
- Related API follow-up: [issue #601](https://github.com/Wladefant/heylolo-api/issues/601).

## CI evidence

The corrected source is pushed at this PR head. The prior CI run remains failed until the final head is verified. Candidate run [42825179770](https://github.com/Wladefant/heylolo-app/actions/runs/42825179770) reported 2,732 passed, 64 failed, 2,796 executed, and 248 selected. The 63 exact failure IDs were proven against same-period base run [42824952574](https://github.com/Wladefant/heylolo-app/actions/runs/42824952574). One suspense failure remains unclassified. These results do not make the candidate green, and do not describe the 64 as unrelated.

RED evidence: [run 42820296623](https://github.com/Wladefant/heylolo-app/actions/runs/42820296623) on \`312dd04f8b7c8bb9ddfb9257aa75c313dc388ad6\` reported 25 passed, 10 failed, 35 tests. This is prior evidence, not verification of the current PR head. Exact type/format followup commit: \`7ae0427e6d16adddb7e400cd022db208511d1879\`.

## Existing controls (R3)

This change reuses these established controls and adds no button combinations:

- Creation generic: Try again + Change answers.
- Creation quota: Back to Home.
- Retry generic: Try again + New story.
- Retry quota: Back to Home.
- Consent: Ask a grown-up → parent PIN.

Evidence links: creation generic [lines 592–605](https://github.com/Wladefant/heylolo-app/blob/74e89ad9f7d2467f5449590ebe4b0b378902de45/src/pages/child/ui/story-mode-page.tsx#L592-L605), creation quota [lines 583–591](https://github.com/Wladefant/heylolo-app/blob/74e89ad9f7d2467f5449590ebe4b0b378902de45/src/pages/child/ui/story-mode-page.tsx#L583-L591), and retry generic [lines 298–317](https://github.com/Wladefant/heylolo-app/blob/74e89ad9f7d2467f5449590ebe4b0b378902de45/src/pages/child/ui/story-page.tsx#L298-L317). Retry quota is [lines 289–297](https://github.com/Wladefant/heylolo-app/blob/74e89ad9f7d2467f5449590ebe4b0b378902de45/src/pages/child/ui/story-page.tsx#L289-L297). Parent consent is [lines 8–25](https://github.com/Wladefant/heylolo-app/blob/74e89ad9f7d2467f5449590ebe4b0b378902de45/src/shared/ui/ParentalConsentNotice/index.tsx#L8-L25).

## Native AFTER checklist — all unchecked

- [ ] Verify the installed bundle against this PR head.
- [ ] Confirm the known Story Mode disabled response selects the unavailable notice.
- [ ] Confirm AI recovery exposes only the existing parent PIN action.
- [ ] Confirm rate limits show the exact reset timestamp and minute copy.
- [ ] Confirm quota copy stays neutral and includes the full reset date.
- [ ] Confirm provider-busy states do not look like child quota exhaustion.
- [ ] Confirm English and German text wrap correctly.
- [ ] Confirm unknown errors retry, default consent and quiet-hours behavior stay unchanged.
- [ ] Confirm benign story creation reaches Chapter 2 and existing controls remain available.

Physical owner: Main / PhoneReadinessNowDirect. No device access was used for this change.

Source-only change. Not merged. Not deployed. Refs https://github.com/Wladefant/heylolo-app/issues/1224.
`;
