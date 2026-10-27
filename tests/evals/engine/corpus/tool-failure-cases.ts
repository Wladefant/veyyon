import type { ToolFailureCase } from "./tool-failure-case";

export const TOOL_FAILURE_CASES = [
	{
		"schemaVersion": 1,
		"id": "tf695-01",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read",
				"github"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "repo/target.ps1:1",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "github",
					"arguments": {
						"op": "file_read",
						"repo": "example/project",
						"branch": "<revision>",
						"path": "repo/target.ps1",
						"pr": null,
						"force": null,
						"forceWithLease": null,
						"title": null,
						"body": null,
						"base": null,
						"head": null,
						"draft": null,
						"fill": null,
						"reviewer": null,
						"assignee": null,
						"label": null,
						"query": null,
						"since": null,
						"until": null,
						"dateField": null,
						"limit": null,
						"run": null,
						"tail": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-01",
			"observation": "The later successful result contains nonempty text content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "github",
				"arguments": {
					"op": "file_read",
					"repo": "example/project",
					"branch": "<revision>",
					"path": "repo/target.ps1",
					"pr": null,
					"force": null,
					"forceWithLease": null,
					"title": null,
					"body": null,
					"base": null,
					"head": null,
					"draft": null,
					"fill": null,
					"reviewer": null,
					"assignee": null,
					"label": null,
					"query": null,
					"since": null,
					"until": null,
					"dateField": null,
					"limit": null,
					"run": null,
					"tail": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "nonempty text content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-02",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.py:1-2;local://artifact2.txt:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.py:1-2",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-03",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.py:1-2",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-03",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.txt:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.txt",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-04",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.txt",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-04",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "repo/target.xml:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "repo/target.xml",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-05",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "repo/target.xml",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-05",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;C:/repo/target.md",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.txt",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-06",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.txt",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-06",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;local://artifact2.txt",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.txt",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-07",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.txt",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-07",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;skill://artifact2;skill://artifact3",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "skill://artifact1;skill://artifact2",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-08",
			"observation": "The later successful result contains nonempty text content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "skill://artifact1;skill://artifact2",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "nonempty text content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-08",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt:1-2;local://artifact2.txt:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.txt:1-2",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-09",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt:1-2",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-09",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json;local://artifact2.json;local://artifact3.json",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-10",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-10",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json;local://artifact2.json:1-2;local://artifact3.json:1-2;local://artifact4.json:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-12",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-11",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json;local://artifact2.json:1-2;local://artifact3.json",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-14",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-12",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json;local://artifact2.json;local://artifact3.txt",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-16",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-13",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;local://artifact2.txt;local://artifact3.txt;skill://artifact4;skill://artifact5",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.txt",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-18",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-14",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2;local://artifact2.json:1-2;local://artifact3.json:1-2;local://artifact4.json",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-19",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-15",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;local://artifact2.json;skill://artifact3;skill://artifact4;skill://artifact5",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "skill://artifact1",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-21",
			"observation": "The later successful result contains Markdown document content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "skill://artifact1",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "Markdown document content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-16",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.jsonl:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.jsonl",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-24",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.jsonl",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-17",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json;local://artifact2.json;local://artifact3.txt;local://artifact4.json",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-25",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-18",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2;local://artifact2.txt:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json:1-2",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-27",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-19",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2;local://artifact2.json:1-2;local://artifact3.json:1-2;local://artifact4.json:1-2;local://artifact5.json:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-28",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-20",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;local://artifact2.txt",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.txt",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-31",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-21",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2:raw;local://artifact2.json:1-2:raw",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-32",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-22",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;local://artifact2.tsv:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.txt",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-33",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-23",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "./dir/target.md:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "./dir/target.md",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-35",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "./dir/target.md",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-24",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2;local://artifact2.tsv:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json:1-2",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-37",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-25",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.json:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.json",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-38",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.json",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-26",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;local://artifact2.json",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.txt",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-39",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-27",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2;local://artifact2.txt:1-2;local://artifact3.tsv:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.json:1-2",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-40",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.json:1-2",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-29",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt:1-2;local://artifact2.txt:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.txt",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-42",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-31",
		"incidentFamily": "edit-stale-anchor-refresh",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"edit",
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "edit",
				"arguments": {
					"input": "*** Begin Patch\n[local://ledger.tsv#AAAA]\nINS.POST 1:\n+item value\n*** End Patch"
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.tsv:1-2",
						"depth": null,
						"limit": null
					}
				},
				{
					"tool": "edit",
					"arguments": {
						"input": "*** Begin Patch\n[local://ledger.tsv#BBBB]\nINS.POST 1:\n+item value\n*** End Patch"
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-44",
			"observation": "The stale-anchor edit failed; after rereading the current file, a fresh-anchor edit succeeded and returned the updated file snapshot.",
			"successfulCall": {
				"tool": "edit",
				"arguments": {
					"input": "*** Begin Patch\n[local://ledger.tsv#BBBB]\nINS.POST 1:\n+item value\n*** End Patch"
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "updated file snapshot with inserted sanitized ledger rows"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-32",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.tsv:1-2;skill://artifact2;skill://artifact3",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "local://artifact1.tsv:1-2",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-45",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.tsv:1-2",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-33",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "repo/target.sh:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.sh",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-46",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.sh",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-34",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.mjs:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.mjs",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-47",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.mjs",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-35",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "local://artifact1.txt;local://artifact2.txt;skill://artifact3;skill://artifact4",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "skill://artifact1",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-51",
			"observation": "The later successful result contains Markdown document content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "skill://artifact1",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "Markdown document content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	},
	{
		"schemaVersion": 1,
		"id": "tf695-36",
		"incidentFamily": "read-selector-resolution",
		"category": "failure-recovery",
		"input": {
			"toolSet": [
				"read"
			],
			"priorMessages": [
				{
					"role": "user",
					"content": "Retrieve or update the requested review artifact."
				},
				{
					"role": "assistant",
					"content": "Use the supplied target and selector."
				}
			],
			"call": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.json:1-2",
					"depth": null,
					"limit": null
				}
			}
		},
		"expected": {
			"requiredCalls": [
				{
					"tool": "read",
					"arguments": {
						"path": "C:/repo/target.json:1-2",
						"depth": null,
						"limit": null
					}
				}
			],
			"forbiddenTools": [],
			"outcome": "The intended artifact is read or updated after the failed call is recovered."
		},
		"provenance": {
			"kind": "later-success",
			"evidenceKey": "evidence-row-53",
			"observation": "The later successful result contains source snapshot header and line-numbered content; the private ledger records event pointers.",
			"successfulCall": {
				"tool": "read",
				"arguments": {
					"path": "C:/repo/target.json:1-2",
					"depth": null,
					"limit": null
				}
			},
			"result": {
				"isError": false,
				"payloadShape": "source snapshot header and line-numbered content"
			}
		},
		"limitations": [
			"Only tools demonstrated in the failed and recovery calls are listed; the complete offered set is unknown.",
			"Paths, identifiers, revisions, source text, and returned content are neutralized.",
			"Selector type, drive/path dialect, list separators, and recovery-call shape are preserved."
		]
	}
] satisfies ToolFailureCase[];
