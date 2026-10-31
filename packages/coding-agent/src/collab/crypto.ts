/**
 * Room keys and write tokens for collab sessions.
 *
 * The sealed-frame layout and its primitives live in `@veyyon/wire` alongside the frame grammar,
 * because this host seals what the browser guest opens. Frames are sealed and opened by the relay
 * client (`@veyyon/wire/relay-client`); this module re-exports the key material the host and guest
 * mint and import.
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 */
export { generateRoomKey, generateWriteToken, importRoomKey } from "@veyyon/wire";
