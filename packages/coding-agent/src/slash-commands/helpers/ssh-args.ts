/**
 * Shared SSH command argument grammar.
 *
 * The one reader of `/ssh add` and `/ssh remove` arguments, for the terminal controller and the CLI/ACP handlers,
 * so a host line is accepted, refused and explained the same on every surface.
 */
import type { SSHHostConfig } from "../../ssh/config-writer";
import { parseCommandArgs } from "../../utils/command-args";
import { removedOptionMessage } from "./parse";

export const SSH_ADD_USAGE =
	"Usage: /ssh add <name> <host> [user <user>] [<port>] [key <keyPath>] [desc <description>] [compat]";

export const SSH_REMOVE_USAGE = "Usage: /ssh remove <name>";

/** The option spellings `/ssh add` no longer has, keyed by bare name. */
export const SSH_ADD_REMOVED_OPTIONS: Record<string, string> = {
	host: "write the host as the second word, after the name",
	user: "write `user <user>`",
	port: "write the port as a plain integer",
	key: "write `key <keyPath>`",
	desc: "write `desc <description>`",
	compat: "write `compat` as a plain word",
};

/**
 * `/ssh remove` never had an option worth converting. Its declaration advertised a scope, which one surface refused
 * and the other read and then threw away: SSH hosts live in ONE file, so there is nothing for a scope to select.
 */
export const SSH_REMOVE_REMOVED_OPTIONS: Record<string, string> = {
	scope: "drop it — SSH hosts live in one config file, so there is no scope to choose",
};

/** A `/ssh add` line the grammar accepted, or the refusal to show for it. */
export type SshAddRequest = { name: string; config: SSHHostConfig } | { error: string };

/** The host a `/ssh remove` line names, or the refusal to show for it. */
export type SshRemoveRequest = { name: string } | { error: string };

/**
 * Parse the argument tail of `/ssh add`.
 *
 * Both required values are POSITION: token 1 is the name and token 2 is the address, so a host literally called
 * `user` or `key` needs no escaping. The optional values follow, `user`, `key` and `desc` as leading keywords because
 * their values are arbitrary text, `compat` as a bare literal, and the port by PATTERN as a bare integer.
 *
 * Reading the port by its shape is sound rather than lucky. Past position 2 this grammar reads exactly four literal
 * words — `user`, `key`, `desc`, `compat` — and none is a run of digits, so no integer can be mistaken for a word and
 * no word for a port. A keyword's value is consumed by position and never examined, so a user named `2222` is still a
 * user.
 */
export function parseSshAddArgs(rest: string): SshAddRequest {
	const tokens = parseCommandArgs(rest);
	const name = tokens[0];
	if (!name) return { error: `Host name required.\n${SSH_ADD_USAGE}` };
	if (name.startsWith("-")) return { error: removedOptionMessage(name, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
	const host = tokens[1];
	if (!host) return { error: `Host address required as the second word.\n${SSH_ADD_USAGE}` };
	if (host.startsWith("-")) return { error: removedOptionMessage(host, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };

	const config: SSHHostConfig = { host };
	const seen = new Set<string>();
	let index = 2;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token.startsWith("-")) {
			return { error: removedOptionMessage(token, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
		}
		let word: string;
		if (token === "user" || token === "key" || token === "desc") {
			const value = tokens[index + 1];
			if (!value) return { error: `Missing value after \`${token}\`.\n${SSH_ADD_USAGE}` };
			if (token === "user") config.username = value;
			else if (token === "key") config.keyPath = value;
			else config.description = value;
			word = token;
			index += 2;
		} else if (token === "compat") {
			config.compat = true;
			word = token;
			index += 1;
		} else if (/^\d+$/.test(token)) {
			// `Number.parseInt` accepts trailing garbage (parseInt("22oops") === 22),
			// so the digit test above is what keeps a typo from becoming a port.
			const port = Number(token);
			if (port < 1 || port > 65535) {
				return { error: `Invalid port: ${token}. Use an integer between 1 and 65535.\n${SSH_ADD_USAGE}` };
			}
			config.port = port;
			word = "port";
			index += 1;
		} else {
			// A WORD THE GRAMMAR USED TO READ AS AN OPTION gets the sentence naming what replaced
			// it, rather than a bare `Unknown argument`, so `/ssh add box example.com host other`
			// is told the host is the second word instead of only that `host` was not understood.
			//
			// Safe to consult the map here even though `user`, `key`, `desc` and `compat` are keys
			// in it AND live keywords: all four are consumed by the branches above, so a token
			// reaching this one is never one of them. Only `host` and `port` can match.
			if (Object.hasOwn(SSH_ADD_REMOVED_OPTIONS, token.toLowerCase())) {
				return { error: removedOptionMessage(token, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
			}
			return { error: `Unknown argument: ${token}\n${SSH_ADD_USAGE}` };
		}
		if (seen.has(word)) return { error: `\`${word}\` given twice.\n${SSH_ADD_USAGE}` };
		seen.add(word);
	}
	return { name, config };
}

/** Parse the argument tail of `/ssh remove`: exactly one host name. */
export function parseSshRemoveArgs(rest: string): SshRemoveRequest {
	const tokens = parseCommandArgs(rest);
	const name = tokens[0];
	if (!name) return { error: `Host name required.\n${SSH_REMOVE_USAGE}` };
	if (name.startsWith("-")) {
		return { error: removedOptionMessage(name, SSH_REMOVE_REMOVED_OPTIONS, SSH_REMOVE_USAGE) };
	}
	const extra = tokens[1];
	if (extra !== undefined) {
		// Same rule as `/ssh add`: a plain `scope` is refused with the reason SSH has no scope,
		// derived from the map rather than from a word written into this condition.
		return {
			error:
				extra.startsWith("-") || Object.hasOwn(SSH_REMOVE_REMOVED_OPTIONS, extra.toLowerCase())
					? removedOptionMessage(extra, SSH_REMOVE_REMOVED_OPTIONS, SSH_REMOVE_USAGE)
					: `Unknown argument: ${extra}\n${SSH_REMOVE_USAGE}`,
		};
	}
	return { name };
}
