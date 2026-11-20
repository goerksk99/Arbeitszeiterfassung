import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packager } from "@electron/packager";

const output = resolve(".desktop");
const staging = await mkdtemp(resolve(output, "stage-"));
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const { version: electronVersion } = JSON.parse(await readFile("node_modules/electron/package.json", "utf8"));

try {
  await cp("desktop/main.cjs", resolve(staging, "main.cjs"));
  await cp("desktop/preload.cjs", resolve(staging, "preload.cjs"));
  await cp(resolve(output, "renderer"), resolve(staging, "renderer"), { recursive: true });
  await writeFile(resolve(staging, "package.json"), JSON.stringify({
    name: "arbeitszeiterfassung", version, main: "main.cjs",
  }));
  const out = resolve(output, "release");
  await mkdir(out, { recursive: true });
  const builds = await packager({
    dir: staging,
    name: "Arbeitszeiterfassung",
    platform: process.env.AZ_DESKTOP_PLATFORM ?? "win32",
    arch: "x64",
    electronVersion,
    download: { cacheRoot: resolve(output, "cache") },
    out,
    overwrite: true,
    asar: true,
  });
  for (const build of builds) console.log(build);
} finally {
  await rm(staging, { recursive: true, force: true });
}
