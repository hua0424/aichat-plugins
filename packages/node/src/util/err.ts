/** Normalize an unknown thrown value to a string message: `Error.message`, else `String(value)`. */
export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
