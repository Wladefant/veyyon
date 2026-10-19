/**
 * The composer draft as a submission sees it: the text with the images and blob links that ride along,
 * taken from the editor without aliasing its pending arrays, and put back when the submission does not go out.
 */
import type { ImageContent } from "@veyyon/ai";
import type { InputControllerContext } from "./input-controller";

type DraftEditor = InputControllerContext["editor"];

/** A submission's text with the images and blob links that ride along with it. */
export interface SubmittedInput {
	text: string;
	images: ImageContent[] | undefined;
	imageLinks: (string | undefined)[] | undefined;
}

/** A copy of `items`, or undefined when there are none, so a submission never aliases the editor's pending arrays. */
export function nonEmptyCopy<T>(items: readonly T[] | undefined): T[] | undefined {
	return items && items.length > 0 ? items.slice() : undefined;
}

/** Drops the editor's pending images and their links. */
export function clearEditorImages(editor: DraftEditor): void {
	editor.imageLinks = undefined;
	editor.pendingImages = [];
	editor.pendingImageLinks = [];
}

/** Puts a submission that did not go out back in the editor: its text, and its images with their links. */
export function restoreDraft(
	editor: DraftEditor,
	text: string,
	images: readonly ImageContent[] | undefined,
	imageLinks: readonly (string | undefined)[] | undefined,
): void {
	editor.setText(text);
	if (!images) return;
	editor.pendingImages = [...images];
	editor.pendingImageLinks = imageLinks ? [...imageLinks] : images.map(() => undefined);
	editor.imageLinks = editor.pendingImageLinks;
}

/** Copies of the editor's pending images and their links; links are undefined without images. */
export function pendingDraftImages(editor: DraftEditor): Pick<SubmittedInput, "images" | "imageLinks"> {
	const images = nonEmptyCopy(editor.pendingImages);
	return { images, imageLinks: images && nonEmptyCopy(editor.pendingImageLinks) };
}
