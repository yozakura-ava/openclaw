import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function digestQualificationPaths(paths: string[]) {
  const hash = createHash("sha256");
  const visit = (root: string, file: string) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const stat = fs.lstatSync(file);
    hash.update(`${relative}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${fs.readlinkSync(file)}\0`);
    } else if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const child of fs.readdirSync(file).toSorted()) {
        visit(root, path.join(file, child));
      }
    } else if (stat.isFile()) {
      hash.update("file\0");
      hash.update(fs.readFileSync(file));
    } else {
      throw new Error(`Unsupported qualification artifact type: ${file}`);
    }
    hash.update("\0");
  };
  for (const item of paths.toSorted()) {
    const absolute = path.resolve(item);
    hash.update(`${item}\0`);
    if (fs.existsSync(absolute)) {
      visit(path.dirname(absolute), absolute);
    } else {
      hash.update("missing\0");
    }
  }
  return hash.digest("hex");
}
