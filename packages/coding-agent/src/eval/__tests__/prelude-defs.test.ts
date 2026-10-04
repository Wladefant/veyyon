import { describe, expect, it } from "bun:test";
import { types } from "node:util";
import * as vm from "node:vm";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../js/shared/prelude";

describe("eval js defs() prelude helper", () => {
	it("lists variable names and type/shape only without leaking secret values or representations", () => {
		const sandbox: Record<string, unknown> = {
			__veyyon_call_tool__: async () => ({}),
			__veyyon_helpers__: { isProxy: types.isProxy },
		};
		vm.createContext(sandbox);
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);

		const userScript = `
// Seeded arbitrary opaque secret strings
secretToken = "secret-token-opaque-jwt-xyz-98765";
apiKey = "bearer-secret-api-key-4321";
emptyString = "";

// Nested collections containing secrets
nestedArray = [
	"secret-array-item-alpha",
	{ secretNestedKey: "secret-nested-val" },
	["secret-deep-elem-1", "secret-deep-elem-2"],
];
nestedObject = {
	secretKeyA: "secretValA",
	innerObj: { secretInnerKey: "secretInnerVal" },
};
emptyArray = [];
emptyObject = {};

// Function bodies containing secrets
function secretWorker() {
	const innerSecret = "secret-inside-function-body-999";
	return innerSecret;
}
secretArrow = () => "secret-inside-arrow-body-888";

// Objects with hostile toString / representation hooks / getters / custom constructors
class HostileConstructorClass {
	constructor() {
		this.secretInstanceField = "secret-in-instance";
	}
	toString() {
		return "SECRET_LEAK_VIA_CONSTRUCTOR_TO_STRING_12345";
	}
}
hostileInstance = new HostileConstructorClass();

hostileToStringObj = {
	propA: 1,
	propB: 2,
	toString() {
		return "SECRET_LEAK_VIA_OBJECT_TO_STRING_54321";
	},
};

hostileGetterObj = {
	get dangerousSecretGetter() {
		throw new Error("hostile getter must not be invoked during defs formatting");
	},
	regularProp: 42,
};

hostileSymbolObj = {
	get [Symbol.toStringTag]() {
		throw new Error("hostile Symbol.toStringTag must not be invoked");
	},
	sampleKey: "val",
};

// Scalar types and null
scalarNumber = 12345;
scalarBool = true;
scalarNull = null;
scalarBigInt = 9007199254740991n;
scalarSymbol = Symbol("secret-symbol-description");
scalarUndefined = undefined;
`;

		vm.runInContext(userScript, sandbox);

		const defsFn = sandbox.defs as () => string[];
		expect(typeof defsFn).toBe("function");

		const entries = defsFn();

		// Assert output contains no secret substrings
		const secretSubstrings = [
			"secret-token-opaque-jwt-xyz-98765",
			"bearer-secret-api-key-4321",
			"secret-array-item-alpha",
			"secretNestedKey",
			"secret-nested-val",
			"secret-deep-elem-1",
			"secret-deep-elem-2",
			"secretValA",
			"secretInnerKey",
			"secretInnerVal",
			"secret-inside-function-body-999",
			"secret-inside-arrow-body-888",
			"SECRET_LEAK_VIA_CONSTRUCTOR_TO_STRING_12345",
			"SECRET_LEAK_VIA_OBJECT_TO_STRING_54321",
			"secret-in-instance",
			"secret-symbol-description",
			"HostileConstructorClass",
		];

		const serializedOutput = JSON.stringify(entries);
		for (const secret of secretSubstrings) {
			expect(serializedOutput).not.toContain(secret);
		}

		// Assert output lists variable names and types/shapes only according to the contract:
		// JS null, Array(n), object(n keys), function, or typeof only; never source or constructor name.
		expect(entries).toContain("secretToken: string");
		expect(entries).toContain("apiKey: string");
		expect(entries).toContain("emptyString: string");
		expect(entries).toContain("nestedArray: Array(3)");
		expect(entries).toContain("nestedObject: object(2 keys)");
		expect(entries).toContain("emptyArray: Array(0)");
		expect(entries).toContain("emptyObject: object(0 keys)");
		expect(entries).toContain("secretWorker: function");
		expect(entries).toContain("secretArrow: function");
		expect(entries).toContain("hostileInstance: object(1 keys)");
		expect(entries).toContain("hostileToStringObj: object(3 keys)");
		expect(entries).toContain("hostileGetterObj: object(2 keys)");
		expect(entries).toContain("hostileSymbolObj: object(1 keys)");
		expect(entries).toContain("scalarNumber: number");
		expect(entries).toContain("scalarBool: boolean");
		expect(entries).toContain("scalarNull: null");
		expect(entries).toContain("scalarBigInt: bigint");
		expect(entries).toContain("scalarSymbol: symbol");
		expect(entries).toContain("scalarUndefined: undefined");
	});

	it("avoids calling representation hooks or getters on metadata inspection", () => {
		const sandbox: Record<string, unknown> = {
			__veyyon_call_tool__: async () => ({}),
			__veyyon_helpers__: { isProxy: types.isProxy },
		};
		vm.createContext(sandbox);
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);

		let getterInvoked = false;
		let toStringInvoked = false;
		let valueOfInvoked = false;

		const hostileMetadataObj = {
			get sensitiveSecretProperty() {
				getterInvoked = true;
				return "LEAKED_SECRET_PROPERTY_VALUE";
			},
			toString() {
				toStringInvoked = true;
				return "LEAKED_TO_STRING_VALUE";
			},
			valueOf() {
				valueOfInvoked = true;
				return "LEAKED_VALUE_OF_VALUE";
			},
			safeField: "safe",
		};

		sandbox.hostileMetadataObj = hostileMetadataObj;

		const defsFn = sandbox.defs as () => string[];
		const entries = defsFn();

		expect(getterInvoked).toBe(false);
		expect(toStringInvoked).toBe(false);
		expect(valueOfInvoked).toBe(false);

		expect(entries).toContain("hostileMetadataObj: object(4 keys)");

		const serializedOutput = JSON.stringify(entries);
		expect(serializedOutput).not.toContain("LEAKED_SECRET_PROPERTY_VALUE");
		expect(serializedOutput).not.toContain("LEAKED_TO_STRING_VALUE");
		expect(serializedOutput).not.toContain("LEAKED_VALUE_OF_VALUE");
	});

	it("handles Proxy array length returning opaque secret string without leaking secret", () => {
		const sandbox: Record<string, unknown> = {
			__veyyon_call_tool__: async () => ({}),
			__veyyon_helpers__: { isProxy: types.isProxy },
		};
		vm.createContext(sandbox);
		vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);

		const secretToken = "opaque-secret-proxy-array-length-sentinel-xyz";
		let lengthReads = 0;
		const forgedArray = new Proxy([], {
			get(target, prop, receiver) {
				if (prop === "length") {
					lengthReads++;
					return secretToken;
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		sandbox.forgedArray = forgedArray;

		const defsFn = sandbox.defs as () => string[];
		const entries = defsFn();

		// Assert defs output contains no secret string
		const serializedOutput = JSON.stringify(entries);
		expect(serializedOutput).not.toContain(secretToken);
		expect(lengthReads).toBe(0);

		// Assert entry still lists name and Array without string interpolation of forged length
		expect(entries).toContain("forgedArray: Array");
	});
});
