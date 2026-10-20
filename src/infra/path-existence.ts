import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { isMissingPathError } from "./errno.js";

/** Only definite absence, including a non-directory ancestor, permits an absent verdict. */
export function pathMayExistSync(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

/** Inspect links themselves; only definite absence permits an absent result. */
export async function lstatIfExists(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fsPromises.lstat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}
