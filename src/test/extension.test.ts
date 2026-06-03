import * as assert from "assert";
import { collectRainbowDecorations, RainbowDecoration } from "../highlighter";

suite("Extension Test Suite", () => {
  const options = {
    includeParameters: true,
    includeVariables: true,
    includeImports: true,
  };

  test("assigns stable colors to parameters and variables in a function", () => {
    const source = `function greet(firstName: string, lastName: string) {
	const message = firstName + lastName;
	return message;
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "firstName"),
      [0, 0],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "lastName"),
      [1, 1],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "message"),
      [2, 2],
    );
  });

  test("uses a new color sequence for nested function parameters", () => {
    const source = `function outer(user: string) {
	const count = user.length;
	return [user].map((user) => {
		const label = user + count;
		return label;
	});
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );
    const entries = entriesWithText(source, decorations);

    assert.deepStrictEqual(
      entries
        .filter((entry) => entry.text === "count")
        .map((entry) => entry.colorIndex),
      [1, 1],
    );
    assert.deepStrictEqual(
      entries
        .filter((entry) => entry.text === "label")
        .map((entry) => entry.colorIndex),
      [1, 1],
    );
    assert.strictEqual(
      entries.find(
        (entry) =>
          entry.text === "user" && entry.start > source.indexOf("(user)"),
      )?.colorIndex,
      0,
    );
  });

  test("does not color property names as variable usages", () => {
    const source = `function run(item: { value: number }) {
	item.value = item.value + 1;
	const value = item.value;
	return value;
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "item"),
      [0, 0, 0, 0],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "value"),
      [1, 1],
    );
  });

  test("colors import bindings and their usages", () => {
    const source = `import React, { useMemo as memo, useState } from "react";
import * as path from "node:path";

const items = memo(() => useState(path.sep), []);
console.log(React, items);`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "React"),
      [0, 0],
    );
    assert.deepStrictEqual(namesWithColor(source, decorations, "memo"), [1, 1]);
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "useState"),
      [2, 2],
    );
    assert.deepStrictEqual(namesWithColor(source, decorations, "path"), [3, 3]);
  });

  test("colors imported type used in interface extends clause", () => {
    const source = `import { RainbowAnalysisOptions } from "./highlighter";

interface RainbowConfiguration extends RainbowAnalysisOptions {
	readonly enabled: boolean;
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "RainbowAnalysisOptions"),
      [0, 0],
    );
  });

  test("colors imported component names inside JSX tags", () => {
    const source = `import { ControlHelper } from "./ControlHelper";

const View = () => <ControlHelper value={1} />;
console.log(ControlHelper);`;
    const decorations = collectRainbowDecorations(
      source,
      "typescriptreact",
      "sample.tsx",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "ControlHelper"),
      [0, 0, 0],
    );
  });

  test("colors type member declarations and matching property access usages", () => {
    const source = `interface Profile {
  fullName: string;
  accountId: string;
}

function run(profile: Profile) {
  const value = profile.fullName;
  return profile.accountId + value.length;
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "fullName"),
      [0, 0],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "accountId"),
      [1, 1],
    );
    assert.deepStrictEqual(namesWithColor(source, decorations, "Profile"), []);
  });

  test("colors class field declarations and matching property access usages", () => {
    const source = `class Settings {
	private enabled = true;
	private palette = ["red"];

	public isReady() {
		return this.enabled && this.palette.length > 0;
	}
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "enabled"),
      [0, 0],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "palette"),
      [1, 1],
    );
  });

  test("colors only local import names, not imported source names", () => {
    const source = `import { readFile as read, writeFile } from "node:fs/promises";

function run(path: string) {
	return read(path).then(() => writeFile(path, "ok"));
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(namesWithColor(source, decorations, "read"), [0, 0]);
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "writeFile"),
      [1, 1],
    );
    assert.deepStrictEqual(namesWithColor(source, decorations, "readFile"), []);
  });

  test("colors import-equals local name and namespace import usages", () => {
    const source = `import fs = require("node:fs");
import * as path from "node:path";

const sep = path.sep;
console.log(fs.existsSync(path.join("a", "b")), sep);`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(namesWithColor(source, decorations, "fs"), [0, 0]);
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "path"),
      [1, 1, 1],
    );
  });

  test("keeps JSX attribute names uncolored while coloring component usage", () => {
    const source = `import { Button } from "./Button";

const View = () => <Button label="Save" value={1} />;
console.log(Button);`;
    const decorations = collectRainbowDecorations(
      source,
      "typescriptreact",
      "sample.tsx",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "Button"),
      [0, 0, 0],
    );
    assert.deepStrictEqual(namesWithColor(source, decorations, "label"), []);
    assert.deepStrictEqual(namesWithColor(source, decorations, "value"), []);
  });

  test("keeps labels and control-flow labels uncolored", () => {
    const source = `function run(flag: boolean) {
	loop: for (let i = 0; i < 3; i += 1) {
		if (flag) {
			continue loop;
		}
		break loop;
	}
}`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(namesWithColor(source, decorations, "loop"), []);
    assert.deepStrictEqual(namesWithColor(source, decorations, "i"), [1, 1, 1]);
    assert.deepStrictEqual(namesWithColor(source, decorations, "flag"), [0, 0]);
  });

  test("keeps exported alias names uncolored", () => {
    const source = `const localValue = 1;
export { localValue as exportedValue };
console.log(localValue);`;
    const decorations = collectRainbowDecorations(
      source,
      "typescript",
      "sample.ts",
      options,
    );

    assert.deepStrictEqual(
      namesWithColor(source, decorations, "exportedValue"),
      [],
    );
    assert.deepStrictEqual(
      namesWithColor(source, decorations, "localValue"),
      [],
    );
  });
});

function namesWithColor(
  source: string,
  decorations: readonly RainbowDecoration[],
  name: string,
): number[] {
  return entriesWithText(source, decorations)
    .filter((entry) => entry.text === name)
    .map((entry) => entry.colorIndex);
}

function entriesWithText(
  source: string,
  decorations: readonly RainbowDecoration[],
): Array<RainbowDecoration & { text: string }> {
  return decorations.map((decoration) => ({
    ...decoration,
    text: source.slice(decoration.start, decoration.end),
  }));
}
