import { getThemeByName, type Theme } from "@veyyon/coding-agent/theme/theme";

/** The theme called `name`; a suite that names a theme the build does not ship fails here. */
export async function requireTheme(name: string): Promise<Theme> {
	const found = await getThemeByName(name);
	if (!found) throw new Error(`No theme is named ${name}`);
	return found;
}
